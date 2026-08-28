import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSource } from "eventsource";
import type { ErrorEvent } from "eventsource";
import { buildApp } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { open, type Store } from "../../src/store/index.js";
import { createCloudEvent } from "../../src/events/index.js";
import type { CloudEvent } from "../../src/events/types.js";
import { SseReader } from "../support/sse-reader.js";

// A throwaway token used only inside this test process — never a real secret.
const TEST_TOKEN = "live-test-throwaway-token";

const tempDirs: string[] = [];
const openEventSources: { close(): void }[] = [];

afterEach(() => {
  for (const es of openEventSources.splice(0)) es.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "catamorbius-live-"));
  tempDirs.push(dir);
  return join(dir, "events.sqlite");
}

function makeEvent(id: string, opts: { type?: string; source?: string; subject?: string } = {}): CloudEvent {
  return createCloudEvent({
    id,
    source: opts.source ?? "//live/test",
    type: opts.type ?? "com.live.thing",
    time: new Date().toISOString(),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    raw: { body: { id }, headers: {} },
  });
}

/** The bearer header eventsource's client can't set natively — the whole reason a custom `fetch` is required. */
function authedFetch(token: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })) as typeof fetch;
}

function startServer(dbPath: string, port = 0): { app: ReturnType<typeof buildApp>; store: Store; port: number } {
  const config = loadConfig({ CATAMORBIUS_DB: dbPath, CATAMORBIUS_TOKENS: TEST_TOKEN, CATAMORBIUS_HEARTBEAT_MS: "100" });
  const store = open(dbPath);
  const app = buildApp({ config, store, adapters: [] });
  app.listen(port);
  const boundPort = (app.server as { port: number }).port;
  return { app, store, port: boundPort };
}

/** Rebinding the exact freed port right after stop() can race the OS releasing it; retry briefly. */
async function startServerOnPort(dbPath: string, port: number, retries = 30): Promise<{ app: ReturnType<typeof buildApp>; store: Store; port: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return startServer(dbPath, port);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function trackEventSource(es: EventSource): EventSource {
  openEventSources.push(es);
  return es;
}

describe("live SSE egress (real EventSource client, real server)", () => {
  test("backfill from earliest delivers pre-existing events in order with identical payloads", async () => {
    const dbPath = tempDbPath();
    const { app, store, port } = startServer(dbPath);
    try {
      const seeded = [1, 2, 3, 4, 5].map((n) => makeEvent(`seed-${n}`));
      const seqs = seeded.map((e) => store.append(e).seq);

      const received: { type: string; id: string; data: CloudEvent }[] = [];
      const es = trackEventSource(new EventSource(`http://localhost:${port}/events?from=earliest`, { fetch: authedFetch(TEST_TOKEN) }));
      es.addEventListener("com.live.thing", (evt) => {
        received.push({ type: evt.type, id: evt.lastEventId, data: JSON.parse(evt.data) });
      });

      await waitFor(() => received.length >= 5, 10_000);

      expect(received.map((r) => r.id)).toEqual(seqs.map(String));
      expect(received.map((r) => r.data.id)).toEqual(seeded.map((e) => e.id));
      for (let i = 0; i < seeded.length; i++) {
        expect(received[i]!.type).toBe("com.live.thing");
        expect(received[i]!.data).toEqual(seeded[i]!);
      }
    } finally {
      await app.stop(true);
    }
  }, 20_000);

  test("resume proof: reconnect after a real disconnect replays only the missed events, no duplicates", async () => {
    const dbPath = tempDbPath();
    let server = startServer(dbPath);

    const received: { id: string; data: CloudEvent }[] = [];
    const es = trackEventSource(
      new EventSource(`http://localhost:${server.port}/events?from=earliest`, { fetch: authedFetch(TEST_TOKEN) }),
    );
    es.addEventListener("com.live.thing", (evt) => {
      received.push({ id: evt.lastEventId, data: JSON.parse(evt.data) });
    });

    try {
      const before = [1, 2].map((n) => makeEvent(`before-${n}`));
      for (const e of before) server.store.append(e);
      await waitFor(() => received.length >= 2, 10_000);
      expect(es.readyState).toBe(es.OPEN);

      // Drop the connection by killing the server, then append while the client is disconnected.
      await server.app.stop(true);
      const after = [1, 2, 3].map((n) => makeEvent(`after-${n}`));
      const afterSeqs = after.map((e) => server.store.append(e).seq);
      server.store.close();

      // Restart a real server on the SAME port against the SAME db file — the client must
      // auto-reconnect on its own (it honors the "retry: 3000" hint and resends Last-Event-ID).
      server = await startServerOnPort(dbPath, server.port);

      await waitFor(() => received.length >= 5, 15_000);

      const ids = received.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates
      expect(received.slice(0, 2).map((r) => r.data.id)).toEqual(before.map((e) => e.id)); // nothing re-delivered
      expect(received.slice(2).map((r) => r.data.id)).toEqual(after.map((e) => e.id)); // exactly the missed events
      expect(received.slice(2).map((r) => r.id)).toEqual(afterSeqs.map(String));
    } finally {
      await server.app.stop(true);
    }
  }, 30_000);

  test("a filtered subscription (?type=) receives only matching events", async () => {
    const dbPath = tempDbPath();
    const { app, store, port } = startServer(dbPath);
    try {
      const received: string[] = [];
      const es = trackEventSource(
        new EventSource(`http://localhost:${port}/events?from=earliest&type=${encodeURIComponent("com.live.wanted")}`, {
          fetch: authedFetch(TEST_TOKEN),
        }),
      );
      es.addEventListener("com.live.wanted", (evt) => {
        received.push(JSON.parse(evt.data).id);
      });
      es.addEventListener("com.live.unwanted", () => {
        throw new Error("filtered subscription received a non-matching event");
      });

      store.append(makeEvent("skip-1", { type: "com.live.unwanted" }));
      store.append(makeEvent("keep-1", { type: "com.live.wanted" }));
      store.append(makeEvent("skip-2", { type: "com.live.unwanted" }));
      store.append(makeEvent("keep-2", { type: "com.live.wanted" }));

      await waitFor(() => received.length >= 2, 10_000);
      expect(received).toEqual(["keep-1", "keep-2"]);
    } finally {
      await app.stop(true);
    }
  }, 20_000);

  test("a heartbeat comment is observed on the wire", async () => {
    const dbPath = tempDbPath();
    const { app, port } = startServer(dbPath);
    try {
      const res = await fetch(`http://localhost:${port}/events`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
      expect(res.status).toBe(200);
      const reader = new SseReader(res);
      expect(await reader.nextRaw()).toBe("retry: 3000");
      expect(await reader.nextRaw(2000)).toBe(": heartbeat");
      await reader.cancel();
    } finally {
      await app.stop(true);
    }
  }, 20_000);

  test("wrong token -> the client errors with 401 and does not reconnect", async () => {
    const dbPath = tempDbPath();
    const { app, port } = startServer(dbPath);
    try {
      const errors: ErrorEvent[] = [];
      const es = trackEventSource(
        new EventSource(`http://localhost:${port}/events`, { fetch: authedFetch("not-the-configured-token") }),
      );
      es.addEventListener("error", (err) => errors.push(err as ErrorEvent));

      await waitFor(() => errors.length >= 1, 10_000);
      expect(errors[0]!.code).toBe(401);
      expect(es.readyState).toBe(es.CLOSED); // a non-200 status fails the connection permanently, per spec
    } finally {
      await app.stop(true);
    }
  }, 20_000);
});
