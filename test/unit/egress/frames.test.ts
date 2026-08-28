import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { createCloudEvent } from "../../../src/events/index.js";
import type { CloudEvent } from "../../../src/events/types.js";
import { SseReader } from "../../support/sse-reader.js";

function makeEvent(opts: { id: string; type: string; source: string; subject?: string; body?: unknown }): CloudEvent {
  return createCloudEvent({
    id: opts.id,
    source: opts.source,
    type: opts.type,
    time: "2026-08-28T00:00:00Z",
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    raw: { body: opts.body ?? { a: 1 }, headers: {} },
  });
}

function connect(app: { handle: (req: Request) => Promise<Response> }, path: string, headers: Record<string, string> = {}) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { authorization: "Bearer t1", ...headers } }));
}

describe("egress frame format", () => {
  test("first frame is the retry hint, then the golden event frame, byte for byte", async () => {
    const store = open(":memory:");
    const event = makeEvent({ id: "e1", source: "//github/x", type: "com.github.pull_request.opened" });
    const { seq } = store.append(event);
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });

    const res = await connect(app, "/events?from=earliest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = new SseReader(res);
    expect(await reader.nextRaw()).toBe("retry: 3000");
    const stored = store.read({ from: seq, limit: 1 })[0]!;
    expect(await reader.nextRaw()).toBe(
      `event: com.github.pull_request.opened\nid: ${seq}\ndata: ${JSON.stringify(stored.event)}`,
    );
    await reader.cancel();
  });

  test("data: line is JSON.stringify(event) on a single line, no seq attribute in the payload", async () => {
    const store = open(":memory:");
    store.append(makeEvent({ id: "e1", source: "//github/x", type: "com.github.pull_request.opened" }));
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app, "/events?from=earliest");
    const reader = new SseReader(res);
    await reader.nextRaw();
    const eventFrame = await reader.nextRaw();
    const dataLine = eventFrame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(dataLine.includes("\n")).toBe(false);
    const parsed = JSON.parse(dataLine.slice("data: ".length));
    expect(parsed.seq).toBeUndefined();
    expect(parsed.id).toBe("e1");
    await reader.cancel();
  });

  test("?type= is a prefix match, underscore literal, not a substring/suffix match", async () => {
    const store = open(":memory:");
    store.append(makeEvent({ id: "1", source: "//x/a", type: "com.acme_corp.thing" }));
    store.append(makeEvent({ id: "2", source: "//x/a", type: "com.acmexcorp.thing" })); // underscore replaced by literal char
    store.append(makeEvent({ id: "3", source: "//x/a", type: "com.other.pull_request.opened" })); // filter below is a mid-string substring of this one

    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });

    const res = await connect(app, `/events?from=earliest&${new URLSearchParams({ type: "com.acme_corp" })}`);
    const reader = new SseReader(res);
    await reader.nextRaw(); // retry
    const frame = await reader.nextRaw();
    expect(frame).toContain("event: com.acme_corp.thing");
    await expect(reader.nextRaw(100)).rejects.toThrow(); // no second match: underscore was literal, not a wildcard
    await reader.cancel();

    const res2 = await connect(app, `/events?from=earliest&${new URLSearchParams({ type: "pull_request" })}`);
    const reader2 = new SseReader(res2);
    await reader2.nextRaw(); // retry
    await expect(reader2.nextRaw(100)).rejects.toThrow(); // "pull_request" is not a prefix of "com.other.pull_request.opened"
    await reader2.cancel();
  });

  test("source and subject filters are exact match, ANDed with type", async () => {
    const store = open(":memory:");
    store.append(makeEvent({ id: "1", source: "//github/a", type: "com.github.issue.updated", subject: "KAN-1" }));
    store.append(makeEvent({ id: "2", source: "//github/b", type: "com.github.issue.updated", subject: "KAN-1" }));
    store.append(makeEvent({ id: "3", source: "//github/a", type: "com.github.issue.updated", subject: "KAN-2" }));

    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const qs = new URLSearchParams({ source: "//github/a", subject: "KAN-1" });
    const res = await connect(app, `/events?from=earliest&${qs}`);
    const reader = new SseReader(res);
    await reader.nextRaw();
    const frame = await reader.nextRaw();
    expect(frame).toContain('"id":"1"');
    await expect(reader.nextRaw(100)).rejects.toThrow();
    await reader.cancel();
  });

  test("filters apply identically to live events as to backfill", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "t1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app, `/events?${new URLSearchParams({ type: "com.github.issue" })}`);
    const reader = new SseReader(res);
    await reader.nextRaw(); // retry

    store.append(makeEvent({ id: "skip", source: "//x/a", type: "com.github.pull_request.opened" }));
    const { seq } = store.append(makeEvent({ id: "keep", source: "//x/a", type: "com.github.issue.updated" }));
    const frame = await reader.nextRaw();
    expect(frame).toContain(`id: ${seq}`);
    expect(frame).toContain('"id":"keep"');
    await reader.cancel();
  });
});
