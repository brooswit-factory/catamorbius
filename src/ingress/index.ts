import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { createCloudEvent, isCloudEvent, type CloudEvent } from "../events/index.js";
import type { ProviderAdapter } from "../adapters/types.js";
import type { Config } from "../config.js";
import type { Store } from "../store/index.js";

const REDACTED_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/** Drops credential-bearing headers before anything is stored — never applied to what verify() sees. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (REDACTED_HEADER_NAMES.has(lower) || lower.includes("signature") || lower.includes("token")) continue;
    out[name] = value;
  }
  return out;
}

function sha256Hex(headers: Record<string, string>, body: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(headers));
  hash.update(body);
  return hash.digest("hex");
}

/** Generic fallback for a delivery an adapter could not (or did not) make sense of. */
function wrapUnknown(provider: string, rawBody: Uint8Array, headers: Record<string, string>): CloudEvent {
  const text = Buffer.from(rawBody).toString("utf8");
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }

  return createCloudEvent({
    id: sha256Hex(headers, rawBody),
    source: `//${provider}/unknown`,
    type: `${provider}.unknown`,
    time: new Date().toISOString(),
    raw: { body, headers: redactHeaders(headers) },
  });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

export interface IngressDeps {
  config: Config;
  store: Store;
  adapters: ProviderAdapter[];
}

/** POST /webhooks/:provider — mounts every registered adapter with no provider-specific code. */
export function buildIngress({ config, store, adapters }: IngressDeps) {
  const byProvider = new Map(adapters.map((a) => [a.provider, a] as const));

  return new Elysia().post("/webhooks/:provider", async ({ params, request, set }) => {
    const adapter = byProvider.get(params.provider);
    if (!adapter) {
      set.status = 404;
      return { error: `unknown provider "${params.provider}"` };
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const headers = headersToObject(request.headers);
    const envVar = `WEBHOOK_SECRET_${adapter.provider.toUpperCase()}`;
    const secret = config.secretFor(adapter.provider);

    if (secret === undefined) {
      if (config.devMode) {
        console.warn(`[catamorbius] WARN dev mode: ${envVar} is not set — skipping verification for provider "${adapter.provider}"`);
      } else {
        console.error(`[catamorbius] refusing webhook for provider "${adapter.provider}": ${envVar} is not set`);
        set.status = 503;
        return { error: `missing secret ${envVar}` };
      }
    } else {
      const result = adapter.verify(headers, rawBody, secret);
      if (!result.ok) {
        console.error(`[catamorbius] webhook verification failed for provider "${adapter.provider}": ${result.reason}`);
        set.status = 401;
        return { error: result.reason };
      }
    }

    let events: CloudEvent[];
    try {
      const produced = adapter.toEvents(rawBody, headers);
      if (!produced.every(isCloudEvent)) {
        throw new Error(`adapter "${adapter.provider}" returned a non-conforming CloudEvent`);
      }
      events = produced.map((event) => ({
        ...event,
        data: { ...event.data, raw: { ...event.data.raw, headers: redactHeaders(event.data.raw.headers) } },
      }));
    } catch {
      // Either toEvents threw, or it returned something that isn't a valid
      // CloudEvent — an adapter failure must never surface as a 5xx, since
      // that would make the provider retry forever with the event never
      // entering the log. Store the delivery generically instead.
      events = [wrapUnknown(adapter.provider, rawBody, headers)];
    }

    const results = events.map((event) => {
      const { seq, duplicate } = store.append(event);
      return { seq, id: event.id, type: event.type, duplicate };
    });

    set.status = 202;
    return { events: results };
  });
}
