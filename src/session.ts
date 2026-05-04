// SessionStore — owns the on-disk session workspace and mediates writeLib /
// storage / transcript writes from the sandbox.
//
// Layout (§14a):
//   .rex/sessions/<id>/
//     lib.ts            ← agent-authored module, fully replaced via writeLib
//     storage.json      ← KV store, accessed via RPC (size-capped)
//     transcript.jsonl  ← append-only event log (for resume + audit)
//     .lock             ← single-writer guard
//
// The store is created via `SessionStore.open(...)` which:
//   1. Generates / accepts a sessionId (ephemeral when omitted).
//   2. Creates the dir + bootstrap files if missing.
//   3. Acquires the .lock (rejects with SessionLockedError if held).
//
// On `close()` it releases the lock and (for ephemeral sessions) deletes
// the workspace.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { ModuleGuard } from "./module_guard.ts";
import { SessionLockedError, type SizeCaps, WriteLibError } from "./types.ts";
import ts from "typescript";

const enc = new TextEncoder();

export interface OpenOptions {
  /** Persistent session id. Omit to generate ephemeral. */
  sessionId?: string;
  /** Where `sessions/<id>/` lives. Default: `<cwd>/.rex`. */
  rootDir?: string;
  sizeCaps: SizeCaps;
}

export class SessionStore {
  readonly sessionId: string;
  readonly dir: string;
  readonly libPath: string;
  readonly storagePath: string;
  readonly transcriptPath: string;
  readonly #lockPath: string;
  readonly #ephemeral: boolean;
  readonly #caps: SizeCaps;
  #closed = false;
  /** In-memory copy of storage.json. Single-writer (lock guarantees it). */
  #storage: Record<string, unknown> = {};

  private constructor(args: {
    sessionId: string;
    dir: string;
    ephemeral: boolean;
    caps: SizeCaps;
  }) {
    this.sessionId = args.sessionId;
    this.dir = args.dir;
    this.libPath = join(args.dir, "lib.ts");
    this.storagePath = join(args.dir, "storage.json");
    this.transcriptPath = join(args.dir, "transcript.jsonl");
    this.#lockPath = join(args.dir, ".lock");
    this.#ephemeral = args.ephemeral;
    this.#caps = args.caps;
  }

  static async open(opts: OpenOptions): Promise<SessionStore> {
    const ephemeral = opts.sessionId === undefined;
    const sessionId = opts.sessionId ?? generateEphemeralId();
    const root = opts.rootDir ?? join(Deno.cwd(), ".rex");
    const dir = join(root, "sessions", sessionId);

    await ensureDir(dir);

    const store = new SessionStore({
      sessionId,
      dir,
      ephemeral,
      caps: opts.sizeCaps,
    });

    await store.#acquireLock();
    try {
      await store.#bootstrap();
    } catch (e) {
      await store.#releaseLock();
      throw e;
    }
    return store;
  }

  // ── lib.ts ──────────────────────────────────────────────────────────────

  /** Current `lib.ts` source. */
  async readLib(): Promise<string> {
    return await Deno.readTextFile(this.libPath);
  }

