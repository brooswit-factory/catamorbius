import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { buildIngress } from "../../../src/ingress/index.js";
import { open } from "../../../src/store/index.js";
import { loadConfig } from "../../../src/config.js";
import { jiraAdapter } from "../../../src/adapters/jira.js";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/jira");
const TEST_SECRET = "catamorbius-jira-ingress-test-secret";

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "issue-updated.json"), "utf8")) as {
  headers: Record<string, string>;
  body: unknown;
};
const rawBody = JSON.stringify(fixture.body);
const goodSignature = `sha256=${createHmac("sha256", TEST_SECRET).update(rawBody).digest("hex")}`;
const badSignature = `sha256=${createHmac("sha256", "not-the-secret").update(rawBody).digest("hex")}`;

function makeApp(envOverrides: Record<string, string> = {}) {
  const store = open(":memory:");
  const config = loadConfig(envOverrides);
  const app = new Elysia().use(buildIngress({ config, store, adapters: [jiraAdapter] }));
  return { app, store };
}

function post(app: { handle: (req: Request) => Promise<Response> }, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/webhooks/jira", {
      method: "POST",
      body: rawBody,
      headers: { ...fixture.headers, ...headers },
    }),
  );
}

describe("jira adapter — ingress", () => {
  test("correctly signed issue_updated delivery -> 202", async () => {
    const { app, store } = makeApp({ WEBHOOK_SECRET_JIRA: TEST_SECRET });
    const res = await post(app, { "x-hub-signature": goodSignature });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { events: Array<{ seq: number; duplicate: boolean; type: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.duplicate).toBe(false);
    expect(body.events[0]!.type).toBe("com.atlassian.jira.issue.updated");
    expect(store.latestSeq()).toBe(1);
  });

  test("the same delivery redelivered -> 202 duplicate:true, same seq, row count unchanged", async () => {
    const { app, store } = makeApp({ WEBHOOK_SECRET_JIRA: TEST_SECRET });
    const first = await post(app, { "x-hub-signature": goodSignature });
    const firstBody = (await first.json()) as { events: Array<{ seq: number }> };
    const second = await post(app, { "x-hub-signature": goodSignature });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { events: Array<{ seq: number; duplicate: boolean }> };
    expect(secondBody.events[0]!.duplicate).toBe(true);
    expect(secondBody.events[0]!.seq).toBe(firstBody.events[0]!.seq);
    expect(store.latestSeq()).toBe(1);
    expect(store.read()).toHaveLength(1);
  });

  test("bad signature -> 401, nothing stored", async () => {
    const { app, store } = makeApp({ WEBHOOK_SECRET_JIRA: TEST_SECRET });
    const res = await post(app, { "x-hub-signature": badSignature });
    expect(res.status).toBe(401);
    expect(store.latestSeq()).toBe(0);
  });

  test("secret absent, default config -> 503, nothing stored", async () => {
    const { app, store } = makeApp({});
    const res = await post(app, { "x-hub-signature": goodSignature });
    expect(res.status).toBe(503);
    expect(store.latestSeq()).toBe(0);
  });

  test("secret absent + CATAMORBIUS_DEV_MODE=1 -> 202, WARN logged", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const { app, store } = makeApp({ CATAMORBIUS_DEV_MODE: "1" });
      const res = await post(app, {});
      expect(res.status).toBe(202);
      expect(store.latestSeq()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WEBHOOK_SECRET_JIRA/);
    } finally {
      console.warn = original;
    }
  });
});
