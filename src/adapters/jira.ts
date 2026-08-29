import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createCloudEvent } from "../events/index.js";
import type { CloudEvent, CloudEventEntity, CloudEventSummary } from "../events/types.js";
import type { ProviderAdapter, VerifyResult } from "./types.js";

/** Per docs/jira-webhooks.md (a): the header is WebSub-style `method=hex`, and
 * the docs warn the method may change — sha256 is just the only one seen today. */
const SUPPORTED_HMAC_METHODS = new Set(["sha256"]);

const SITE_HOST_FIELDS = ["issue", "user", "comment", "project"] as const;
const ENTITY_KINDS = new Set(["issue", "comment", "worklog", "project", "sprint", "version", "board", "user"]);
const RETAINED_HEADER_NAMES = new Set(["content-type", "user-agent"]);
const RETAINED_HEADER_PREFIX = "x-atlassian-";

function toBuffer(rawBody: string | Uint8Array): Buffer {
  return typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function selfHost(entity: unknown): string | undefined {
  const self = asRecord(entity)?.self;
  if (typeof self !== "string") return undefined;
  try {
    return new URL(self).host;
  } catch {
    return undefined;
  }
}

/** source host, per docs/jira-webhooks.md "Site host derivation": issue/user/comment/project .self, in that order. */
function deriveSiteHost(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  for (const field of SITE_HOST_FIELDS) {
    const host = selfHost(body[field]);
    if (host) return host;
  }
  return undefined;
}

/** jira:issue_updated -> com.atlassian.jira.issue.updated. No allowlist — mechanical only. */
function typeFromWebhookEvent(webhookEvent: unknown): string {
  if (typeof webhookEvent !== "string" || webhookEvent.length === 0) return "com.atlassian.jira.unknown";
  const stripped = webhookEvent.startsWith("jira:") ? webhookEvent.slice("jira:".length) : webhookEvent;
  return `com.atlassian.jira.${stripped.replace(/_/g, ".")}`;
}

/** x-atlassian-webhook-identifier when present (stable across retries, per docs (b)); else a
 * deterministic hash so a redelivery of the same body dedupes and distinct events don't collide. */
function deriveId(headers: Record<string, string>, body: Record<string, unknown> | undefined, rawBody: string | Uint8Array): string {
  const headerId = headers["x-atlassian-webhook-identifier"];
  if (headerId) return headerId;

  const entityId = asRecord(body?.issue)?.id ?? asRecord(body?.comment)?.id;
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ webhookEvent: body?.webhookEvent, timestamp: body?.timestamp, entityId }));
  hash.update(toBuffer(rawBody));
  return hash.digest("hex");
}

// Plausibility window for a millis-epoch timestamp: on or after 2000-01-01, and no more
// than a day past receipt. A seconds-epoch value (e.g. 1606480436) falls in 1970 and is
// rejected here rather than trusted as-is — see docs/jira-webhooks.md's UNDOCUMENTED verdict
// on the timestamp unit, which this plausibility check does not revise.
const MIN_PLAUSIBLE_TIME_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** body.timestamp is epoch millis per docs (c) (UNDOCUMENTED as prose, inferred from the example value); else receipt time. */
function deriveTime(body: Record<string, unknown> | undefined, receiptTime: string): string {
  const timestamp = body?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    const time = date.getTime();
    if (!Number.isNaN(time) && time >= MIN_PLAUSIBLE_TIME_MS && time <= Date.now() + MAX_FUTURE_SKEW_MS) {
      return date.toISOString();
    }
  }
  return receiptTime;
}

function deriveSubject(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const issueKey = asRecord(body.issue)?.key;
  if (typeof issueKey === "string") return issueKey;
  const projectKey = asRecord(body.project)?.key;
  if (typeof projectKey === "string") return projectKey;
  for (const field of ["sprint", "version", "board"] as const) {
    const id = asRecord(body[field])?.id;
    if (id !== undefined && id !== null) return String(id);
  }
  return undefined;
}

function deriveEntityKind(type: string): string | undefined {
  const prefix = "com.atlassian.jira.";
  if (!type.startsWith(prefix)) return undefined;
  const rest = type.slice(prefix.length);
  const dot = rest.indexOf(".");
  const kind = dot === -1 ? rest : rest.slice(0, dot);
  return ENTITY_KINDS.has(kind) ? kind : undefined;
}

function deriveAction(type: string, kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  const prefix = `com.atlassian.jira.${kind}.`;
  return type.startsWith(prefix) ? type.slice(prefix.length) : undefined;
}

function deriveActor(body: Record<string, unknown> | undefined): string | undefined {
  const user = asRecord(body?.user);
  if (typeof user?.displayName === "string" && user.displayName.length > 0) return user.displayName;
  if (typeof user?.accountId === "string" && user.accountId.length > 0) return user.accountId;
  return undefined;
}

