import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open, type Store } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { createCloudEvent } from "../../../src/events/index.js";
import { SseReader } from "../../support/sse-reader.js";

/**
 * Wraps a store so unsubscribe() is a no-op. This holds a subscriber in the
 * store's live set even after its SSE connection has torn down, reproducing
 * the case egress's cleanup() can lag behind: the connection's underlying
 * ReadableStream controller is already closed, but store.append still tries
 * to reach it because the subscription itself hasn't been removed yet.
 */
function withStickySubscribers(store: Store): Store {
  return {
    ...store,
    subscribe(fn) {
      store.subscribe(fn);
      return () => {};
    },
  };
}

function makeEvent(id: string) {
  return createCloudEvent({
    id,
    source: "//dead-subscriber/test",
    type: "com.dead-subscriber.thing",
    time: new Date().toISOString(),
    raw: { body: { id }, headers: {} },
  });
}

describe("egress: a dead live subscriber must not break store.append or later subscribers", () => {
  test("a subscriber whose controller is already closed is swallowed, and a healthy subscriber still receives the event", async () => {
    const realStore = open(":memory:");
    const store = withStickySubscribers(realStore);
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1" });
    const app = buildApp({ config, store, adapters: [] });

    // Connection 1: opened, then torn down for real — its ReadableStream controller
    // becomes genuinely closed. Because of the sticky wrapper, its subscribe
    // callback stays registered in the store's live set anyway.
    const res1 = await app.handle(new Request("http://localhost/events", { headers: { authorization: "Bearer t1" } }));
    const reader1 = new SseReader(res1);
    expect(await reader1.nextRaw()).toBe("retry: 3000");
    await reader1.cancel();

    // Connection 2: stays open and healthy.
    const res2 = await app.handle(new Request("http://localhost/events", { headers: { authorization: "Bearer t1" } }));
    const reader2 = new SseReader(res2);
    expect(await reader2.nextRaw()).toBe("retry: 3000");

    const event = makeEvent("after-disconnect");
    expect(() => realStore.append(event)).not.toThrow();

    const frame = await reader2.nextRaw();
    expect(frame).toBe(`event: com.dead-subscriber.thing\nid: 1\ndata: ${JSON.stringify(event)}`);

    await reader2.cancel();
  });
});
