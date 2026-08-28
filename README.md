# catamorbius

A webhook → CloudEvents → SSE event gateway. It receives webhooks from
providers (Jira, GitHub; more later) and serves them as resumable SSE streams
of [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
with lossless retention. It is provider-agnostic and standalone — no coupling
to any particular consumer.

Four thin layers: **ingress** → **normalize** → **durable log** (`bun:sqlite`;
the autoincrement `seq` is the stream cursor) → **SSE egress**.

This repo implements all four layers, including SSE egress (`GET /events`).

### Cursor & durability

`seq` is unique and strictly increasing — it is safe to use as a resumable
stream cursor (`replay everything with seq > N`). It is **not** guaranteed to
be gapless: a duplicate delivery is deduped and inserts no row, but the
underlying `AUTOINCREMENT` column still reserves a value for the attempt, so
the next genuinely new event can skip a number. No events, and no consumer
guarantee, are lost either way.

## Run locally

```sh
bun install
bun run src/index.ts   # starts the server; GET /healthz should return 200
bun test                # runs the test suite
```

With no environment variables set at all, the server still starts and serves
`GET /healthz` — it just refuses any webhook whose provider secret isn't
configured (see below).

## Configuration

All configuration is via environment variables. Only variable **names** are
documented — secret values never belong in source control or in ticket
comments.

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port to listen on. Default `3000`. |
| `CATAMORBIUS_DB` | Path to the sqlite database file. Default `./data/catamorbius.sqlite`; created on start if missing. `:memory:` is allowed (non-durable, for tests/dev). |
| `WEBHOOK_SECRET_<PROVIDER>` | Per-provider webhook secret, e.g. `WEBHOOK_SECRET_GITHUB`, `WEBHOOK_SECRET_JIRA` (provider name uppercased). Used by that provider's adapter to verify deliveries. |
| `CATAMORBIUS_TOKENS` | Comma-separated bearer tokens accepted by `GET /events`. |
| `CATAMORBIUS_DEV_MODE` | Set to exactly `1` to enable dev mode (see below). |
| `CATAMORBIUS_HEARTBEAT_MS` | Milliseconds between SSE heartbeat comments on `GET /events`. Default `15000`; falls back to the default on a non-numeric or non-positive value. |

**Missing provider secret rule** (never silent, either way):
- **Default config:** a webhook for a provider with no configured secret is
  refused with `503`, and a log line names the missing env var. Nothing is
  stored. A `5xx` makes the provider retry once the secret is configured.
- **Dev mode (`CATAMORBIUS_DEV_MODE=1`):** verification is skipped entirely
  for that provider, the delivery is stored normally, and a loud `WARN` line
  is logged on every such request.

## The event format contract

Every stored/emitted event is a CloudEvents 1.0 envelope:

```ts
{
  specversion: "1.0",
  id: string,                 // required
  source: string,             // required, URI-reference: "//<provider>/<instance>"
                               //   e.g. //github/brooswit-factory, //jira/wroosbit.atlassian.net
  type: string,                // required, reverse-DNS: e.g. com.github.pull_request.opened,
                               //   com.atlassian.jira.issue.updated, or "<provider>.unknown"
                               //   for a payload the adapter (or the gateway) couldn't parse
  time: string,                // required, RFC 3339 — the provider's own timestamp when it
                               //   has one, else receipt time
  subject?: string,            // optional — the entity key, e.g. KAN-123, owner/repo#42
  datacontenttype: "application/json",
  data: {
    raw: {
      body: unknown,           // the provider payload parsed as JSON, verbatim — or the
                                //   raw body string when it does not parse
      headers: Record<string, string>, // selected delivery headers, lowercase keys —
                                        //   credential-bearing headers (authorization,
                                        //   proxy-authorization, cookie, set-cookie, and
                                        //   anything containing "signature" or "token") are
                                        //   stripped before storage on every path and are
                                        //   never written to the log
    },
    summary: {                 // every field optional; an unknown event has {} here
      actor?: string,
      action?: string,
      entity?: { kind: string; key: string; url?: string },
      title?: string,
    },
  },
}
```

Nothing beyond this attribute set exists at the top level. This is the
canonical section later provider stories extend with their own
`type`/`source`/`subject` conventions — see `src/events/types.ts` for the
TypeScript types and `src/events/index.ts` for the `createCloudEvent`
constructor and `isCloudEvent` validator.

## Endpoints

- **`POST /webhooks/<provider>`**
  - `404` — no adapter is registered for `<provider>`.
  - `503` — the provider's secret env var isn't set (default config; nothing stored).
  - `401` — signature verification failed (nothing stored).
  - `202 { events: [{ seq, id, type, duplicate }] }` — accepted. Returned for
    every successful delivery, including a duplicate redelivery of an
    already-seen event (providers stop redelivering only on a `2xx`). A
    malformed body that passes verification is still stored, as a single
    `<provider>.unknown` event.
- **`GET /healthz`** → `{ ok: true, seq: <latestSeq> }`.
- **`GET /events`** — see [SSE egress](#sse-egress-get-events) below.

## SSE egress: `GET /events`

Serves stored events as a resumable [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream. Response headers: `Content-Type: text/event-stream`, `Cache-Control:
no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no` (disables
proxy buffering so events aren't held back).

### Auth

Header auth only — `Authorization: Bearer <token>`, checked in constant time
against every token in `CATAMORBIUS_TOKENS`.

- **Missing or wrong token** → `401` with `WWW-Authenticate: Bearer`.
- **No tokens configured, default config** → `503`, and a log line names
  `CATAMORBIUS_TOKENS`. Never silent.
- **No tokens configured, `CATAMORBIUS_DEV_MODE=1`** → open (no auth check),
  with a loud `WARN` line logged on every connection. Never silent.

**Known limitation:** the native browser `EventSource` API cannot set request
headers, so it cannot supply a bearer token against this endpoint as-is.
Query-string tokens are intentionally out of scope for this pass — that's a
future ticket.

### Frame format

The first thing written on every stream is a reconnect hint:

```
retry: 3000

```

Every event after that is framed exactly as:

```
event: <type>
id: <seq>
data: <the full CloudEvents JSON, one line>

```

`data:` is `JSON.stringify(event)` — the stored CloudEvents envelope
verbatim. `seq` is not a CloudEvents attribute; it travels only in the `id:`
field, as the resume cursor.

A heartbeat comment is sent every `CATAMORBIUS_HEARTBEAT_MS` (default
`15000`) to keep the connection alive through idle periods and intermediary
timeouts:

```
: heartbeat

```

### Filters

Optional query params, ANDed together, applied identically to backfilled and
live events:

| Param | Match |
| --- | --- |
| `type` | **Prefix** match, same semantics as the store: `?type=com.github.pull_request` matches `com.github.pull_request.opened`. Case-sensitive; `_` is a literal character, never a wildcard. |
| `source` | Exact match. |
| `subject` | Exact match. |

### Cursors & resume

| Request | Behavior |
| --- | --- |
| Neither `Last-Event-ID` nor `?from` | Live only — no backfill. |
| `?from=earliest` | Replay everything, from `seq` 1, then live. |
| `?from=N` | Replay from `seq >= N` (inclusive), then live. |
| `Last-Event-ID: N` header | Replay `seq > N` (exclusive), then live. |
| Both present | **`Last-Event-ID` wins** — `?from` is ignored entirely. This is the reconnect case: a client resends the same URL and the browser/library adds the header automatically. |
| Cursor beyond the latest `seq` | Live only — not an error. |
| Non-numeric or negative cursor, either source | `400`. |

The stream is built so no event is ever missed or duplicated across the
backfill → live boundary, and every frame's `id:` on a connection is strictly
increasing. (Note: `seq` itself can have gaps — see
[Cursor & durability](#cursor--durability) — so "no gaps" here means no
*missed or duplicated events*, not contiguous `seq` numbers.)

### Consumer examples

**curl:**

```sh
curl -N -H "Authorization: Bearer $TOKEN" "http://localhost:3000/events?from=earliest"
```

**TypeScript (bun), with the [`eventsource`](https://www.npmjs.com/package/eventsource) package for header support:**

```ts
import { EventSource } from "eventsource";

const es = new EventSource("http://localhost:3000/events?from=earliest", {
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${process.env.TOKEN}` } }),
});

es.addEventListener("com.github.pull_request.opened", (event) => {
  console.log(event.lastEventId, JSON.parse(event.data));
});
```

## Adding a provider

Add one file to `src/adapters/` implementing the `ProviderAdapter` contract,
and one line registering it in `src/adapters/index.ts`. No other file needs
to change.

```ts
interface ProviderAdapter {
  provider: string; // "github" -> mounted at POST /webhooks/github;
                     // secret from env WEBHOOK_SECRET_<PROVIDER uppercased>
  verify(headers: Record<string, string>, rawBody: string | Uint8Array, secret: string):
    { ok: true } | { ok: false; reason: string };
  toEvents(rawBody: string | Uint8Array, headers: Record<string, string>): CloudEvent[];
}
```

`toEvents` is expected to handle payloads it doesn't recognize itself,
emitting a single `<provider>.unknown` event with its best-effort id/source
and the raw payload intact. If it throws instead, the generic ingress layer
wraps the delivery as `<provider>.unknown` on its behalf — with source
`//<provider>/unknown`, `id` the sha256 of headers+body, and the raw payload
intact — so a delivery is never silently dropped.
