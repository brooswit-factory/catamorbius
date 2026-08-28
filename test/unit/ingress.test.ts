import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { buildIngress } from "../../src/ingress/index.js";
import { open } from "../../src/store/index.js";
import { loadConfig } from "../../src/config.js";
import { createCloudEvent } from "../../src/events/index.js";
import type { CloudEvent } from "../../src/events/types.js";
import { createFakeAdapter, type FakeAdapterOptions } from "../support/fake-adapter.js";

function makeApp(adapterOpts: FakeAdapterOptions = {}, envOverrides: Record<string, string> = {}) {
  const store = open(":memory:");
  const config = loadConfig(envOverrides);
  const adapter = createFakeAdapter(adapterOpts);
  const app = new Elysia().use(buildIngress({ config, store, adapters: [adapter] }));
  return { app, store };
}

function post(
  app: { handle: (req: Request) => Promise<Response> },
  provider: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return app.handle(
    new Request(`http://localhost/webhooks/${provider}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

describe("ingress", () => {
  test("unknown provider -> 404", async () => {
    const { app } = makeApp();
    const res = await post(app, "nope", "{}");
    expect(res.status).toBe(404);
  });

  test("verify ok -> 202, one delivery stores one event", async () => {
    const { app, store } = makeApp({ verifyResult: { ok: true } }, { WEBHOOK_SECRET_FAKE: "s3cr3t" });
    const res = await post(app, "fake", JSON.stringify({ id: "e1" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { events: Array<{ seq: number; duplicate: boolean }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.duplicate).toBe(false);
    expect(store.latestSeq()).toBe(1);
  });

  test("verify fail -> 401, nothing stored", async () => {
    const { app, store } = makeApp(
      { verifyResult: { ok: false, reason: "bad signature" } },
      { WEBHOOK_SECRET_FAKE: "s3cr3t" },
    );
    const res = await post(app, "fake", "{}");
    expect(res.status).toBe(401);
    expect(store.latestSeq()).toBe(0);
  });

  test("one delivery -> multiple events", async () => {
    const events = [
      createCloudEvent({ id: "a", source: "//fake/x", type: "fake.a", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} } }),
      createCloudEvent({ id: "b", source: "//fake/x", type: "fake.b", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} } }),
    ];
    const { app, store } = makeApp(
      { verifyResult: { ok: true }, toEvents: () => events },
      { WEBHOOK_SECRET_FAKE: "s" },
    );
    const res = await post(app, "fake", "{}");
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(2);
    expect(store.latestSeq()).toBe(2);
  });

  test("adapter throws -> <provider>.unknown with raw body + headers intact", async () => {
    const { app, store } = makeApp(
      { verifyResult: { ok: true }, toEvents: () => { throw new Error("boom"); } },
      { WEBHOOK_SECRET_FAKE: "s" },
    );
    const res = await post(app, "fake", '{"weird":true}', { "x-test": "1" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events[0]!.type).toBe("fake.unknown");
    const rows = store.read();
    expect(rows[0]!.event.data.raw.body).toEqual({ weird: true });
    expect(rows[0]!.event.data.raw.headers["x-test"]).toBe("1");
    expect(rows[0]!.event.source).toBe("//fake/unknown");
  });

  test("malformed body that passes verification is still stored as <provider>.unknown", async () => {
    const { app, store } = makeApp(
      { verifyResult: { ok: true }, toEvents: () => { throw new Error("parse error"); } },
      { WEBHOOK_SECRET_FAKE: "s" },
    );
    const res = await post(app, "fake", "not json{{{");
    expect(res.status).toBe(202);
    const rows = store.read();
    expect(rows[0]!.event.type).toBe("fake.unknown");
    expect(rows[0]!.event.data.raw.body).toBe("not json{{{");
  });

  test("adapter returns a non-conforming envelope -> stored as <provider>.unknown, no throw", async () => {
    const malformed = { specversion: "1.0", id: "", source: "", type: "", time: "" } as unknown as CloudEvent;
    const { app, store } = makeApp(
      { verifyResult: { ok: true }, toEvents: () => [malformed] },
      { WEBHOOK_SECRET_FAKE: "s" },
    );
    const res = await post(app, "fake", JSON.stringify({ ok: 1 }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events[0]!.type).toBe("fake.unknown");
    const rows = store.read();
    expect(rows[0]!.event.type).toBe("fake.unknown");
  });

  test("the same id delivered twice -> one row; second response is duplicate with the same seq", async () => {
    const fixedEvent = createCloudEvent({
      id: "dup-1", source: "//fake/x", type: "fake.a", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} },
    });
    const { app, store } = makeApp(
      { verifyResult: { ok: true }, toEvents: () => [fixedEvent] },
      { WEBHOOK_SECRET_FAKE: "s" },
    );
    const r1 = await post(app, "fake", "{}");
    const b1 = (await r1.json()) as { events: Array<{ seq: number; duplicate: boolean }> };
    const r2 = await post(app, "fake", "{}");
    const b2 = (await r2.json()) as { events: Array<{ seq: number; duplicate: boolean }> };

    expect(r2.status).toBe(202);
    expect(b1.events[0]!.duplicate).toBe(false);
    expect(b2.events[0]!.duplicate).toBe(true);
    expect(b2.events[0]!.seq).toBe(b1.events[0]!.seq);
    expect(store.latestSeq()).toBe(1);
  });

  test("missing secret, default config -> 503, nothing stored", async () => {
    const { app, store } = makeApp({ verifyResult: { ok: true } }, {});
    const res = await post(app, "fake", "{}");
    expect(res.status).toBe(503);
    expect(store.latestSeq()).toBe(0);
  });

  test("missing secret + CATAMORBIUS_DEV_MODE=1 -> stored, WARN logged", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const { app, store } = makeApp({ verifyResult: { ok: true } }, { CATAMORBIUS_DEV_MODE: "1" });
      const res = await post(app, "fake", JSON.stringify({ id: "e1" }));
      expect(res.status).toBe(202);
      expect(store.latestSeq()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WEBHOOK_SECRET_FAKE/);
    } finally {
      console.warn = original;
    }
  });

  test("duplicate deliveries still get 202 (providers stop redelivering only on 2xx)", async () => {
    const fixedEvent = createCloudEvent({
      id: "dup-2", source: "//fake/x", type: "fake.a", time: "2026-08-28T00:00:00Z", raw: { body: {}, headers: {} },
    });
    const { app } = makeApp({ verifyResult: { ok: true }, toEvents: () => [fixedEvent] }, { WEBHOOK_SECRET_FAKE: "s" });
    await post(app, "fake", "{}");
    const res = await post(app, "fake", "{}");
    expect(res.status).toBe(202);
  });
});
