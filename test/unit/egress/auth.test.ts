import { describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { SseReader } from "../../support/sse-reader.js";

function connect(app: { handle: (req: Request) => Promise<Response> }, headers: Record<string, string> = {}) {
  return app.handle(new Request("http://localhost/events", { headers }));
}

describe("egress auth matrix", () => {
  test("no tokens configured, default config -> 503, logs a line naming CATAMORBIUS_TOKENS", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      const store = open(":memory:");
      const app = buildApp({ config: loadConfig({}), store, adapters: [] });
      const res = await connect(app);
      expect(res.status).toBe(503);
      expect(errors.some((line) => line.includes("CATAMORBIUS_TOKENS"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test("no tokens configured, CATAMORBIUS_DEV_MODE=1 -> 200 open, loud WARN logged per connection", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const store = open(":memory:");
      const config = loadConfig({ CATAMORBIUS_DEV_MODE: "1", CATAMORBIUS_HEARTBEAT_MS: "60000" });
      const app = buildApp({ config, store, adapters: [] });
      const res = await connect(app);
      expect(res.status).toBe(200);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WARN/);
      expect(warnings[0]).toMatch(/CATAMORBIUS_TOKENS/);
      const reader = new SseReader(res);
      expect(await reader.nextRaw()).toBe("retry: 3000");
      await reader.cancel();
    } finally {
      console.warn = original;
    }
  });

  test("wrong token -> 401 with WWW-Authenticate: Bearer", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "right-token" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  test("missing Authorization header -> 401 with WWW-Authenticate: Bearer", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "right-token" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  test("right token -> 200", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "right-token", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app, { authorization: "Bearer right-token" });
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    expect(await reader.nextRaw()).toBe("retry: 3000");
    await reader.cancel();
  });

  test("matches any one of several configured tokens", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "a,b,c", CATAMORBIUS_HEARTBEAT_MS: "60000" });
    const app = buildApp({ config, store, adapters: [] });
    const res = await connect(app, { authorization: "Bearer b" });
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    await reader.nextRaw();
    await reader.cancel();
  });

  test("a token that is a substring/superstring of a configured one still fails", async () => {
    const store = open(":memory:");
    const config = loadConfig({ CATAMORBIUS_TOKENS: "abc" });
    const app = buildApp({ config, store, adapters: [] });
    expect((await connect(app, { authorization: "Bearer ab" })).status).toBe(401);
    expect((await connect(app, { authorization: "Bearer abcd" })).status).toBe(401);
  });
});
