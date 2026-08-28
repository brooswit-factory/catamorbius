import { describe, expect, test } from "bun:test";
import { app, start } from "../../src/index.js";

describe("catamorbius scaffold", () => {
  test("GET /healthz returns ok", async () => {
    const res = await app.handle(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("start() binds and serves", async () => {
    const instance = start(0);
    const port = instance.server!.port;
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      instance.stop();
    }
  });
});
