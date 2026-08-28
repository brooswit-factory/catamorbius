import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createCloudEvent } from "../events/index.js";
import type { CloudEvent, CloudEventEntity, CloudEventSummary } from "../events/types.js";
import type { ProviderAdapter, VerifyResult } from "./types.js";

const SIGNATURE_HEADER = "x-hub-signature-256";
const DELIVERY_HEADER = "x-github-delivery";
const EVENT_HEADER = "x-github-event";
const SIGNATURE_PREFIX = "sha256=";

// Nested entities checked most-specific-first when deriving a documented
// timestamp (see timeFor) — e.g. a comment's own timestamp beats the issue
// it was posted on.
const TIMESTAMP_ENTITY_KEYS = ["comment", "review", "pull_request", "issue", "release", "repository"] as const;
const TIMESTAMP_FIELDS = ["updated_at", "submitted_at", "published_at", "created_at"] as const;

function toBuffer(body: string | Uint8Array): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * HMAC-SHA256 over the exact raw body bytes, hex digest compared
 * constant-time against `x-hub-signature-256: sha256=<hex>`. See
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries.
 * The legacy sha1 `x-hub-signature` header is ignored entirely. Never throws.
 */
function verify(headers: Record<string, string>, rawBody: string | Uint8Array, secret: string): VerifyResult {
  try {
    const header = headers[SIGNATURE_HEADER];
    if (header === undefined) return { ok: false, reason: `missing ${SIGNATURE_HEADER} header` };
    if (!header.startsWith(SIGNATURE_PREFIX)) {
      return { ok: false, reason: `${SIGNATURE_HEADER} header is not prefixed "${SIGNATURE_PREFIX}"` };
    }
    const hex = header.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      return { ok: false, reason: `${SIGNATURE_HEADER} header value is not valid hex` };
    }
    const expected = createHmac("sha256", secret).update(toBuffer(rawBody)).digest();
    if (hex.length !== expected.length * 2) {
      return { ok: false, reason: `${SIGNATURE_HEADER} header hex is the wrong length` };
    }
    const provided = Buffer.from(hex, "hex");
    if (!timingSafeEqual(provided, expected)) {
      return { ok: false, reason: "signature does not match" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function deliveryId(headers: Record<string, string>, rawBody: string | Uint8Array): string {
  const delivery = headers[DELIVERY_HEADER];
  if (delivery) return delivery;
  return createHash("sha256").update(JSON.stringify(headers)).update(toBuffer(rawBody)).digest("hex");
}

/** Headers retained in `data.raw.headers`: x-github-* plus content-type/user-agent — never the signature headers. */
function retainedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith("x-github-") || name === "content-type" || name === "user-agent") out[name] = value;
  }
  return out;
}

function ownerLogin(body: Record<string, unknown>): string | undefined {
  const repository = body.repository;
  if (isRecord(repository) && isRecord(repository.owner) && typeof repository.owner.login === "string") {
    return repository.owner.login;
  }
  const organization = body.organization;
  if (isRecord(organization) && typeof organization.login === "string") return organization.login;
  const installation = body.installation;
  if (isRecord(installation) && isRecord(installation.account) && typeof installation.account.login === "string") {
    return installation.account.login;
  }
  return undefined;
}

function sourceFor(body: unknown): string {
  const owner = isRecord(body) ? ownerLogin(body) : undefined;
  return `//github/${owner ?? "unknown"}`;
}

function typeFor(eventName: string, body: unknown): string {
  const action = isRecord(body) && typeof body.action === "string" ? body.action : undefined;
  return action ? `com.github.${eventName}.${action}` : `com.github.${eventName}`;
}

