import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server.js";
import { open } from "../../src/store/index.js";
import { loadConfig } from "../../src/config.js";
import { createFakeAdapter } from "../support/fake-adapter.js";

describe("server", () => {
  test("GET /healthz reports ok and the latest seq", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({}), store, adapters: [] });
    const res = await app.handle(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 0 });
  });

  test("healthz reflects seq after events are stored", async () => {
    const store = open(":memory:");
    const adapter = createFakeAdapter({ verifyResult: { ok: true } });
    const app = buildApp({ config: loadConfig({ WEBHOOK_SECRET_FAKE: "s" }), store, adapters: [adapter] });
    await app.handle(new Request("http://localhost/webhooks/fake", { method: "POST", body: JSON.stringify({ id: "1" }) }));
    const res = await app.handle(new Request("http://localhost/healthz"));
    expect(await res.json()).toEqual({ ok: true, seq: 1 });
  });

  test("mounts every registered adapter generically", async () => {
    const store = open(":memory:");
    const adapter = createFakeAdapter({ verifyResult: { ok: true } });
    const app = buildApp({ config: loadConfig({ WEBHOOK_SECRET_FAKE: "s" }), store, adapters: [adapter] });
    const res = await app.handle(
      new Request("http://localhost/webhooks/fake", { method: "POST", body: JSON.stringify({ id: "1" }) }),
    );
    expect(res.status).toBe(202);
  });

  test("POST to an unregistered provider -> 404", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({}), store, adapters: [] });
    const res = await app.handle(new Request("http://localhost/webhooks/nope", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
