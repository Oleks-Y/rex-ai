// serveChat HTTP surface tests.
//
// Scope:
//   1. POST /session: when buildAgent throws UnauthorizedError, the response
//      is 401 with a JSON `{error}` body (NOT the generic 500).
//   2. CORS preflight (OPTIONS): a `cors` function that returns a specific
//      Origin must produce `access-control-allow-credentials: true` and
//      echo `vary: origin`. The default `*` form must NOT add credentials.
//
// Both paths avoid spinning a real Agent — buildAgent either throws or is
// never reached (preflight). That keeps the test pure-protocol and fast.

import { assertEquals } from "@std/assert";
import { serveChat, UnauthorizedError } from "../../src/web/server.ts";

Deno.test("serveChat — buildAgent throws UnauthorizedError → 401 JSON", async () => {
  const handler = serveChat({
    buildAgent: () => {
      throw new UnauthorizedError("invalid session");
    },
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialTask: "hi" }),
    }),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assertEquals(body, { error: "invalid session" });
});

Deno.test("serveChat — generic buildAgent error still returns 500", async () => {
  const handler = serveChat({
    buildAgent: () => {
      throw new Error("kaboom");
    },
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialTask: "hi" }),
    }),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "buildAgent failed: kaboom");
});

Deno.test("serveChat — cors function with explicit origin sets credentials + vary", async () => {
  const handler = serveChat({
    buildAgent: () => {
      throw new Error("not reached");
    },
    cors: (req) => req.headers.get("origin") ?? null,
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "https://app.example.com");
  assertEquals(res.headers.get("access-control-allow-credentials"), "true");
  assertEquals(res.headers.get("vary"), "origin");
  // authorization must be in allow-headers so the SDK can attach Bearer
  // on POST /session and POST /messages.
  const allowedHeaders = res.headers.get("access-control-allow-headers") ?? "";
  if (!allowedHeaders.toLowerCase().includes("authorization")) {
    throw new Error(`expected 'authorization' in allow-headers, got: ${allowedHeaders}`);
  }
});

Deno.test("serveChat — default cors='*' does NOT set credentials", async () => {
  const handler = serveChat({
    buildAgent: () => {
      throw new Error("not reached");
    },
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  // Critical: with `*`, browsers refuse credentials. Don't pretend.
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
  assertEquals(res.headers.get("vary"), null);
});

Deno.test("serveChat — cors function returning null omits CORS headers entirely", async () => {
  const handler = serveChat({
    buildAgent: () => {
      throw new Error("not reached");
    },
    cors: () => null,
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "OPTIONS",
      headers: { origin: "https://blocked.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});

Deno.test("serveChat — 401 response also carries CORS headers when credentialed", async () => {
  // If we forget CORS on the error path, the browser will surface a CORS
  // error and the SDK can't read the 401. Guard against that.
  const handler = serveChat({
    buildAgent: () => {
      throw new UnauthorizedError("no token");
    },
    cors: (req) => req.headers.get("origin") ?? null,
  });
  const res = await handler(
    new Request("http://test.local/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.com",
      },
      body: JSON.stringify({ initialTask: "hi" }),
    }),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("access-control-allow-origin"), "https://app.example.com");
  assertEquals(res.headers.get("access-control-allow-credentials"), "true");
});
