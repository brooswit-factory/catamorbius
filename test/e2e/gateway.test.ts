import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { EventSource } from "eventsource";
import type { ErrorEvent } from "eventsource";
import { buildApp } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { open, type Store } from "../../src/store/index.js";

const GITHUB_DIR = join(import.meta.dir, "../fixtures/github");
const JIRA_DIR = join(import.meta.dir, "../fixtures/jira");

// Throwaway values used only inside this test process — never real secrets.
const GITHUB_SECRET = "e2e-test-github-webhook-secret";
const JIRA_SECRET = "e2e-test-jira-webhook-secret";
const TEST_TOKEN = "e2e-test-bearer-token";

const tempDirs: string[] = [];
const openEventSources: { close(): void }[] = [];

afterEach(() => {
  for (const es of openEventSources.splice(0)) es.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "catamorbius-e2e-"));
  tempDirs.push(dir);
  return join(dir, "events.sqlite");
}

/** The bearer header eventsource's client can't set natively — the whole reason a custom `fetch` is required. */
function authedFetch(token: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })) as typeof fetch;
}

function startServer(dbPath: string, port = 0): { app: ReturnType<typeof buildApp>; store: Store; port: number } {
  const config = loadConfig({
    CATAMORBIUS_DB: dbPath,
    WEBHOOK_SECRET_GITHUB: GITHUB_SECRET,
    WEBHOOK_SECRET_JIRA: JIRA_SECRET,
    CATAMORBIUS_TOKENS: TEST_TOKEN,
    CATAMORBIUS_HEARTBEAT_MS: "100",
    // dev mode intentionally left unset — this proves the default-config path with real secrets.
  });
  const store = open(dbPath);
  // No `adapters` override: this is the whole point of the e2e proof — the REAL
  // registered adapters from src/adapters/index.ts, not test/live's `adapters: []`.
  const app = buildApp({ config, store });
  app.listen(port);
  const boundPort = (app.server as { port: number }).port;
  return { app, store, port: boundPort };
}

