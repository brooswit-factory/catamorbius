import { describe, expect, test } from "bun:test";
import { start } from "../../src/index.js";

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
