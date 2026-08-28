import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jira } from "../../../src/adapters/jira.js";

const FIXTURES_DIR = join(import.meta.dir, "../../fixtures/jira");

interface DeliveryFixture {
  headers: Record<string, string>;
  body: unknown;
}

interface VerifyFixture {
  secret: string;
  headers: Record<string, string>;
  body: string;
  expectedReason?: string;
}

function loadDelivery(name: string): DeliveryFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as DeliveryFixture;
}

function loadVerify(name: string): VerifyFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as VerifyFixture;
}

function bodyText(fixture: DeliveryFixture): string {
  return JSON.stringify(fixture.body);
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const out = { ...headers };
  delete out[name];
  return out;
}

describe("jira adapter — toEvents — documented shapes", () => {
  test("jira:issue_created", () => {
    const fixture = loadDelivery("issue-created");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event).toBeDefined();
    expect(event!.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(event!.source).toBe("//jira/your-domain.atlassian.net");
    expect(event!.type).toBe("com.atlassian.jira.issue.created");
    expect(event!.time).toBe("2020-11-27T12:33:56.302Z");
    expect(event!.subject).toBe("JRA-20002");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "created",
      entity: { kind: "issue", key: "JRA-20002", url: "https://your-domain.atlassian.net/browse/JRA-20002" },
      title: "I feel the need for speed",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("jira:issue_updated (with changelog) — the literal documented example", () => {
    const fixture = loadDelivery("issue-updated");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("22222222-2222-2222-2222-222222222222");
    expect(event!.source).toBe("//jira/your-domain.atlassian.net");
    expect(event!.type).toBe("com.atlassian.jira.issue.updated");
    expect(event!.time).toBe("2020-11-27T12:33:56.302Z");
    expect(event!.subject).toBe("JRA-20002");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "updated",
      entity: { kind: "issue", key: "JRA-20002", url: "https://your-domain.atlassian.net/browse/JRA-20002" },
      title: "I feel the need for speed",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("jira:issue_deleted", () => {
    const fixture = loadDelivery("issue-deleted");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("33333333-3333-3333-3333-333333333333");
    expect(event!.source).toBe("//jira/your-domain.atlassian.net");
    expect(event!.type).toBe("com.atlassian.jira.issue.deleted");
    expect(event!.time).toBe("2020-11-27T12:43:19.000Z");
    expect(event!.subject).toBe("JRA-20003");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "deleted",
      entity: { kind: "issue", key: "JRA-20003", url: "https://your-domain.atlassian.net/browse/JRA-20003" },
      title: "Old issue to delete",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("comment_created, with a top-level issue object", () => {
    const fixture = loadDelivery("comment-created-with-issue");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("44444444-4444-4444-4444-444444444444");
    expect(event!.source).toBe("//jira/your-domain.atlassian.net");
    expect(event!.type).toBe("com.atlassian.jira.comment.created");
    expect(event!.time).toBe("2020-11-27T12:45:00.000Z");
    expect(event!.subject).toBe("JRA-20002");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "created",
      entity: { kind: "comment", key: "JRA-20002#comment-252789", url: "https://your-domain.atlassian.net/browse/JRA-20002" },
      title: "I feel the need for speed",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("comment_created, hedge case: no top-level issue object (UNDOCUMENTED whether one exists)", () => {
    const fixture = loadDelivery("comment-created-without-issue");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("55555555-5555-5555-5555-555555555555");
    expect(event!.source).toBe("//jira/your-domain.atlassian.net");
    expect(event!.type).toBe("com.atlassian.jira.comment.created");
    expect(event!.time).toBe("2020-11-27T12:46:40.000Z");
    expect(event!.subject).toBeUndefined();
    expect(event!.data.summary).toEqual({ actor: "Bryan Rollins [Atlassian]", action: "created" });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("comment_updated", () => {
    const fixture = loadDelivery("comment-updated");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("66666666-6666-6666-6666-666666666666");
    expect(event!.type).toBe("com.atlassian.jira.comment.updated");
    expect(event!.time).toBe("2020-11-27T12:48:20.000Z");
    expect(event!.subject).toBe("JRA-20002");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "updated",
      entity: { kind: "comment", key: "JRA-20002#comment-252789", url: "https://your-domain.atlassian.net/browse/JRA-20002" },
      title: "I feel the need for speed",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("worklog_created, with a top-level issue object", () => {
    const fixture = loadDelivery("worklog-created-with-issue");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("77777777-7777-7777-7777-777777777777");
    expect(event!.type).toBe("com.atlassian.jira.worklog.created");
    expect(event!.time).toBe("2020-11-27T12:50:00.000Z");
    expect(event!.subject).toBe("JRA-20002");
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      action: "created",
      entity: { kind: "worklog", key: "JRA-20002", url: "https://your-domain.atlassian.net/browse/JRA-20002" },
      title: "I feel the need for speed",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("worklog_created, hedge case: no top-level issue object", () => {
    const fixture = loadDelivery("worklog-created-without-issue");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("88888888-8888-8888-8888-888888888888");
    expect(event!.type).toBe("com.atlassian.jira.worklog.created");
    expect(event!.time).toBe("2020-11-27T12:51:40.000Z");
    expect(event!.subject).toBeUndefined();
    expect(event!.data.summary).toEqual({ actor: "Bryan Rollins [Atlassian]", action: "created" });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("a foreign webhookEvent value flows through with mechanical typing — no allowlist", () => {
    const fixture = loadDelivery("foreign-event");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe("99999999-9999-9999-9999-999999999999");
    expect(event!.type).toBe("com.atlassian.jira.future.thing.happened");
    expect(event!.time).toBe("2020-11-27T12:53:20.000Z");
    expect(event!.subject).toBe("JRA-20004");
    // "future" isn't a recognized entity kind, so summary is best-effort without entity/action.
    expect(event!.data.summary).toEqual({
      actor: "Bryan Rollins [Atlassian]",
      title: "An issue involved in a webhookEvent this code has never seen",
    });
    expect(event!.data.raw.body).toEqual(fixture.body);
  });

  test("non-JSON body -> single com.atlassian.jira.unknown event, raw intact, never throws", () => {
    const text = readFileSync(join(FIXTURES_DIR, "non-json-body.txt"), "utf8");
    const headers = { "content-type": "text/plain", "x-atlassian-webhook-flow": "Primary" };
    const [event] = jira.toEvents(text, headers);
    expect(event!.type).toBe("com.atlassian.jira.unknown");
    expect(event!.source).toBe("//jira/unknown");
    expect(event!.data.raw.body).toBe(text);
    expect(event!.data.raw.headers["x-atlassian-webhook-flow"]).toBe("Primary");
  });

  test("JSON body with no webhookEvent -> single com.atlassian.jira.unknown event, raw intact", () => {
    const headers = { "content-type": "application/json" };
    const [event] = jira.toEvents(JSON.stringify({ hello: "world" }), headers);
    expect(event!.type).toBe("com.atlassian.jira.unknown");
    expect(event!.source).toBe("//jira/unknown");
    expect(event!.data.raw.body).toEqual({ hello: "world" });
  });

  test("actor falls back to user.accountId when displayName is absent", () => {
    const headers = { "x-atlassian-webhook-identifier": "fallback-actor" };
    const body = {
      timestamp: 1606480436302,
      webhookEvent: "jira:issue_created",
      user: { accountId: "99:acct-only" },
      issue: { id: "1", self: "https://your-domain.atlassian.net/rest/api/2/issue/1", key: "JRA-1" },
    };
    const [event] = jira.toEvents(JSON.stringify(body), headers);
    expect(event!.data.summary.actor).toBe("99:acct-only");
  });

  test("an unparseable self URL is simply not used for site-host derivation", () => {
    const headers = { "x-atlassian-webhook-identifier": "bad-self-url" };
    const body = {
      timestamp: 1606480436302,
      webhookEvent: "jira:issue_created",
      issue: { id: "1", self: "not a url", key: "JRA-1" },
    };
    const [event] = jira.toEvents(JSON.stringify(body), headers);
    expect(event!.source).toBe("//jira/unknown");
  });
});

describe("jira adapter — toEvents — headers", () => {
  test("retains only content-type/user-agent/x-atlassian-* headers, dropping signature/token-bearing ones itself", () => {
    const fixture = loadDelivery("issue-created");
    const headers = {
      ...fixture.headers,
      "user-agent": "AtlassianWebhook/1.0",
      "x-hub-signature": "sha256=deadbeef",
      authorization: "Bearer nope",
      "x-random-other": "dropped",
    };
    const [event] = jira.toEvents(bodyText(fixture), headers);
    expect(event!.data.raw.headers).toEqual({
      "content-type": "application/json",
      "user-agent": "AtlassianWebhook/1.0",
      "x-atlassian-webhook-identifier": "11111111-1111-1111-1111-111111111111",
      "x-atlassian-webhook-flow": "Primary",
    });
  });
});

describe("jira adapter — id derivation", () => {
  test("x-atlassian-webhook-identifier is used directly as id when present", () => {
    const fixture = loadDelivery("issue-created");
    const [event] = jira.toEvents(bodyText(fixture), fixture.headers);
    expect(event!.id).toBe(fixture.headers["x-atlassian-webhook-identifier"]!);
  });

  test("without the identifier header, the same body twice yields the same derived id", () => {
    const fixture = loadDelivery("issue-updated");
    const headers = withoutHeader(fixture.headers, "x-atlassian-webhook-identifier");
    const body = bodyText(fixture);
    const [first] = jira.toEvents(body, headers);
    const [second] = jira.toEvents(body, headers);
    expect(first!.id).toBe(second!.id);
  });

  test("without the identifier header, distinct fixtures never collide", () => {
    const a = loadDelivery("issue-created");
    const b = loadDelivery("issue-deleted");
    const [eventA] = jira.toEvents(bodyText(a), withoutHeader(a.headers, "x-atlassian-webhook-identifier"));
    const [eventB] = jira.toEvents(bodyText(b), withoutHeader(b.headers, "x-atlassian-webhook-identifier"));
    expect(eventA!.id).not.toBe(eventB!.id);
  });
});

describe("jira adapter — verify", () => {
  test("known-good vector from Atlassian's docs -> ok", () => {
    const fixture = loadVerify("verify-known-good");
    const result = jira.verify(fixture.headers, fixture.body, fixture.secret);
    expect(result).toEqual({ ok: true });
  });

  const badCases = [
    "verify-bad-wrong-secret",
    "verify-bad-tampered-body",
    "verify-bad-missing-header",
    "verify-bad-malformed-header",
    "verify-bad-unsupported-method",
    "verify-bad-wrong-length",
  ];

  for (const name of badCases) {
    test(`${name} -> ok:false with its documented reason`, () => {
      const fixture = loadVerify(name);
      const result = jira.verify(fixture.headers, fixture.body, fixture.secret);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(fixture.expectedReason!);
    });
  }
});
