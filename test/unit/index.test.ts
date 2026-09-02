import { describe, expect, test } from "bun:test";
import { buildApp, start } from "../../src/index.js";

describe("entrypoint", () => {
  test("start() with no other env vars binds and serves /healthz", async () => {
    const saved = process.env.CATAMORBIUS_DB;
    process.env.CATAMORBIUS_DB = ":memory:";
    try {
      const instance = start(0);
      const port = instance.server!.port;
      try {
        const res = await fetch(`http://localhost:${port}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, seq: 0 });
      } finally {
        instance.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.CATAMORBIUS_DB;
      else process.env.CATAMORBIUS_DB = saved;
    }
  });

  test("start() with no HOST binds exactly like the bare-port call it replaces (today's default, unchanged)", async () => {
    const saved = process.env.CATAMORBIUS_DB;
    process.env.CATAMORBIUS_DB = ":memory:";
    try {
      const baseline = buildApp().listen(0);
      const instance = start(0, undefined);
      try {
        expect(instance.server!.hostname).toBe(baseline.server!.hostname);
      } finally {
        instance.stop();
        baseline.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.CATAMORBIUS_DB;
      else process.env.CATAMORBIUS_DB = saved;
    }
  });

  test("start() with a HOST binds only that interface", async () => {
    const saved = process.env.CATAMORBIUS_DB;
    process.env.CATAMORBIUS_DB = ":memory:";
    try {
      const instance = start(0, "127.0.0.1");
      try {
        expect(instance.server!.hostname).toBe("127.0.0.1");
        const port = instance.server!.port;
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(res.status).toBe(200);
      } finally {
        instance.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.CATAMORBIUS_DB;
      else process.env.CATAMORBIUS_DB = saved;
    }
  });

  test("POST /webhooks/nope on the real app -> 404", async () => {
    const saved = process.env.CATAMORBIUS_DB;
    process.env.CATAMORBIUS_DB = ":memory:";
    try {
      const instance = start(0);
      const port = instance.server!.port;
      try {
        const res = await fetch(`http://localhost:${port}/webhooks/nope`, { method: "POST", body: "{}" });
        expect(res.status).toBe(404);
      } finally {
        instance.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.CATAMORBIUS_DB;
      else process.env.CATAMORBIUS_DB = saved;
    }
  });
});