function toRfc3339(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function entityTimestamp(body: Record<string, unknown>): unknown {
  for (const key of TIMESTAMP_ENTITY_KEYS) {
    const entity = body[key];
    if (!isRecord(entity)) continue;
    for (const field of TIMESTAMP_FIELDS) {
      if (field in entity) return entity[field];
    }
  }
  return undefined;
}

function timeFor(body: unknown, receiptTime: string): string {
  if (!isRecord(body)) return receiptTime;
  const headCommit = body.head_commit;
  if (isRecord(headCommit) && "timestamp" in headCommit) {
    const t = toRfc3339(headCommit.timestamp);
    if (t) return t;
  }
  return toRfc3339(entityTimestamp(body)) ?? receiptTime;
}

/** `<full_name>#<number>` for a PR/issue, `<full_name>@<ref>` for a push, else `<full_name>`, else undefined. */
function subjectFor(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const repository = body.repository;
  const fullName = isRecord(repository) && typeof repository.full_name === "string" ? repository.full_name : undefined;

  const numbered = isRecord(body.pull_request) ? body.pull_request : isRecord(body.issue) ? body.issue : undefined;
  if (fullName && numbered && typeof numbered.number === "number") return `${fullName}#${numbered.number}`;
  if (fullName && typeof body.ref === "string") return `${fullName}@${body.ref}`;
  return fullName;
}

function entityFor(eventName: string, body: Record<string, unknown>, subject: string | undefined): CloudEventEntity | undefined {
  if (!subject) return undefined;
  let kind: string;
  let url: unknown;
  if (isRecord(body.pull_request)) { kind = "pull_request"; url = body.pull_request.html_url; }
  else if (isRecord(body.issue)) { kind = "issue"; url = body.issue.html_url; }
  else if (typeof body.ref === "string") { kind = "push"; url = isRecord(body.repository) ? body.repository.html_url : undefined; }
  else if (isRecord(body.repository)) { kind = "repository"; url = body.repository.html_url; }
  else { kind = eventName; url = undefined; }
  return { kind, key: subject, ...(typeof url === "string" ? { url } : {}) };
}

function titleFor(body: Record<string, unknown>): string | undefined {
  if (isRecord(body.pull_request) && typeof body.pull_request.title === "string") return body.pull_request.title;
  if (isRecord(body.issue) && typeof body.issue.title === "string") return body.issue.title;
  if (isRecord(body.head_commit) && typeof body.head_commit.message === "string") {
    return body.head_commit.message.split("\n")[0];
  }
  if (isRecord(body.repository) && typeof body.repository.full_name === "string") return body.repository.full_name;
  return undefined;
}

function summaryFor(eventName: string, body: unknown, subject: string | undefined): CloudEventSummary {
  if (!isRecord(body)) return {};
  const actor = isRecord(body.sender) && typeof body.sender.login === "string" ? body.sender.login : undefined;
  const action = typeof body.action === "string" ? body.action : eventName;
  const entity = entityFor(eventName, body, subject);
  const title = titleFor(body);
  return {
    ...(actor !== undefined ? { actor } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(entity !== undefined ? { entity } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

function unknownEvent(headers: Record<string, string>, rawBody: string | Uint8Array, body: unknown, receiptTime: string): CloudEvent {
  return createCloudEvent({
    id: deliveryId(headers, rawBody),
    source: "//github/unknown",
    type: "com.github.unknown",
    time: receiptTime,
    raw: { body, headers: retainedHeaders(headers) },
  });
}

/**
 * Mechanically types every GitHub delivery — no allowlist of event names.
 * An unrecognizable delivery (no x-github-event header, or a body that
 * isn't JSON) is stored as a single com.github.unknown event. Never throws.
 */
function toEvents(rawBody: string | Uint8Array, headers: Record<string, string>): CloudEvent[] {
  const receiptTime = new Date().toISOString();
  try {
    const retained = retainedHeaders(headers);
    const eventName = headers[EVENT_HEADER];
    const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");

    let body: unknown;
    let parsed = true;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
      parsed = false;
    }

    if (!eventName || !parsed) {
      return [unknownEvent(headers, rawBody, body, receiptTime)];
    }

    const subject = subjectFor(body);
    return [
      createCloudEvent({
        id: deliveryId(headers, rawBody),
        source: sourceFor(body),
        type: typeFor(eventName, body),
        time: timeFor(body, receiptTime),
        ...(subject !== undefined ? { subject } : {}),
        raw: { body, headers: retained },
        summary: summaryFor(eventName, body, subject),
      }),
    ];
  } catch {
    return [unknownEvent(headers, rawBody, typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"), receiptTime)];
  }
}

export const github: ProviderAdapter = { provider: "github", verify, toEvents };
