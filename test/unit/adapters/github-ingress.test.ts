import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { buildApp } from "../../../src/server.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { github } from "../../../src/adapters/github.js";
import { TEST_SECRET } from "../../fixtures/github/secret.js";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/github");

function loadHeaders(name: string): Record<string, string> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

function loadBytes(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

function signatureFor(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function post(app: { handle: (req: Request) => Promise<Response> }, body: Buffer, headers: Record<string, string>) {
  return app.handle(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      body,
      headers,
    }),
  );
}

describe("github adapter — ingress", () => {
  const body = loadBytes("pull-request-opened.json");
  const headers: Record<string, string> = {
    ...loadHeaders("pull-request-opened.headers.json"),
    "x-hub-signature-256": signatureFor(TEST_SECRET, body),
  };

  test("valid delivery with a correct signature -> 202 with seq/id/type", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({ WEBHOOK_SECRET_GITHUB: TEST_SECRET }), store, adapters: [github] });

    const res = await post(app, body, headers);
    expect(res.status).toBe(202);
    const json = (await res.json()) as { events: Array<{ seq: number; id: string; type: string; duplicate: boolean }> };
    expect(json.events).toHaveLength(1);
    expect(json.events[0]!.type).toBe("com.github.pull_request.opened");
    expect(json.events[0]!.id).toBe(headers["x-github-delivery"]!);
    expect(json.events[0]!.seq).toBe(1);
    expect(json.events[0]!.duplicate).toBe(false);
  });

  test("the same delivery posted again -> 202 duplicate:true, same seq, no new row", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({ WEBHOOK_SECRET_GITHUB: TEST_SECRET }), store, adapters: [github] });

    const first = await post(app, body, headers);
    const firstJson = (await first.json()) as { events: Array<{ seq: number }> };

    const second = await post(app, body, headers);
    expect(second.status).toBe(202);
    const secondJson = (await second.json()) as { events: Array<{ seq: number; duplicate: boolean }> };
    expect(secondJson.events[0]!.duplicate).toBe(true);
    expect(secondJson.events[0]!.seq).toBe(firstJson.events[0]!.seq);
    expect(store.read()).toHaveLength(1);
  });

  test("a bad signature -> 401, nothing stored", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({ WEBHOOK_SECRET_GITHUB: TEST_SECRET }), store, adapters: [github] });

    const badHeaders: Record<string, string> = { ...headers, "x-hub-signature-256": signatureFor("wrong-secret", body) };
    const res = await post(app, body, badHeaders);
    expect(res.status).toBe(401);
    expect(store.latestSeq()).toBe(0);
  });

  test("secret absent, default config -> 503, nothing stored", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({}), store, adapters: [github] });

    const res = await post(app, body, headers);
    expect(res.status).toBe(503);
    expect(store.latestSeq()).toBe(0);
  });

  test("secret absent + CATAMORBIUS_DEV_MODE=1 -> 202, WARN logged", async () => {
    const store = open(":memory:");
    const app = buildApp({ config: loadConfig({ CATAMORBIUS_DEV_MODE: "1" }), store, adapters: [github] });

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const res = await post(app, body, headers);
      expect(res.status).toBe(202);
      expect(store.latestSeq()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WEBHOOK_SECRET_GITHUB/);
    } finally {
      console.warn = original;
    }
  });
});