function deriveTitle(body: Record<string, unknown> | undefined): string | undefined {
  const summary = asRecord(asRecord(body?.issue)?.fields)?.summary;
  return typeof summary === "string" ? summary : undefined;
}

function deriveEntity(
  kind: string | undefined,
  body: Record<string, unknown> | undefined,
  subject: string | undefined,
  siteHost: string | undefined,
): CloudEventEntity | undefined {
  if (!kind) return undefined;

  let key: string | undefined;
  if (kind === "comment") {
    const issueKey = asRecord(body?.issue)?.key;
    const commentId = asRecord(body?.comment)?.id;
    if (typeof issueKey === "string" && commentId !== undefined && commentId !== null) {
      key = `${issueKey}#comment-${commentId}`;
    }
  }
  key ??= subject;
  if (key === undefined) return undefined;

  const issueKey = asRecord(body?.issue)?.key;
  const url = siteHost && typeof issueKey === "string" ? `https://${siteHost}/browse/${issueKey}` : undefined;

  return { kind, key, ...(url ? { url } : {}) };
}

function deriveSummary(
  type: string,
  body: Record<string, unknown> | undefined,
  subject: string | undefined,
  siteHost: string | undefined,
): CloudEventSummary {
  const kind = deriveEntityKind(type);
  const actor = deriveActor(body);
  const action = deriveAction(type, kind);
  const entity = deriveEntity(kind, body, subject, siteHost);
  const title = deriveTitle(body);

  return {
    ...(actor !== undefined ? { actor } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(entity !== undefined ? { entity } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

/** content-type, user-agent, and the documented x-atlassian-* headers — never a signature/token-bearing header. */
function retainedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.includes("signature") || lower.includes("token")) continue;
    if (RETAINED_HEADER_NAMES.has(lower) || lower.startsWith(RETAINED_HEADER_PREFIX)) out[lower] = value;
  }
  return out;
}

/**
 * HMAC of the raw body per docs/jira-webhooks.md (a): header is `<method>=<hex>` (WebSub-style),
 * method read from the header rather than assumed. Constant-time compare, length guarded first.
 * Never throws.
 */
function verify(headers: Record<string, string>, rawBody: string | Uint8Array, secret: string): VerifyResult {
  try {
    const header = headers["x-hub-signature"];
    if (!header) return { ok: false, reason: "missing x-hub-signature header" };

    const match = /^([a-zA-Z0-9-]+)=([0-9a-fA-F]+)$/.exec(header);
    if (!match) return { ok: false, reason: "malformed x-hub-signature header" };
    const method = match[1]!;
    const signatureHex = match[2]!;

    if (!SUPPORTED_HMAC_METHODS.has(method.toLowerCase())) {
      return { ok: false, reason: `unsupported signature method: ${method}` };
    }

    const expected = createHmac(method.toLowerCase(), secret).update(toBuffer(rawBody)).digest();
    const received = Buffer.from(signatureHex, "hex");
    if (received.length !== expected.length) {
      return { ok: false, reason: "signature length mismatch" };
    }
    if (!timingSafeEqual(received, expected)) {
      return { ok: false, reason: "signature mismatch" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function unknownEvent(headers: Record<string, string>, rawBody: string | Uint8Array, body: unknown, receiptTime: string): CloudEvent {
  const record = asRecord(body);
  const siteHost = deriveSiteHost(record);
  return createCloudEvent({
    id: deriveId(headers, record, rawBody),
    source: siteHost ? `//jira/${siteHost}` : "//jira/unknown",
    type: "com.atlassian.jira.unknown",
    time: deriveTime(record, receiptTime),
    raw: { body, headers: retainedHeaders(headers) },
  });
}

/**
 * Mechanically types every Jira delivery — no allowlist of event names. An
 * unrecognizable delivery (body not JSON, or JSON with no webhookEvent) is
 * stored as a single com.atlassian.jira.unknown event. Never throws.
 */
function toEvents(rawBody: string | Uint8Array, headers: Record<string, string>): CloudEvent[] {
  const receiptTime = new Date().toISOString();
  try {
    const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    const body = asRecord(parsed);
    if (!body || typeof body.webhookEvent !== "string") {
      return [unknownEvent(headers, rawBody, parsed, receiptTime)];
    }

    const type = typeFromWebhookEvent(body.webhookEvent);
    const siteHost = deriveSiteHost(body);
    const subject = deriveSubject(body);

    return [
      createCloudEvent({
        id: deriveId(headers, body, rawBody),
        source: siteHost ? `//jira/${siteHost}` : "//jira/unknown",
        type,
        time: deriveTime(body, receiptTime),
        ...(subject !== undefined ? { subject } : {}),
        raw: { body: parsed, headers: retainedHeaders(headers) },
        summary: deriveSummary(type, body, subject, siteHost),
      }),
    ];
  } catch {
    return [unknownEvent(headers, rawBody, typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"), receiptTime)];
  }
}

export const jira: ProviderAdapter = { provider: "jira", verify, toEvents };