  /**
   * Extract names of named exports from the current lib via TS AST.
   * Best-effort: only top-level `export const/function/class/let/var/enum`
   * and `export { a, b }` are surfaced. `export * from "..."` is ignored
   * (we'd need to load the target to know what it re-exports).
   */
  async libExports(): Promise<string[]> {
    const src = await this.readLib();
    const sf = ts.createSourceFile("lib.ts", src, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    const names: string[] = [];
    for (const stmt of sf.statements) {
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      const isExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExport) continue;

      if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
        if (stmt.name) names.push(stmt.name.text);
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.push(d.name.text);
          // Ignore destructured exports — rare in agent-authored code.
        }
      } else if (ts.isEnumDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
        names.push(stmt.name.text);
      }
    }
    // `export { a, b }` (without modifiers on a declaration).
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          names.push(el.name.text);
        }
      }
    }
    // Dedupe preserving order.
    const seen = new Set<string>();
    return names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  }

  /**
   * Replace `lib.ts` with `source`. Validates via ModuleGuard against
   * `allowedModules` (the same allowlist as the current step). Throws
   * WriteLibError on cap or guard failure; file is not modified on failure.
   */
  async writeLib(source: string, allowedModules: string[]): Promise<void> {
    const size = enc.encode(source).length;
    if (size > this.#caps.libBytes) {
      throw new WriteLibError(
        `lib source too large: ${size} bytes (cap ${this.#caps.libBytes})`,
      );
    }
    const guard = ModuleGuard.scan({
      source,
      allowed: allowedModules,
      filename: "lib.ts",
    });
    if (!guard.ok) {
      throw new WriteLibError(`writeLib rejected: ${guard.reason}`);
    }
    // Atomic-ish: write to a tmp sibling then rename. Avoids a partial file
    // on power loss. Same dir → same filesystem → rename is atomic.
    const tmp = `${this.libPath}.tmp`;
    await Deno.writeTextFile(tmp, source);
    await Deno.rename(tmp, this.libPath);
  }

  // ── storage ─────────────────────────────────────────────────────────────

  storageGet(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.#storage, key) ? this.#storage[key] : undefined;
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("storage key must be a non-empty string");
    }
    // Round-trip through JSON to enforce serializability + match read shape.
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      throw new Error(
        `storage value for "${key}" is not JSON-serializable: ${(e as Error).message}`,
      );
    }
    if (json === undefined) {
      throw new Error(`storage value for "${key}" is not JSON-serializable`);
    }
    const next: Record<string, unknown> = { ...this.#storage, [key]: JSON.parse(json) };
    const total = enc.encode(JSON.stringify(next)).length;
    if (total > this.#caps.storageBytes) {
      throw new Error(
        `storage quota exceeded: ${total} bytes > cap ${this.#caps.storageBytes}`,
      );
    }
    this.#storage = next;
    await this.#flushStorage();
  }

  async storageDel(key: string): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(this.#storage, key)) return;
    const next = { ...this.#storage };
    delete next[key];
    this.#storage = next;
    await this.#flushStorage();
  }

  storageKeys(): string[] {
    return Object.keys(this.#storage);
  }

  // ── transcript ──────────────────────────────────────────────────────────

  async appendTranscript(event: unknown): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    await Deno.writeTextFile(this.transcriptPath, line, { append: true });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#releaseLock();
    if (this.#ephemeral) {
      try {
        await Deno.remove(this.dir, { recursive: true });
      } catch { /* best-effort cleanup */ }
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  async #bootstrap(): Promise<void> {
    // lib.ts: empty module (so `import {} from "session:lib"` always resolves).
    if (!(await fileExists(this.libPath))) {
      await Deno.writeTextFile(this.libPath, "export {};\n");
    }
    // storage.json: empty object.
    if (!(await fileExists(this.storagePath))) {
      await Deno.writeTextFile(this.storagePath, "{}\n");
      this.#storage = {};
    } else {
      try {
        const text = await Deno.readTextFile(this.storagePath);
        const parsed = text.trim() === "" ? {} : JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`storage.json is not a JSON object`);
        }
        this.#storage = parsed as Record<string, unknown>;
      } catch (e) {
        throw new Error(
          `failed to read storage.json for session ${this.sessionId}: ${(e as Error).message}`,
        );
      }
    }
    // transcript.jsonl: ensure file exists so append works without races.
    if (!(await fileExists(this.transcriptPath))) {
      await Deno.writeTextFile(this.transcriptPath, "");
    }
  }

  async #flushStorage(): Promise<void> {
    const tmp = `${this.storagePath}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.#storage, null, 2) + "\n");
    await Deno.rename(tmp, this.storagePath);
  }

  async #acquireLock(): Promise<void> {
    const myPid = Deno.pid;
    const payload = JSON.stringify({ pid: myPid, ts: Date.now() });
    while (true) {
      try {
        // O_CREAT | O_EXCL via createNew: true.
        const f = await Deno.open(this.#lockPath, { write: true, createNew: true });
        try {
          await f.write(enc.encode(payload));
        } finally {
          f.close();
        }
        return;
      } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
        // Stale lock check: read PID and see if it's still alive.
        const stalePid = await readLockPid(this.#lockPath);
        if (stalePid !== null && pidIsAlive(stalePid)) {
          throw new SessionLockedError(this.sessionId, stalePid);
        }
        // Stale → remove and retry. The retry handles the unlikely race
        // where two processes both find a stale lock at once.
        try {
          await Deno.remove(this.#lockPath);
        } catch (rmErr) {
          // Another process beat us to clearing it; loop will retry.
          if (!(rmErr instanceof Deno.errors.NotFound)) throw rmErr;
        }
      }
    }
  }

  async #releaseLock(): Promise<void> {
    try {
      await Deno.remove(this.#lockPath);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function readLockPid(path: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(path);
    const obj = JSON.parse(text);
    if (obj && typeof obj.pid === "number") return obj.pid;
    return null;
  } catch {
    return null;
  }
}

/** Best-effort liveness check via signal 0. Same-user processes only. */
function pidIsAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

function generateEphemeralId(): string {
  // 16 hex chars from crypto rng — collision-resistant for ephemeral use.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "eph-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
