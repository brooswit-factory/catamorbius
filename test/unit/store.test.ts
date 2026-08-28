import { describe, expect, test } from "bun:test";
import { open } from "../../src/store/index.js";
import { createCloudEvent } from "../../src/events/index.js";
import type { CloudEvent } from "../../src/events/types.js";

function ev(overrides: Partial<{ id: string; source: string; type: string; subject: string }> = {}): CloudEvent {
  return createCloudEvent({
    id: overrides.id ?? "1",
    source: overrides.source ?? "//test/instance",
    type: overrides.type ?? "com.test.thing.created",
    time: "2026-08-28T00:00:00Z",
    ...(overrides.subject !== undefined ? { subject: overrides.subject } : {}),
    raw: { body: { a: 1, nested: ["x", 2] }, headers: { "x-h": "1" } },
    summary: { actor: "bob" },
  });
}

describe("store", () => {
  test("append + exact round trip", () => {
    const store = open(":memory:");
    const e = ev({ subject: "KAN-1" });
    const { seq, duplicate } = store.append(e);
    expect(duplicate).toBe(false);
    expect(seq).toBe(1);
    const rows = store.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toEqual(e);
    store.close();
  });

  test("round trip preserves a non-JSON (string) raw body", () => {
    const store = open(":memory:");
    const e = createCloudEvent({
      id: "1",
      source: "//test/instance",
      type: "fake.unknown",
      time: "2026-08-28T00:00:00Z",
      raw: { body: "not json{{{", headers: {} },
    });
    store.append(e);
    expect(store.read()[0]!.event).toEqual(e);
  });

  test("dedupe by source+id: existing seq, no insert", () => {
    const store = open(":memory:");
    const e = ev();
    const r1 = store.append(e);
    const r2 = store.append(e);
    expect(r2.duplicate).toBe(true);
    expect(r2.seq).toBe(r1.seq);
    expect(store.latestSeq()).toBe(1);
    expect(store.read()).toHaveLength(1);
  });

  test("read filters: type prefix, source exact, subject exact", () => {
    const store = open(":memory:");
    store.append(ev({ id: "1", type: "com.a.x", source: "//s1", subject: "K-1" }));
    store.append(ev({ id: "2", type: "com.a.y", source: "//s1", subject: "K-2" }));
    store.append(ev({ id: "3", type: "com.b.z", source: "//s2", subject: "K-1" }));

    expect(store.read({ type: "com.a" })).toHaveLength(2);
    expect(store.read({ type: "com.b" })).toHaveLength(1);
    expect(store.read({ source: "//s1" })).toHaveLength(2);
    expect(store.read({ source: "//s2" })).toHaveLength(1);
    expect(store.read({ subject: "K-1" })).toHaveLength(2);
    expect(store.read({ subject: "K-2" })).toHaveLength(1);
  });

  test("type prefix is an exact character match, not a SQL LIKE pattern", () => {
    const store = open(":memory:");
    store.append(ev({ id: "1", type: "com.example.pull_request.opened", source: "//s1" }));
    store.append(ev({ id: "2", type: "com.example.pullXrequest.opened", source: "//s1" }));
    store.append(ev({ id: "3", type: "COM.EXAMPLE.other", source: "//s1" }));

    // `_` in the prefix must not act as a SQL LIKE single-char wildcard.
    expect(store.read({ type: "com.example.pull_request" }).map((r) => r.event.id)).toEqual(["1"]);
    // The match must be case-sensitive.
    expect(store.read({ type: "com.example" }).map((r) => r.event.id)).toEqual(["1", "2"]);
    // Control: an unrelated prefix matches nothing.
    expect(store.read({ type: "com.zzz" })).toHaveLength(0);
  });

  test("read paging: from/limit", () => {
    const store = open(":memory:");
    for (let i = 1; i <= 5; i++) store.append(ev({ id: String(i) }));
    const page = store.read({ from: 2, limit: 2 });
    expect(page.map((r) => r.seq)).toEqual([2, 3]);
    expect(store.read({ from: 4 }).map((r) => r.seq)).toEqual([4, 5]);
  });

  test("latestSeq starts at 0", () => {
    const store = open(":memory:");
    expect(store.latestSeq()).toBe(0);
    store.append(ev());
    expect(store.latestSeq()).toBe(1);
  });

  test("subscribe fan-out order; unsubscribe stops delivery; not fired on duplicate", () => {
    const store = open(":memory:");
    const calls: string[] = [];
    const unsub1 = store.subscribe((row) => calls.push(`1:${row.seq}`));
    store.subscribe((row) => calls.push(`2:${row.seq}`));

    const first = store.append(ev({ id: "1" }));
    store.append(ev({ id: "1" })); // duplicate — must not fire
    unsub1();
    const second = store.append(ev({ id: "2" }));

    // A duplicate is ignored at the row level but the AUTOINCREMENT column
    // still reserves a value for the attempt, so `second.seq` may skip one —
    // the cursor stays monotonically increasing, just not gapless.
    expect(first.seq).toBeLessThan(second.seq);
    expect(calls).toEqual([`1:${first.seq}`, `2:${first.seq}`, `2:${second.seq}`]);
  });
});
