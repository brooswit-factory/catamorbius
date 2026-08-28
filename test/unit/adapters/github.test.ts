import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
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

function isRecentIso(value: string): boolean {
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && Math.abs(Date.now() - t) < 5000;
}

describe("github adapter — verify", () => {
  const body = loadBytes("pull-request-opened.json");
  const goodSignature = signatureFor(TEST_SECRET, body);

  test("known-good signature passes", () => {
    const result = github.verify({ "x-hub-signature-256": goodSignature }, body, TEST_SECRET);
    expect(result).toEqual({ ok: true });
  });

  test("missing signature header fails", () => {
    const result = github.verify({}, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/missing/i);
  });

  test("legacy sha1-only header is ignored entirely — still fails as missing", () => {
    const result = github.verify({ "x-hub-signature": "sha1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/missing/i);
  });

  test("header not prefixed sha256= fails", () => {
    const result = github.verify({ "x-hub-signature-256": goodSignature.replace("sha256=", "sha1=") }, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/prefixed/i);
  });

  test("malformed hex (non-hex characters) fails", () => {
    const malformed = `sha256=${"z".repeat(64)}`;
    const result = github.verify({ "x-hub-signature-256": malformed }, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/hex/i);
  });

  test("hex of the wrong length fails without throwing", () => {
    const shortHex = `sha256=${"ab".repeat(30)}`; // 60 hex chars, not 64
    const result = github.verify({ "x-hub-signature-256": shortHex }, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/length/i);
  });

  test("correct length but wrong digest fails", () => {
    const flippedLastChar = goodSignature.slice(0, -1) + (goodSignature.endsWith("0") ? "1" : "0");
    const result = github.verify({ "x-hub-signature-256": flippedLastChar }, body, TEST_SECRET);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/match/i);
  });

  test("wrong secret fails", () => {
    const result = github.verify({ "x-hub-signature-256": goodSignature }, body, "a-different-secret");
    expect(result.ok).toBe(false);
  });

  test("tampered body (one byte changed) fails", () => {
    const tampered = Buffer.from(body);
    tampered[0] = tampered[0]! ^ 0xff;
    const result = github.verify({ "x-hub-signature-256": goodSignature }, tampered, TEST_SECRET);
    expect(result.ok).toBe(false);
  });

  test("never throws for adversarial input", () => {
    expect(() => github.verify({ "x-hub-signature-256": "sha256=" }, body, TEST_SECRET)).not.toThrow();
    expect(() => github.verify({ "x-hub-signature-256": "not-even-close" }, body, TEST_SECRET)).not.toThrow();
    expect(() => github.verify({}, "", TEST_SECRET)).not.toThrow();
  });
});

describe("github adapter — toEvents mechanical typing", () => {
  test("ping", () => {
    const headers = loadHeaders("ping.headers.json");
    const rawBody = loadBytes("ping.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event).toBeDefined();
    expect(event!.id).toBe(headers["x-github-delivery"]!);
    expect(event!.source).toBe("//github/octocat");
    expect(event!.type).toBe("com.github.ping");
    expect(isRecentIso(event!.time)).toBe(true);
    expect(event!.subject).toBe("octocat/Hello-World");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "ping",
      entity: { kind: "repository", key: "octocat/Hello-World", url: "https://github.com/octocat/Hello-World" },
      title: "octocat/Hello-World",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("push", () => {
    const headers = loadHeaders("push.headers.json");
    const rawBody = loadBytes("push.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.id).toBe(headers["x-github-delivery"]!);
    expect(event!.source).toBe("//github/octocat");
    expect(event!.type).toBe("com.github.push");
    expect(event!.time).toBe(new Date("2026-08-20T12:34:56-07:00").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World@refs/heads/main");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "push",
      entity: { kind: "push", key: "octocat/Hello-World@refs/heads/main", url: "https://github.com/octocat/Hello-World" },
      title: "Fix bug in widget renderer",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("pull_request opened", () => {
    const headers = loadHeaders("pull-request-opened.headers.json");
    const rawBody = loadBytes("pull-request-opened.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.id).toBe(headers["x-github-delivery"]!);
    expect(event!.source).toBe("//github/octocat");
    expect(event!.type).toBe("com.github.pull_request.opened");
    expect(event!.time).toBe(new Date("2026-08-20T10:05:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World#42");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "opened",
      entity: { kind: "pull_request", key: "octocat/Hello-World#42", url: "https://github.com/octocat/Hello-World/pull/42" },
      title: "Add HMAC verification for GitHub webhooks",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("pull_request closed (merged: true)", () => {
    const headers = loadHeaders("pull-request-closed-merged.headers.json");
    const rawBody = loadBytes("pull-request-closed-merged.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.pull_request.closed");
    expect(event!.time).toBe(new Date("2026-08-20T14:30:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World#42");
    expect(event!.data.summary.action).toBe("closed");
    expect((event!.data.raw.body as { pull_request: { merged: boolean } }).pull_request.merged).toBe(true);
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("issues.opened", () => {
    const headers = loadHeaders("issues-opened.headers.json");
    const rawBody = loadBytes("issues-opened.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.issues.opened");
    expect(event!.time).toBe(new Date("2026-08-19T09:00:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World#7");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "opened",
      entity: { kind: "issue", key: "octocat/Hello-World#7", url: "https://github.com/octocat/Hello-World/issues/7" },
      title: "Webhook delivery retries are not deduped",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("issue_comment.created", () => {
    const headers = loadHeaders("issue-comment-created.headers.json");
    const rawBody = loadBytes("issue-comment-created.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.issue_comment.created");
    expect(event!.time).toBe(new Date("2026-08-20T11:00:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World#7");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "created",
      entity: { kind: "issue", key: "octocat/Hello-World#7", url: "https://github.com/octocat/Hello-World/issues/7" },
      title: "Webhook delivery retries are not deduped",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("pull_request_review.submitted", () => {
    const headers = loadHeaders("pull-request-review-submitted.headers.json");
    const rawBody = loadBytes("pull-request-review-submitted.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.pull_request_review.submitted");
    expect(event!.time).toBe(new Date("2026-08-20T12:00:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World#42");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "submitted",
      entity: { kind: "pull_request", key: "octocat/Hello-World#42", url: "https://github.com/octocat/Hello-World/pull/42" },
      title: "Add HMAC verification for GitHub webhooks",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("release.published", () => {
    const headers = loadHeaders("release-published.headers.json");
    const rawBody = loadBytes("release-published.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.release.published");
    expect(event!.time).toBe(new Date("2026-08-20T13:00:00Z").toISOString());
    expect(event!.subject).toBe("octocat/Hello-World");
    expect(event!.data.summary).toEqual({
      actor: "octocat",
      action: "published",
      entity: { kind: "repository", key: "octocat/Hello-World", url: "https://github.com/octocat/Hello-World" },
      title: "octocat/Hello-World",
    });
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect(event!.data.raw.headers).toEqual(headers);
  });

  test("foreign event never seen before flows through mechanically, raw intact", () => {
    const headers = loadHeaders("foreign-event.headers.json");
    const rawBody = loadBytes("foreign-event.json");
    const parsedBody = JSON.parse(rawBody.toString("utf8"));
    const [event] = github.toEvents(rawBody, headers);

    expect(headers["x-github-event"]).toBe("some_future_thing");
    expect(event!.type).toBe("com.github.some_future_thing.did");
    expect(event!.source).toBe("//github/octocat");
    expect(event!.subject).toBe("octocat/Hello-World");
    expect(event!.data.raw.body).toEqual(parsedBody);
    expect((event!.data.raw.body as { widget: unknown }).widget).toEqual({ id: 1, name: "sprocket" });
  });

  test("non-JSON body -> com.github.unknown with the raw string retained", () => {
    const headers = loadHeaders("non-json-body.headers.json");
    const rawBody = loadBytes("non-json-body.txt");
    const rawText = rawBody.toString("utf8");
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.unknown");
    expect(event!.source).toBe("//github/unknown");
    expect(event!.id).toBe(headers["x-github-delivery"]!);
    expect(event!.data.raw.body).toBe(rawText);
    expect(event!.data.summary).toEqual({});
  });

  test("missing x-github-event header with a valid JSON body -> com.github.unknown", () => {
    const headers = loadHeaders("push.headers.json");
    delete headers["x-github-event"];
    const rawBody = loadBytes("push.json");
    const [event] = github.toEvents(rawBody, headers);

    expect(event!.type).toBe("com.github.unknown");
    expect(event!.source).toBe("//github/unknown");
    expect(event!.data.raw.body).toEqual(JSON.parse(rawBody.toString("utf8")));
  });

  test("id falls back to a sha256 of headers+body when x-github-delivery is absent", () => {
    const headers = loadHeaders("push.headers.json");
    delete headers["x-github-delivery"];
    const rawBody = loadBytes("push.json");
    const [event] = github.toEvents(rawBody, headers);

    const expectedId = createHash("sha256").update(JSON.stringify(headers)).update(rawBody).digest("hex");
    expect(event!.id).toBe(expectedId);
  });

  test("headers filtered exactly: signature headers never retained, x-github-*/content-type/user-agent are", () => {
    const headers: Record<string, string> = {
      ...loadHeaders("pull-request-opened.headers.json"),
      "x-hub-signature": "sha1=deadbeef",
      "x-hub-signature-256": "sha256=deadbeef",
      "x-forwarded-for": "203.0.113.1",
    };
    const rawBody = loadBytes("pull-request-opened.json");
    const [event] = github.toEvents(rawBody, headers);

    const retained = event!.data.raw.headers;
    expect(retained["x-hub-signature"]).toBeUndefined();
    expect(retained["x-hub-signature-256"]).toBeUndefined();
    expect(retained["x-forwarded-for"]).toBeUndefined();
    expect(retained["x-github-event"]).toBe("pull_request");
    expect(retained["x-github-delivery"]).toBe(headers["x-github-delivery"]!);
    expect(retained["content-type"]).toBe("application/json");
    expect(retained["user-agent"]).toBe(headers["user-agent"]!);
  });

  test("toEvents accepts a string rawBody, not just Uint8Array", () => {
    const headers = loadHeaders("issues-opened.headers.json");
    const rawBody = loadBytes("issues-opened.json").toString("utf8");
    const [event] = github.toEvents(rawBody, headers);
    expect(event!.type).toBe("com.github.issues.opened");
  });

  test("source falls back through organization then installation.account when repository.owner is absent", () => {
    const headers = { "x-github-event": "check_run", "x-github-delivery": "d-fallback" };

    const [viaOrganization] = github.toEvents(JSON.stringify({ organization: { login: "acme-org" } }), headers);
    expect(viaOrganization!.source).toBe("//github/acme-org");

    const [viaInstallation] = github.toEvents(
      JSON.stringify({ installation: { account: { login: "acme-app-owner" } } }),
      headers,
    );
    expect(viaInstallation!.source).toBe("//github/acme-app-owner");

    const [viaNone] = github.toEvents(JSON.stringify({}), headers);
    expect(viaNone!.source).toBe("//github/unknown");
  });

  test("toEvents never throws for adversarial input", () => {
    expect(() => github.toEvents("", {})).not.toThrow();
    expect(() => github.toEvents("{}", { "x-github-event": "push" })).not.toThrow();
    expect(() => github.toEvents("not json", { "x-github-event": "push" })).not.toThrow();
    expect(() => github.toEvents(new Uint8Array(), {})).not.toThrow();
  });
});
