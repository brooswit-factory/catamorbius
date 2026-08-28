import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { SseReader } from "../../support/sse-reader.js";
import { withSubscriberCount } from "../../support/counting-store.js";

describe("egress heartbeat", () => {
  test("emits a heartbeat comment at the configured interval", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "50" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await app.handle(new Request("http://localhost/events", { headers: { authorization: "Bearer t1" } }));
    const reader = new SseReader(res);
    expect(await reader.nextRaw()).toBe("retry: 3000");
    expect(await reader.nextRaw(1000)).toBe(": heartbeat");
    expect(await reader.nextRaw(1000)).toBe(": heartbeat");
    await reader.cancel();
  });
});

describe("egress cleanup on disconnect", () => {
  test("disconnect unsubscribes from the store and clears the heartbeat timer", async () => {
    const store = open(":memory:");
    const countingStore = withSubscriberCount(store);
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "50" });
    const app = buildApp({ config, store: countingStore, adapters: [] });

    const setIntervalIds: number[] = [];
    const clearedIds: number[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    // @ts-expect-error narrowed test spy, return type intentionally widened
    globalThis.setInterval = (fn: TimerHandler, ms?: number) => {
      const id = originalSetInterval(fn as never, ms);
      setIntervalIds.push(id as unknown as number);
      return id;
    };
    // @ts-expect-error narrowed test spy
    globalThis.clearInterval = (id?: number) => {
      clearedIds.push(id as unknown as number);
      return originalClearInterval(id as never);
    };

    try {
      const controller = new AbortController();
      const res = await app.handle(
        new Request("http://localhost/events", { headers: { authorization: "Bearer t1" }, signal: controller.signal }),
      );
      const reader = new SseReader(res);
      expect(await reader.nextRaw()).toBe("retry: 3000");
      expect(countingStore.subscriberCount()).toBe(1);
      expect(setIntervalIds).toHaveLength(1);

      controller.abort();
      await new Promise((r) => setTimeout(r, 10));

      expect(countingStore.subscriberCount()).toBe(0);
      expect(clearedIds).toEqual(setIntervalIds);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("cancelling the stream reader also unsubscribes and clears the timer", async () => {
    const store = open(":memory:");
    const countingStore = withSubscriberCount(store);
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "50" });
    const app = buildApp({ config, store: countingStore, adapters: [] });

    const res = await app.handle(new Request("http://localhost/events", { headers: { authorization: "Bearer t1" } }));
    const reader = new SseReader(res);
    await reader.nextRaw();
    expect(countingStore.subscriberCount()).toBe(1);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(countingStore.subscriberCount()).toBe(0);
  });
});