/** Rebinding the exact freed port right after stop() can race the OS releasing it; retry briefly. */
async function startServerOnPort(
  dbPath: string,
  port: number,
  retries = 30,
): Promise<{ app: ReturnType<typeof buildApp>; store: Store; port: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return startServer(dbPath, port);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function trackEventSource(es: EventSource): EventSource {
  openEventSources.push(es);
  return es;
}

interface Delivery {
  rawBody: string;
  body: unknown;
  headers: Record<string, string>;
}

function githubDelivery(name: string): Delivery {
  const body = JSON.parse(readFileSync(join(GITHUB_DIR, `${name}.json`), "utf8"));
  const headers = JSON.parse(readFileSync(join(GITHUB_DIR, `${name}.headers.json`), "utf8")) as Record<string, string>;
  return { rawBody: JSON.stringify(body), body, headers };
}

function githubNonJsonDelivery(): Delivery {
  const rawBody = readFileSync(join(GITHUB_DIR, "non-json-body.txt"), "utf8");
  const headers = JSON.parse(readFileSync(join(GITHUB_DIR, "non-json-body.headers.json"), "utf8")) as Record<string, string>;
  return { rawBody, body: rawBody, headers };
}

function jiraDelivery(name: string): Delivery {
  const fixture = JSON.parse(readFileSync(join(JIRA_DIR, `${name}.json`), "utf8")) as { headers: Record<string, string>; body: unknown };
  return { rawBody: JSON.stringify(fixture.body), body: fixture.body, headers: fixture.headers };
}

function jiraNonJsonDelivery(): Delivery {
  const rawBody = readFileSync(join(JIRA_DIR, "non-json-body.txt"), "utf8");
  const headers = {
    "content-type": "text/plain",
    "x-atlassian-webhook-identifier": "e2e-jira-non-json-delivery",
    "x-atlassian-webhook-flow": "Primary",
  };
  return { rawBody, body: rawBody, headers };
}

function githubSignature(rawBody: string, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function jiraSignature(rawBody: string, secret = JIRA_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

interface PostResult {
  status: number;
  events: Array<{ seq: number; id: string; type: string; duplicate: boolean }>;
}

async function postGithub(port: number, delivery: Delivery, signature = githubSignature(delivery.rawBody)): Promise<PostResult> {
  const res = await fetch(`http://localhost:${port}/webhooks/github`, {
    method: "POST",
    body: delivery.rawBody,
    headers: { ...delivery.headers, "x-hub-signature-256": signature },
  });
  const json = (await res.json()) as { events?: PostResult["events"] };
  return { status: res.status, events: json.events ?? [] };
}

async function postJira(port: number, delivery: Delivery, signature = jiraSignature(delivery.rawBody)): Promise<PostResult> {
  const res = await fetch(`http://localhost:${port}/webhooks/jira`, {
    method: "POST",
    body: delivery.rawBody,
    headers: { ...delivery.headers, "x-hub-signature": signature },
  });
  const json = (await res.json()) as { events?: PostResult["events"] };
  return { status: res.status, events: json.events ?? [] };
}

/** `envelope` is the full stored CloudEvents JSON off the wire (`data: <JSON>`); `id` is the SSE frame's `id:` (the seq). */
interface ReceivedFrame {
  type: string;
  id: string;
  envelope: { data: { raw: { body: unknown } } } & Record<string, unknown>;
}

// Every mechanical type this scenario's fixtures produce. EventSource dispatches by
// event name with no default "message" catch-all, so each must be registered explicitly.
const ALL_TYPES = [
  "com.github.pull_request.opened",
  "com.github.push",
  "com.github.issues.opened",
  "com.atlassian.jira.issue.created",
  "com.atlassian.jira.issue.updated",
  "com.atlassian.jira.comment.created",
  "com.github.some_future_thing.did",
  "com.atlassian.jira.future.thing.happened",
  "com.github.unknown",
  "com.atlassian.jira.unknown",
  "com.github.issue_comment.created",
  "com.atlassian.jira.worklog.created",
];

function attachListeners(es: EventSource, received: ReceivedFrame[]): void {
  for (const type of ALL_TYPES) {
    es.addEventListener(type, (evt) => {
      received.push({ type: evt.type, id: evt.lastEventId, envelope: JSON.parse(evt.data) });
    });
  }
}

describe("e2e: the whole gateway product over real HTTP, with the real adapters", () => {
  test("fixtures -> ingress -> store -> SSE: both providers, resume, filters, dedupe, unknown-event retention, negative paths", async () => {
    const dbPath = tempDbPath();
    let server = startServer(dbPath);

    let maxSeq = 0;
    const track = (result: PostResult): PostResult => {
      for (const e of result.events) maxSeq = Math.max(maxSeq, e.seq);
      return result;
    };

    try {
      // (a) subscribe a real EventSource to the whole log, from earliest.
      const received: ReceivedFrame[] = [];
      const client1 = trackEventSource(
        new EventSource(`http://localhost:${server.port}/events?from=earliest`, { fetch: authedFetch(TEST_TOKEN) }),
      );
      attachListeners(client1, received);
      await waitFor(() => client1.readyState === client1.OPEN, 10_000);

      // (b) six documented-shape deliveries, both providers -> 202, and the client
      // receives all six in seq order with exact type/id, and data.raw.body deep-equal
      // to the fixture — the lossless-retention proof through the whole pipeline.
      const ghPrOpened = githubDelivery("pull-request-opened");
      const ghPush = githubDelivery("push");
      const ghIssuesOpened = githubDelivery("issues-opened");
      const jrIssueCreated = jiraDelivery("issue-created");
      const jrIssueUpdated = jiraDelivery("issue-updated");
      const jrCommentCreated = jiraDelivery("comment-created-with-issue");

      const rPrOpened = track(await postGithub(server.port, ghPrOpened));
      const rPush = track(await postGithub(server.port, ghPush));
      const rIssuesOpened = track(await postGithub(server.port, ghIssuesOpened));
      const rIssueCreated = track(await postJira(server.port, jrIssueCreated));
      const rIssueUpdated = track(await postJira(server.port, jrIssueUpdated));
      const rCommentCreated = track(await postJira(server.port, jrCommentCreated));

      for (const r of [rPrOpened, rPush, rIssuesOpened, rIssueCreated, rIssueUpdated, rCommentCreated]) {
        expect(r.status).toBe(202);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]!.duplicate).toBe(false);
      }

      await waitFor(() => received.length >= 6, 10_000);
      expect(received).toHaveLength(6);

      const batch1 = [
        { seq: rPrOpened.events[0]!.seq, type: "com.github.pull_request.opened", body: ghPrOpened.body },
        { seq: rPush.events[0]!.seq, type: "com.github.push", body: ghPush.body },
        { seq: rIssuesOpened.events[0]!.seq, type: "com.github.issues.opened", body: ghIssuesOpened.body },
        { seq: rIssueCreated.events[0]!.seq, type: "com.atlassian.jira.issue.created", body: jrIssueCreated.body },
        { seq: rIssueUpdated.events[0]!.seq, type: "com.atlassian.jira.issue.updated", body: jrIssueUpdated.body },
        { seq: rCommentCreated.events[0]!.seq, type: "com.atlassian.jira.comment.created", body: jrCommentCreated.body },
      ];
      expect(received.map((r) => r.type)).toEqual(batch1.map((e) => e.type));
      expect(received.map((r) => r.id)).toEqual(batch1.map((e) => String(e.seq)));
      for (let i = 0; i < batch1.length; i++) {
        expect(received[i]!.envelope.data.raw.body).toEqual(batch1[i]!.body);
      }

      // (c) unknown-event retention through the whole pipeline: a foreign event name
      // and a non-JSON body, for each provider — mechanically typed, raw retained verbatim.
      const ghForeign = githubDelivery("foreign-event");
      const jrForeign = jiraDelivery("foreign-event");
      const ghNonJson = githubNonJsonDelivery();
      const jrNonJson = jiraNonJsonDelivery();

      const rGhForeign = track(await postGithub(server.port, ghForeign));
      const rJrForeign = track(await postJira(server.port, jrForeign));
      const rGhNonJson = track(await postGithub(server.port, ghNonJson));
      const rJrNonJson = track(await postJira(server.port, jrNonJson));

      for (const r of [rGhForeign, rJrForeign, rGhNonJson, rJrNonJson]) {
        expect(r.status).toBe(202);
        expect(r.events[0]!.duplicate).toBe(false);
      }
      // Mechanical typing, verified (not guessed) against the adapters: the GitHub
      // foreign fixture carries body.action "did", so its type includes that action.
      expect(rGhForeign.events[0]!.type).toBe("com.github.some_future_thing.did");
      expect(rJrForeign.events[0]!.type).toBe("com.atlassian.jira.future.thing.happened");
      expect(rGhNonJson.events[0]!.type).toBe("com.github.unknown");
      expect(rJrNonJson.events[0]!.type).toBe("com.atlassian.jira.unknown");

      await waitFor(() => received.length >= 10, 10_000);
      expect(received).toHaveLength(10);
      const batch2 = received.slice(6, 10);
      expect(batch2.map((r) => r.type)).toEqual([
        "com.github.some_future_thing.did",
        "com.atlassian.jira.future.thing.happened",
        "com.github.unknown",
        "com.atlassian.jira.unknown",
      ]);
      expect(batch2.map((r) => r.id)).toEqual([
        String(rGhForeign.events[0]!.seq),
        String(rJrForeign.events[0]!.seq),
        String(rGhNonJson.events[0]!.seq),
        String(rJrNonJson.events[0]!.seq),
      ]);
      expect(batch2[0]!.envelope.data.raw.body).toEqual(ghForeign.body);
      expect(batch2[1]!.envelope.data.raw.body).toEqual(jrForeign.body);
      expect(batch2[2]!.envelope.data.raw.body).toBe(ghNonJson.rawBody); // raw string, verbatim — not parsed
      expect(batch2[3]!.envelope.data.raw.body).toBe(jrNonJson.rawBody);

      // (d) dedupe through the whole pipeline: re-post the same two deliveries;
      // 202 duplicate:true with the same seq, and nothing new reaches the client.
      const countBeforeDedupe = received.length;
      const rPrDup = track(await postGithub(server.port, ghPrOpened));
      const rIssueUpdatedDup = track(await postJira(server.port, jrIssueUpdated));
      expect(rPrDup.status).toBe(202);
      expect(rPrDup.events[0]!.duplicate).toBe(true);
      expect(rPrDup.events[0]!.seq).toBe(rPrOpened.events[0]!.seq);
      expect(rIssueUpdatedDup.status).toBe(202);
      expect(rIssueUpdatedDup.events[0]!.duplicate).toBe(true);
      expect(rIssueUpdatedDup.events[0]!.seq).toBe(rIssueUpdated.events[0]!.seq);

      await waitFor(() => received.length > countBeforeDedupe, 500).catch(() => {});
      expect(received.length).toBe(countBeforeDedupe);

      // (e) resume through the whole pipeline: tear the connection down for real, post
      // two more deliveries through HTTP (a temp server against the SAME db file) while
      // the client is disconnected, then restart on the SAME port — the client must
      // reconnect on its own (retry: 3000 + Last-Event-ID) and receive exactly the two
      // it missed, nothing older re-delivered.
      const originalPort = server.port;
      await server.app.stop(true);
      server.store.close();

      const temp = startServer(dbPath, 0);
      const ghIssueComment = githubDelivery("issue-comment-created");
      const jrWorklog = jiraDelivery("worklog-created-with-issue");
      const rGhIssueComment = track(await postGithub(temp.port, ghIssueComment));
      const rJrWorklog = track(await postJira(temp.port, jrWorklog));
      expect(rGhIssueComment.status).toBe(202);
      expect(rJrWorklog.status).toBe(202);
      await temp.app.stop(true);
      temp.store.close();

      server = await startServerOnPort(dbPath, originalPort);

      await waitFor(() => received.length >= 12, 15_000);
      expect(received).toHaveLength(12);
      const batch3 = received.slice(10, 12);
      expect(batch3.map((r) => r.type)).toEqual(["com.github.issue_comment.created", "com.atlassian.jira.worklog.created"]);
      expect(batch3.map((r) => r.id)).toEqual([String(rGhIssueComment.events[0]!.seq), String(rJrWorklog.events[0]!.seq)]);
      expect(batch3[0]!.envelope.data.raw.body).toEqual(ghIssueComment.body);
      expect(batch3[1]!.envelope.data.raw.body).toEqual(jrWorklog.body);

      const allFrameIds = received.map((r) => r.id);
      expect(new Set(allFrameIds).size).toBe(allFrameIds.length); // no duplicate ids across the whole run

      // (f) filters: a second client scoped to Jira, a third scoped to one issue.
      const jiraReceived: ReceivedFrame[] = [];
      const client2 = trackEventSource(
        new EventSource(`http://localhost:${server.port}/events?from=earliest&type=${encodeURIComponent("com.atlassian.jira")}`, {
          fetch: authedFetch(TEST_TOKEN),
        }),
      );
      attachListeners(client2, jiraReceived);
      await waitFor(() => jiraReceived.length >= 6, 10_000);
      expect(jiraReceived).toHaveLength(6);
      expect(jiraReceived.map((r) => r.type)).toEqual([
        "com.atlassian.jira.issue.created",
        "com.atlassian.jira.issue.updated",
        "com.atlassian.jira.comment.created",
        "com.atlassian.jira.future.thing.happened",
        "com.atlassian.jira.unknown",
        "com.atlassian.jira.worklog.created",
      ]);
      expect(jiraReceived.map((r) => r.id)).toEqual(
        [
          rIssueCreated.events[0]!.seq,
          rIssueUpdated.events[0]!.seq,
          rCommentCreated.events[0]!.seq,
          rJrForeign.events[0]!.seq,
          rJrNonJson.events[0]!.seq,
          rJrWorklog.events[0]!.seq,
        ].map(String),
      );

      // JRA-20002 is the issue key shared by issue-created/-updated, comment-created-with-issue,
      // and worklog-created-with-issue (verified against the fixtures above) — the foreign event
      // (JRA-20004) and the unknown event (no subject) must NOT appear.
      const subjectReceived: ReceivedFrame[] = [];
      const client3 = trackEventSource(
        new EventSource(`http://localhost:${server.port}/events?from=earliest&subject=${encodeURIComponent("JRA-20002")}`, {
          fetch: authedFetch(TEST_TOKEN),
        }),
      );
      attachListeners(client3, subjectReceived);
      await waitFor(() => subjectReceived.length >= 4, 10_000);
      expect(subjectReceived).toHaveLength(4);
      expect(subjectReceived.map((r) => r.type)).toEqual([
        "com.atlassian.jira.issue.created",
        "com.atlassian.jira.issue.updated",
        "com.atlassian.jira.comment.created",
        "com.atlassian.jira.worklog.created",
      ]);
      expect(subjectReceived.map((r) => r.id)).toEqual(
        [rIssueCreated.events[0]!.seq, rIssueUpdated.events[0]!.seq, rCommentCreated.events[0]!.seq, rJrWorklog.events[0]!.seq].map(
          String,
        ),
      );

      // (g) negative paths.
      const countBeforeBadSig = received.length;
      const badSig = githubSignature(ghPush.rawBody, "not-the-configured-secret");
      const badSigRes = await postGithub(server.port, ghPush, badSig);
      expect(badSigRes.status).toBe(401);
      await waitFor(() => received.length > countBeforeBadSig, 500).catch(() => {});
      expect(received.length).toBe(countBeforeBadSig);

      const wrongTokenErrors: ErrorEvent[] = [];
      const client4 = trackEventSource(
        new EventSource(`http://localhost:${server.port}/events`, { fetch: authedFetch("not-the-configured-token") }),
      );
      client4.addEventListener("error", (err) => wrongTokenErrors.push(err as ErrorEvent));
      await waitFor(() => wrongTokenErrors.length >= 1, 10_000);
      expect(wrongTokenErrors[0]!.code).toBe(401);
      expect(client4.readyState).toBe(client4.CLOSED);

      const healthRes = await fetch(`http://localhost:${server.port}/healthz`);
      const health = (await healthRes.json()) as { ok: boolean; seq: number };
      expect(health.ok).toBe(true);
      expect(health.seq).toBe(maxSeq);
    } finally {
      await server.app.stop(true);
    }
  }, 60_000);
});
