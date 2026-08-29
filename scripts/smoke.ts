/**
 * Human-readable smoke test: drives (a)-(e) of test/e2e/gateway.test.ts's scenario
 * against a server you point it at, printing each frame as it arrives. Not a CI
 * gate — nothing in `bun run check` depends on this file. Usage:
 *
 *   CATAMORBIUS_URL=http://localhost:3000 \
 *   CATAMORBIUS_TOKENS=<token> WEBHOOK_SECRET_GITHUB=<secret> WEBHOOK_SECRET_JIRA=<secret> \
 *   bun run smoke
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { EventSource } from "eventsource";

const FIXTURES_DIR = join(import.meta.dir, "../test/fixtures");

function fail(message: string): never {
  console.error(`\n[smoke] FAILED: ${message}`);
  process.exit(1);
}

const BASE_URL = process.env.CATAMORBIUS_URL ?? "http://localhost:3000";
const TOKEN =
  (process.env.CATAMORBIUS_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)[0] ??
  fail("CATAMORBIUS_TOKENS is not set (or empty) — smoke needs a bearer token to subscribe to GET /events");
const GITHUB_SECRET =
  process.env.WEBHOOK_SECRET_GITHUB ?? fail("WEBHOOK_SECRET_GITHUB is not set — smoke needs it to sign GitHub fixture deliveries");
const JIRA_SECRET =
  process.env.WEBHOOK_SECRET_JIRA ?? fail("WEBHOOK_SECRET_JIRA is not set — smoke needs it to sign Jira fixture deliveries");

interface Delivery {
  rawBody: string;
  headers: Record<string, string>;
}

function githubDelivery(name: string): Delivery {
  const body = JSON.parse(readFileSync(join(FIXTURES_DIR, "github", `${name}.json`), "utf8"));
  const headers = JSON.parse(readFileSync(join(FIXTURES_DIR, "github", `${name}.headers.json`), "utf8")) as Record<string, string>;
  return { rawBody: JSON.stringify(body), headers };
}

function githubNonJsonDelivery(): Delivery {
  const rawBody = readFileSync(join(FIXTURES_DIR, "github", "non-json-body.txt"), "utf8");
  const headers = JSON.parse(readFileSync(join(FIXTURES_DIR, "github", "non-json-body.headers.json"), "utf8")) as Record<string, string>;
  return { rawBody, headers };
}

function jiraDelivery(name: string): Delivery {
  const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "jira", `${name}.json`), "utf8")) as {
    headers: Record<string, string>;
    body: unknown;
  };
  return { rawBody: JSON.stringify(fixture.body), headers: fixture.headers };
}

function jiraNonJsonDelivery(): Delivery {
  const rawBody = readFileSync(join(FIXTURES_DIR, "jira", "non-json-body.txt"), "utf8");
  return {
    rawBody,
    headers: { "content-type": "text/plain", "x-atlassian-webhook-identifier": "smoke-jira-non-json-delivery" },
  };
}

interface PostResult {
  status: number;
  events: Array<{ seq: number; id: string; type: string; duplicate: boolean }>;
}

async function postGithub(delivery: Delivery): Promise<PostResult> {
  const signature = `sha256=${createHmac("sha256", GITHUB_SECRET).update(delivery.rawBody).digest("hex")}`;
  const res = await fetch(`${BASE_URL}/webhooks/github`, {
    method: "POST",
    body: delivery.rawBody,
    headers: { ...delivery.headers, "x-hub-signature-256": signature },
  });
  const json = (await res.json().catch(() => ({}))) as { events?: PostResult["events"] };
  return { status: res.status, events: json.events ?? [] };
}

async function postJira(delivery: Delivery): Promise<PostResult> {
  const signature = `sha256=${createHmac("sha256", JIRA_SECRET).update(delivery.rawBody).digest("hex")}`;
  const res = await fetch(`${BASE_URL}/webhooks/jira`, {
    method: "POST",
    body: delivery.rawBody,
    headers: { ...delivery.headers, "x-hub-signature": signature },
  });
  const json = (await res.json().catch(() => ({}))) as { events?: PostResult["events"] };
  return { status: res.status, events: json.events ?? [] };
}

function authedFetch(token: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } })) as typeof fetch;
}

// Every mechanical type the (a)-(e) fixtures below produce — EventSource dispatches
// by event name, with no default "message" catch-all for a named event.
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

function summarize(envelope: { data?: { summary?: { actor?: string; action?: string; title?: string } } }): string {
  const s = envelope.data?.summary ?? {};
  const bits = [s.actor, s.action, s.title].filter((x): x is string => typeof x === "string" && x.length > 0);
  return bits.length > 0 ? bits.join(" — ") : "(no summary)";
}

function printFrame(evt: MessageEvent): void {
  const envelope = JSON.parse(evt.data) as Parameters<typeof summarize>[0];
  console.log(`  seq ${evt.lastEventId}  ${evt.type}  ${summarize(envelope)}`);
}

function subscribe(url: string, counter: { count: number }): EventSource {
  const es = new EventSource(url, { fetch: authedFetch(TOKEN) });
  for (const type of ALL_TYPES) {
    es.addEventListener(type, (evt) => {
      counter.count++;
      printFrame(evt);
    });
  }
  return es;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) fail(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] catamorbius smoke test against ${BASE_URL}\n`);

  const healthRes = await fetch(`${BASE_URL}/healthz`).catch((err) => fail(`GET /healthz failed: ${err}`));
  if (!healthRes.ok) fail(`GET /healthz -> ${healthRes.status}`);
  console.log(`[smoke] healthz: ${JSON.stringify(await healthRes.json())}`);

  console.log(`\n[smoke] (a) subscribing to GET /events?from=earliest ...`);
  const received = { count: 0 };
  const es = subscribe(`${BASE_URL}/events?from=earliest`, received);
  await waitFor(() => es.readyState === es.OPEN, 10_000, "the SSE connection to open");
  console.log(`[smoke] connected.`);

  console.log(`\n[smoke] (b) posting 6 documented-shape deliveries (both providers) ...`);
  const prOpened = await postGithub(githubDelivery("pull-request-opened"));
  const push = await postGithub(githubDelivery("push"));
  const issuesOpened = await postGithub(githubDelivery("issues-opened"));
  const issueCreated = await postJira(jiraDelivery("issue-created"));
  const issueUpdated = await postJira(jiraDelivery("issue-updated"));
  const commentCreated = await postJira(jiraDelivery("comment-created-with-issue"));
  let lastSeq = 0;
  for (const [label, r] of [
    ["github pull-request-opened", prOpened],
    ["github push", push],
    ["github issues-opened", issuesOpened],
    ["jira issue-created", issueCreated],
    ["jira issue-updated", issueUpdated],
    ["jira comment-created-with-issue", commentCreated],
  ] as const) {
    if (r.status !== 202) fail(`POST for ${label} -> ${r.status}, expected 202`);
    for (const e of r.events) lastSeq = Math.max(lastSeq, e.seq);
    console.log(`[smoke] posted ${label} -> 202, seq ${r.events.map((e) => e.seq).join(",")}`);
  }
  await waitFor(() => received.count >= 6, 10_000, "6 frames on the live stream");

  console.log(`\n[smoke] (c) unknown-event retention: a foreign event and a non-JSON body, per provider ...`);
  for (const [label, r] of [
    ["github foreign-event", await postGithub(githubDelivery("foreign-event"))],
    ["jira foreign-event", await postJira(jiraDelivery("foreign-event"))],
    ["github non-json-body", await postGithub(githubNonJsonDelivery())],
    ["jira non-json-body", await postJira(jiraNonJsonDelivery())],
  ] as const) {
    if (r.status !== 202) fail(`POST for ${label} -> ${r.status}, expected 202`);
    for (const e of r.events) lastSeq = Math.max(lastSeq, e.seq);
    console.log(`[smoke] posted ${label} -> 202, seq ${r.events.map((e) => e.seq).join(",")}`);
  }
  await waitFor(() => received.count >= 10, 10_000, "10 frames on the live stream");

  console.log(`\n[smoke] (d) dedupe: re-posting github pull-request-opened ...`);
  const dup = await postGithub(githubDelivery("pull-request-opened"));
  if (dup.status !== 202 || dup.events[0]?.duplicate !== true || dup.events[0]?.seq !== prOpened.events[0]?.seq) {
    fail("redelivery was not deduped as expected (want 202, duplicate:true, same seq as the original)");
  }
  console.log(`[smoke] dedupe OK: seq ${dup.events[0]!.seq}, duplicate: true`);

  console.log(`\n[smoke] (e) disconnect/resume: closing the client, posting 2 more, reconnecting from where it left off ...`);
  es.close();
  const issueComment = await postGithub(githubDelivery("issue-comment-created"));
  const worklog = await postJira(jiraDelivery("worklog-created-with-issue"));
  if (issueComment.status !== 202 || worklog.status !== 202) fail("posting while disconnected failed");
  console.log(`[smoke] posted 2 deliveries while disconnected (seq ${issueComment.events[0]!.seq}, ${worklog.events[0]!.seq})`);

  const resumed = { count: 0 };
  const es2 = subscribe(`${BASE_URL}/events?from=${lastSeq + 1}`, resumed);
  await waitFor(() => resumed.count >= 2, 10_000, "2 resumed frames after reconnecting");
  console.log(`[smoke] resume OK: received ${resumed.count} frame(s) after reconnect.`);
  es2.close();

  console.log(`\n[smoke] all checks passed.`);
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
