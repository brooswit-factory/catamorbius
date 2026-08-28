import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { createCloudEvent } from "../../../src/events/index.js";
import type { Store } from "../../../src/store/index.js";
import { SseReader } from "../../support/sse-reader.js";

function makeEvent(id: string) {
  return createCloudEvent({ id, source: "//x/a", type: "com.x.thing", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} } });
}

describe("egress backfill -> live boundary", () => {
  test("an event inserted right after the backfill page is read arrives exactly once via the buffered-live flush, not the backfill", async () => {
    const store = open(":memory:");
    const { seq: seqA } = store.append(makeEvent("a"));

    let injected = false;
    // Simulates the real race: subscribe() is active before this read() runs (per the required
    // ordering), so an insert landing between the backfill SELECT and the live switch must be
    // buffered and flushed afterward, not silently dropped or double-counted.
    const racingStore: Store = {
      ...store,
      read(query) {
        const page = store.read(query);
        if (!injected) {
          injected = true;
          store.append(makeEvent("mid-race"));
        }
        return page;
      },
    };

    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store: racingStore, adapters: [] });
    const res = await app.handle(
      new Request("http://localhost/events?from=earliest", { headers: { authorization: "Bearer t1" } }),
    );
    const reader = new SseReader(res);
    await reader.nextRaw(); // retry

    const first = await reader.nextRaw();
    expect(first).toContain(`id: ${seqA}`);
    expect(first).toContain('"id":"a"');

    const second = await reader.nextRaw();
    expect(second).toContain('"id":"mid-race"');

    await expect(reader.nextRaw(150)).rejects.toThrow(); // exactly once, no duplicate frame
    await reader.cancel();
  });

  test("an event inserted before the backfill SELECT runs is not re-emitted by the buffered flush", async () => {
    const store = open(":memory:");
    store.append(makeEvent("a"));

    let injected = false;
    const racingStore: Store = {
      ...store,
      read(query) {
        if (!injected) {
          injected = true;
          store.append(makeEvent("caught-by-backfill")); // lands before the SELECT executes
        }
        return store.read(query);
      },
    };

    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store: racingStore, adapters: [] });
    const res = await app.handle(
      new Request("http://localhost/events?from=earliest", { headers: { authorization: "Bearer t1" } }),
    );
    const reader = new SseReader(res);
    await reader.nextRaw(); // retry
    expect(await reader.nextRaw()).toContain('"id":"a"');
    expect(await reader.nextRaw()).toContain('"id":"caught-by-backfill"');
    await expect(reader.nextRaw(150)).rejects.toThrow(); // not duplicated by the buffered-flush step
    await reader.cancel();
  });

  test("backfill pages past the page-size boundary in strictly increasing seq order, no gaps or duplicates", async () => {
    const store = open(":memory:");
    const total = 501; // one more than the backfill page size
    for (let i = 0; i < total; i++) store.append(makeEvent(`e${i}`));

    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await app.handle(
      new Request("http://localhost/events?from=earliest", { headers: { authorization: "Bearer t1" } }),
    );
    const reader = new SseReader(res);
    await reader.nextRaw(); // retry

    const seqs: number[] = [];
    for (let i = 0; i < total; i++) {
      const frame = await reader.nextRaw(5000);
      const idLine = frame.split("\n").find((l) => l.startsWith("id: "))!;
      seqs.push(Number(idLine.slice("id: ".length)));
    }
    expect(seqs).toHaveLength(total);
    expect(new Set(seqs).size).toBe(total); // no duplicates
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!); // strictly increasing
    await reader.cancel();
  }, 15_000);
});
