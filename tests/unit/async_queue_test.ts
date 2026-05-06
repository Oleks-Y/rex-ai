// Unit tests for AsyncQueueInternal.pushAhead — proves the
// user-message-preempts-wakeup ordering deterministically (vs. the
// race-based integration test).

import { assertEquals } from "@std/assert";
import { AsyncQueueInternal } from "../../src/agent_session.ts";

Deno.test("pushAhead: empty inbox + parked consumer hands directly", async () => {
  const q = new AsyncQueueInternal<{ k: string }>();
  const p = q.next();
  q.pushAhead({ k: "user" }, () => true);
  const r = await p;
  assertEquals(r.done, false);
  if (!r.done) assertEquals(r.value, { k: "user" });
});

Deno.test("pushAhead: append when no match", async () => {
  const q = new AsyncQueueInternal<{ k: string }>();
  q.push({ k: "user_task" });
  q.pushAhead({ k: "user_message" }, (e) => e.k === "wakeup_fired");
  const a = await q.next();
  const b = await q.next();
  assertEquals((a.value as { k: string }).k, "user_task");
  assertEquals((b.value as { k: string }).k, "user_message");
});

Deno.test("pushAhead: splice ahead of first wakeup", async () => {
  const q = new AsyncQueueInternal<{ k: string }>();
  q.push({ k: "wakeup_fired" });
  q.pushAhead({ k: "user_message" }, (e) => e.k === "wakeup_fired");
  const a = await q.next();
  const b = await q.next();
  assertEquals((a.value as { k: string }).k, "user_message");
  assertEquals((b.value as { k: string }).k, "wakeup_fired");
});

Deno.test("pushAhead: splice past existing user items, ahead of FIRST wakeup", async () => {
  const q = new AsyncQueueInternal<{ k: string }>();
  q.push({ k: "user_task" });
  q.push({ k: "wakeup_fired" });
  q.push({ k: "wakeup_fired" });
  q.pushAhead({ k: "user_message" }, (e) => e.k === "wakeup_fired");
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await q.next();
    if (!r.done) out.push((r.value as { k: string }).k);
  }
  assertEquals(out, ["user_task", "user_message", "wakeup_fired", "wakeup_fired"]);
});

Deno.test("pushAhead: closed queue is no-op", () => {
  const q = new AsyncQueueInternal<{ k: string }>();
  q.close();
  q.pushAhead({ k: "user_message" }, () => true);
  // Don't await `next()` here — there's no consumer-facing way to
  // observe a no-op other than "queue is empty after close." The
  // `next()` of a closed empty queue resolves to done synchronously
  // (Promise.resolve), so awaiting that is the assertion.
  return q.next().then((r) => {
    assertEquals(r.done, true);
  });
});
