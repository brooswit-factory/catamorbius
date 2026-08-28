import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { createCloudEvent } from "../../../src/events/index.js";
import { SseReader } from "../../support/sse-reader.js";

function makeEvent(id: string) {
  return createCloudEvent({ id, source: "//x/a", type: "com.x.thing", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} } });
}

function buildTestApp(store: ReturnType<typeof open>) {
  const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
  return buildApp({ config, store, adapters: [] });
}

function connect(app: { handle: (req: Request) => Promise<Response> }, path: string, headers: Record<string, string> = {}) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { authorization: "Bearer t1", ...headers } }));
}

describe("egress cursor precedence", () => {
  test("neither Last-Event-ID nor ?from -> live only, no backfill", async () => {
    const store = open(":memory:");
    store.append(makeEvent("old"));
    const app = buildTestApp(store);
    const res = await connect(app, "/events");
    const reader = new SseReader(res);
    expect(await reader.nextRaw()).toBe("retry: 3000");
    await expect(reader.nextRaw(100)).rejects.toThrow();

    const { seq } = store.append(makeEvent("new"));
    const frame = await reader.nextRaw();
    expect(frame).toContain(`id: ${seq}`);
    await reader.cancel();
  });

  test("?from=earliest replays everything from seq 1", async () => {
    const store = open(":memory:");
    store.append(makeEvent("a"));
    store.append(makeEvent("b"));
    const app = buildTestApp(store);
    const res = await connect(app, "/events?from=earliest");
    const reader = new SseReader(res);
    await reader.nextRaw();
    expect(await reader.nextRaw()).toContain("id: 1");
    expect(await reader.nextRaw()).toContain("id: 2");
    await reader.cancel();
  });

  test("?from=N replays seq >= N inclusive", async () => {
    const store = open(":memory:");
    store.append(makeEvent("a"));
    const { seq: seqB } = store.append(makeEvent("b"));
    store.append(makeEvent("c"));
    const app = buildTestApp(store);
    const res = await connect(app, `/events?from=${seqB}`);
    const reader = new SseReader(res);
    await reader.nextRaw();
    expect(await reader.nextRaw()).toContain(`id: ${seqB}`);
    expect(await reader.nextRaw()).toContain("id: 3");
    await reader.cancel();
  });

  test("Last-Event-ID replays seq > N (exclusive)", async () => {
    const store = open(":memory:");
    const { seq: seqA } = store.append(makeEvent("a"));
    store.append(makeEvent("b"));
    const app = buildTestApp(store);
    const res = await connect(app, "/events", { "last-event-id": String(seqA) });
    const reader = new SseReader(res);
    await reader.nextRaw();
    expect(await reader.nextRaw()).toContain("id: 2");
    await expect(reader.nextRaw(100)).rejects.toThrow();
    await reader.cancel();
  });

  test("both present -> Last-Event-ID wins over ?from", async () => {
    const store = open(":memory:");
    const { seq: seqA } = store.append(makeEvent("a"));
    store.append(makeEvent("b"));
    const app = buildTestApp(store);
    // ?from=earliest would replay everything; the header must win and replay only seq > seqA.
    const res = await connect(app, "/events?from=earliest", { "last-event-id": String(seqA) });
    const reader = new SseReader(res);
    await reader.nextRaw();
    expect(await reader.nextRaw()).toContain("id: 2");
    await expect(reader.nextRaw(100)).rejects.toThrow();
    await reader.cancel();
  });

  test("a cursor beyond latestSeq -> live only, no error", async () => {
    const store = open(":memory:");
    store.append(makeEvent("a"));
    const app = buildTestApp(store);
    const res = await connect(app, "/events?from=999");
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    await reader.nextRaw();
    await expect(reader.nextRaw(100)).rejects.toThrow();

    const { seq } = store.append(makeEvent("new"));
    expect(await reader.nextRaw()).toContain(`id: ${seq}`);
    await reader.cancel();
  });

  describe("400 on a malformed cursor", () => {
    test.each([
      ["?from non-numeric", "/events?from=abc"],
      ["?from negative", "/events?from=-1"],
      ["?from decimal", "/events?from=1.5"],
    ])("%s", async (_name, path) => {
      const store = open(":memory:");
      const app = buildTestApp(store);
      const res = await connect(app, path);
      expect(res.status).toBe(400);
    });

    test("Last-Event-ID non-numeric -> 400", async () => {
      const store = open(":memory:");
      const app = buildTestApp(store);
      const res = await connect(app, "/events", { "last-event-id": "abc" });
      expect(res.status).toBe(400);
    });

    test("Last-Event-ID negative -> 400", async () => {
      const store = open(":memory:");
      const app = buildTestApp(store);
      const res = await connect(app, "/events", { "last-event-id": "-1" });
      expect(res.status).toBe(400);
    });

    test("an invalid Last-Event-ID still wins (400) even when ?from is valid", async () => {
      const store = open(":memory:");
      const app = buildTestApp(store);
      const res = await connect(app, "/events?from=earliest", { "last-event-id": "not-a-number" });
      expect(res.status).toBe(400);
    });
  });
});
