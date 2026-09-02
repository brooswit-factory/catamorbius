# catamorbius

A webhook → CloudEvents → SSE event gateway. It receives webhooks from
providers (Jira, GitHub; more later) and serves them as resumable SSE streams
of [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
with lossless retention. It is provider-agnostic and standalone — no coupling
to any particular consumer.

Four thin layers: **ingress** → **normalize** → **durable log** (`bun:sqlite`;
the autoincrement `seq` is the stream cursor) → **SSE egress**.

This repo implements all four layers, including SSE egress (`GET /events`).

## Durability and cursor semantics

The event log (`src/store`, `bun:sqlite`) is **append-only**: nothing is ever
updated or deleted, and every accepted delivery becomes exactly one row (or,
on a duplicate, no new row — see below).

**Retention policy: none in v0.1 — everything is kept forever.** There is no
expiry, pruning, or archival of any kind; the sqlite file grows without bound
for the life of a deployment. A retention/pruning policy is out of scope for
this pass.

`seq` (the table's `AUTOINCREMENT` primary key) is the stream cursor: it is
unique and strictly increasing, so `replay everything with seq > N` is a
safe, total resume rule. It is **not** guaranteed to be gapless: a duplicate
delivery is deduped (`INSERT OR IGNORE` on the `(source, id)` unique
constraint) and inserts no row, but the underlying `AUTOINCREMENT` column
still reserves a value for the attempt, so the next genuinely new event can
skip a number. No events, and no consumer guarantee, are lost either way.

**Resume guarantees** (full precedence table under
[Cursors & resume](#cursors--resume)): `Last-Event-ID: N` replays `seq > N`;
`?from=earliest` replays from `seq` 1; `?from=N` replays `seq >= N`;
`Last-Event-ID` wins when both are present. The stream is built so no event
is ever missed or duplicated across the backfill → live boundary — "no gaps"
there means no *missed or duplicated events*, never contiguous `seq` numbers.

**Known limitation — backfill is not backpressured in v0.1.** `GET /events`
pages the backfill in batches of 500 rows (`src/egress/index.ts`), but it
enqueues every page synchronously inside the stream's `start()` callback,
with no check of the `ReadableStreamDefaultController`'s `desiredSize` and no
`await` between pages. Against a large log, `?from=earliest` (or any cursor
far behind the head) holds the *entire* backfill in the stream's internal
queue before backpressure gets any chance to apply. This is an accepted
limitation for v0.1, not a bug to chase here: a `pull()`-driven,
backpressure-aware backfill is a future ticket.

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

| Variable | Meaning | Default | Required |
| --- | --- | --- | --- |
| `PORT` | HTTP port to listen on. | `3000` | Optional |
| `HOST` | Interface to bind. | every interface | Optional |
| `CATAMORBIUS_DB` | Path to the sqlite database file; created on start if missing. `:memory:` is allowed (non-durable, for tests/dev). | `./data/catamorbius.sqlite` | Optional |
| `WEBHOOK_SECRET_<PROVIDER>` | Per-provider webhook secret, e.g. `WEBHOOK_SECRET_GITHUB`, `WEBHOOK_SECRET_JIRA` (provider name uppercased — `src/config.ts`'s `secretFor`). Used by that provider's adapter to verify deliveries. | none | Optional per provider — see the missing-secret rule below; a provider with no secret configured refuses its webhooks with `503` by default. |
| `CATAMORBIUS_TOKENS` | Comma-separated bearer tokens accepted by `GET /events`. | none (empty) | Optional — see [Auth](#auth); with none configured, `GET /events` refuses with `503` by default. |
| `CATAMORBIUS_DEV_MODE` | Set to exactly `1` to enable dev mode (see below). Any other value, including unset, is normal mode. | off | Optional |
| `CATAMORBIUS_HEARTBEAT_MS` | Milliseconds between SSE heartbeat comments on `GET /events`. Falls back to the default on a non-numeric or non-positive value. | `15000` | Optional |

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
                               //   com.atlassian.jira.issue.updated. A delivery the adapter
                               //   itself cannot make sense of is typed com.github.unknown /
                               //   com.atlassian.jira.unknown — see each provider's subsection
                               //   below. The bare "<provider>.unknown" (no reverse-DNS prefix)
                               //   is a different, rarer fallback: the generic ingress
                               //   throw-guard's type, used only if an adapter itself throws or
                               //   returns a non-conforming event — see Endpoints below.
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

### GitHub

The `github` adapter (`src/adapters/github.ts`) types every GitHub webhook
delivery mechanically — there is no allowlist of event names anywhere in
the file, so an event GitHub adds tomorrow is typed correctly today.

- **Verification** — HMAC-SHA256 over the exact raw request body bytes,
  hex digest, compared constant-time (`node:crypto`'s `timingSafeEqual`)
  against the `x-hub-signature-256: sha256=<hex>` header, per
  [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
  The legacy sha1 `x-hub-signature` header is ignored entirely — its
  presence alone never authenticates a delivery. A missing header, a
  header not prefixed `sha256=`, non-hex characters, hex of the wrong
  length, and a correct-length-but-wrong digest each fail with a distinct
  reason; verification never throws.
- **`id`** — the `x-github-delivery` header (GitHub's per-delivery GUID;
  redeliveries reuse it, which is what makes dedupe work). If that header
  is absent, the sha256 hex of the headers and body.
- **`source`** — `//github/<owner>`, where `<owner>` is
  `body.repository.owner.login`, else `body.organization.login`, else
  `body.installation.account.login`, else `//github/unknown`.
  **Caveat:** when none of those fields is present, every such delivery
  falls back to the single shared `//github/unknown` source regardless of
  which organization actually sent it; the `(source, id)` dedupe key could
  then in principle collide across two different organizations' owner-less
  deliveries. No code change is planned for v0.1 — stated here as a known,
  accepted caveat of the fallback path, not the common case.
- **`type`** — `com.github.<x-github-event>`, plus `.<body.action>` when
  `body.action` is a string. So `pull_request` + `opened` becomes
  `com.github.pull_request.opened`; `push` (no action) becomes
  `com.github.push`; an event name this code has never heard of, say
  `x-github-event: some_future_thing` with `action: "did"`, becomes
  `com.github.some_future_thing.did` — fully typed, raw intact, zero
  bespoke code.
- **`time`** — the most specific documented timestamp the delivery
  carries (e.g. `head_commit.timestamp` for `push`, or the most specific
  entity's `updated_at` / `submitted_at` / `published_at` / `created_at`
  otherwise), normalized to RFC 3339. Falls back to receipt time when no
  such timestamp is present or it fails to parse.
- **`subject`** — `<repository.full_name>#<number>` when `body.pull_request`
  or `body.issue` is present (e.g. `owner/repo#42`); else
  `<repository.full_name>@<ref>` for a push (e.g.
  `owner/repo@refs/heads/main`); else `body.repository.full_name` when
  present; else `undefined`.
- **`summary`** — all fields best-effort: `actor` is `body.sender.login`;
  `action` is `body.action` or else the event name; `entity` is derived
  from whichever of `pull_request` / `issue` / a push `ref` /
  `repository` the body carries (`kind`, `key` = the subject, `url` =
  that entity's `html_url`); `title` is the pull request's or issue's
  title, else the first line of `head_commit.message`, else the
  repository's `full_name`.
- **Retained headers** — `data.raw.headers` keeps only headers starting
  with `x-github-` (delivery, event, hook-id, hook-installation-target-id,
  hook-installation-target-type, ...) plus `content-type` and
  `user-agent`. The signature headers (`x-hub-signature`,
  `x-hub-signature-256`) are never retained.
- **Unrecognizable deliveries** — a delivery with no `x-github-event`
  header, or a body that isn't JSON, is stored as a single
  `com.github.unknown` event (`id` per the rule above, `source`
  `//github/unknown`, `data.raw.body` the parsed JSON or the raw body
  string, headers retained per the allowlist). `toEvents` never throws.

Fixture provenance: every payload under `test/fixtures/github/` is written
from field shapes GitHub documents (top-level event fields and action
values from https://docs.github.com/en/webhooks/webhook-events-and-payloads;
nested entity shapes from the corresponding REST API reference pages), and
`test/fixtures/github/README.md` cites the exact doc URL(s) each fixture
was taken from — nothing is invented from memory.

**Register a GitHub webhook** — content type `application/json`, secret =
`WEBHOOK_SECRET_GITHUB`. Subscribe to whichever events your consumers need;
this adapter accepts and types every one of them, so there is no minimum
subscription list to satisfy the gateway itself.

### Jira

The `jira` provider adapter (`src/adapters/jira.ts`) is implemented
strictly against [`docs/jira-webhooks.md`](docs/jira-webhooks.md), an
investigation of what Atlassian's Jira Cloud webhooks docs actually
document — read that file for the full quotes and citations. Summary,
marked confirmed vs. assumed the same way that document does:

- **Verification (CONFIRMED)** — an admin-registered Jira Cloud webhook
  (Jira Administration UI, or `POST /rest/webhooks/1.0/webhook`) that
  carries a `secret` has Jira HMAC the raw request body and send it as
  `X-Hub-Signature: <method>=<hex>` (WebSub-style). Atlassian's docs warn
  the method may change, so the adapter reads `method` out of the header
  rather than assuming `sha256=`; today `sha256` is the only method it
  accepts; an unrecognized method fails with a reason, never a silent
  pass. The HMAC is computed over the exact raw bytes and compared to the
  header's hex digest in constant time (`node:crypto`'s `timingSafeEqual`,
  with the lengths checked first so it can never throw). `WEBHOOK_SECRET_JIRA`
  is the secret configured on the Jira side; the missing-secret 503/dev-mode
  rule above applies exactly as for any other provider.
- **Delivery id (CONFIRMED)** — every delivery carries
  `X-Atlassian-Webhook-Identifier`, documented as unique within a Jira
  Cloud tenant and stable across Jira's own retries. It is used directly
  as the CloudEvent `id`; dedupe is on the pair `(source, id)`, and when a
  site host is derivable `source` already encodes the tenant, so
  cross-tenant collision isn't a concern in that common case (see the
  `source`-derivation caveat below for the fallback case). When the header
  is absent, the adapter falls back to a
  deterministic SHA-256 over `(webhookEvent, timestamp, issue.id or
  comment.id, raw body)` — the same body always derives the same id.
- **`source`** — `//jira/<site host>`, the host taken from the payload's
  own `self` URL (`issue.self`, then `user.self`, `comment.self`,
  `project.self`); `//jira/unknown` when none is present or parseable. No
  environment variable names the site — catamorbius never needs to know it
  ahead of time.
  **Caveat:** when no `self` URL is present or parseable, every such
  delivery falls back to the single shared `//jira/unknown` source
  regardless of which Jira Cloud site actually sent it; the `(source, id)`
  dedupe key could then in principle collide across tenants for these
  host-less event families. No code change is planned for v0.1 — stated
  here as a known, accepted caveat of the fallback path only.
- **`type` (mechanical, no allowlist)** — `webhookEvent` has an optional
  `jira:` prefix stripped, `_` replaced with `.`, and
  `com.atlassian.jira.` prefixed: `jira:issue_updated` →
  `com.atlassian.jira.issue.updated`; `comment_created` →
  `com.atlassian.jira.comment.created`. A `webhookEvent` value this code
  has never seen types just as mechanically — there is no list of known
  event names anywhere in the adapter. A missing `webhookEvent`, or a body
  that isn't valid JSON at all, becomes one `com.atlassian.jira.unknown`
  event with the raw payload retained; `toEvents` never throws.
- **`time`** — `body.timestamp` (epoch milliseconds) as RFC 3339, but only
  when the millis interpretation is *plausible*: on or after 2000-01-01,
  and no more than a day in the future of receipt time
  (`src/adapters/jira.ts` `deriveTime`'s plausibility window). Otherwise —
  including a syntactically valid but implausible number, e.g. a
  seconds-epoch value like `1606480436` (which lands in 1970 when read as
  millis) — it falls back to receipt time rather than emitting a bogus
  date. The docs never state the unit in prose — **UNDOCUMENTED**, inferred
  from the one example value in Atlassian's docs (`1606480436302`, which is
  only sane as milliseconds); the plausibility window is a sanity check
  layered on top of that inference, not a new claim about the unit itself.
- **`subject`** — `issue.key` when the body carries an `issue` (this
  covers `comment_*`/`worklog_*` payloads too, when they happen to include
  one); else `project.key`; else `sprint.id` / `version.id` / `board.id`
  as a string; else omitted.
- **Does a `comment_*`/`worklog_*` payload carry a top-level `issue`
  object? UNDOCUMENTED.** Atlassian's docs never say either way. The
  adapter hedges: it works whether `issue` is present or absent, and the
  fixtures cover both shapes.
- **`data.raw.headers`** retains `content-type`, `user-agent`, and the
  documented `x-atlassian-*` headers; it never retains anything whose name
  contains `signature` or `token` — the adapter drops those itself, ahead
  of (and independent from) the generic redaction ingress already applies
  to every provider.

#### Register a Jira Cloud webhook

In the target Jira Cloud site, go to **Settings → System → WebHooks** (or
use `POST /rest/webhooks/1.0/webhook` directly) and register a webhook
pointing at `https://<your catamorbius host>/webhooks/jira`. Pick the
events it should fire for from Jira's documented catalog (issue, comment,
worklog, sprint, board, version, project, user, and more). Set the
webhook's **secret** to the same value you configure as
`WEBHOOK_SECRET_JIRA` on catamorbius — this is what Jira uses to HMAC-sign
each delivery, and what catamorbius uses to verify it. No other
configuration (URL query params, custom headers) is needed or used.

## Endpoints

### `POST /webhooks/<provider>`

The generic webhook-ingestion route; every provider adapter mounts under it
via its `provider` field (`src/adapters/index.ts`). Today that's exactly two
concrete instances, and the one detail most likely to trip up a new
integrator is that their signature headers are **not** the same shape:

- **`POST /webhooks/github`** — verifies `X-Hub-Signature-256: sha256=<hex>`
  (see [GitHub](#github) above). Dedupes on `X-GitHub-Delivery`, GitHub's
  per-delivery GUID — redeliveries reuse the same header value, which is
  what lets the `(source, id)` dedupe key catch a redelivery.
- **`POST /webhooks/jira`** — verifies the WebSub-style
  `X-Hub-Signature: <method>=<hex>` — **no `-256`** in the header name, and
  the hex is prefixed with the method name rather than always `sha256=`
  (see [Jira](#jira) above). Dedupes on `X-Atlassian-Webhook-Identifier`,
  documented as unique within a Jira Cloud tenant and stable across Jira's
  own retries.

**Status codes**, identical across every provider:

| Status | Meaning |
| --- | --- |
| `404` | No adapter is registered for `<provider>`. |
| `503` | The provider's secret env var isn't set (default config; nothing stored). See [Configuration](#configuration). |
| `401` | Signature verification failed (nothing stored). |
| `202 { events: [{ seq, id, type, duplicate }] }` | Accepted. One entry per event the delivery produced (normally one). Returned for every successful delivery, including a duplicate redelivery of an already-seen event (`duplicate: true`, same `seq` as the original) — providers stop redelivering only on a `2xx`, so accept-and-dedupe is required, not optional. |

A delivery that passes verification but that the adapter cannot make sense of
(a foreign event name, a non-JSON body) is **not** an error — it is still
stored and returned as `202`, typed `com.github.unknown` /
`com.atlassian.jira.unknown` (see each provider's "Unrecognizable
deliveries" bullet above). The generic `<provider>.unknown` type is a
different, rarer path: it only fires if an adapter's `toEvents` itself
throws or returns something that isn't a valid CloudEvent, which neither
shipped adapter does — see [Adding a provider](#adding-a-provider).

**Worked example (GitHub):**

```sh
BODY='{"action":"opened","number":42,"pull_request":{"...":"..."},"repository":{"...":"..."}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET_GITHUB" | sed 's/^.* //')"
curl -i -X POST "http://localhost:3000/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: 72d3162e-cc78-11e3-81ab-4c9367dc0958" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
# -> 202 {"events":[{"seq":1,"id":"72d3162e-cc78-11e3-81ab-4c9367dc0958","type":"com.github.pull_request.opened","duplicate":false}]}
```

**Worked example (Jira):**

```sh
BODY='{"webhookEvent":"jira:issue_updated","issue":{"...":"..."}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET_JIRA" | sed 's/^.* //')"
curl -i -X POST "http://localhost:3000/webhooks/jira" \
  -H "Content-Type: application/json" \
  -H "X-Atlassian-Webhook-Identifier: 1a2b3c4d-5e6f-...-webhook" \
  -H "X-Hub-Signature: $SIG" \
  -d "$BODY"
# -> 202 {"events":[{"seq":2,"id":"1a2b3c4d-5e6f-...-webhook","type":"com.atlassian.jira.issue.updated","duplicate":false}]}
```

### `GET /healthz`

`{ ok: true, seq: <latestSeq> }` — `seq` is the log's current highest `seq`
(`0` on an empty log).

### `GET /events`

See [SSE egress](#sse-egress-get-events) below.

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
[Durability and cursor semantics](#durability-and-cursor-semantics) — so
"no gaps" here means no *missed or duplicated events*, not contiguous `seq`
numbers. See also that section's note on backfill not being backpressured
in v0.1.)

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

See [`docs/jira-webhooks.md`](docs/jira-webhooks.md) for the Jira Cloud
provider's research contract (verification, delivery-id dedupe, event
catalog, headers) — the document a `jira` adapter is implemented against.

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

`toEvents` must never throw, and is expected to handle payloads it doesn't
recognize itself — GitHub and Jira both do this by emitting a single event
in their own fully-qualified "unknown" type (`com.github.unknown` /
`com.atlassian.jira.unknown`; see each provider's "Unrecognizable
deliveries" bullet above) with best-effort id/source and the raw payload
intact. The bare `<provider>.unknown` type (literally that string, no
reverse-DNS prefix) is a different, narrower thing: it's the type the
generic ingress layer's throw-guard uses **on an adapter's behalf**, if
`toEvents` itself throws, *or* returns something that fails the CloudEvent
shape check (`isCloudEvent` in `src/events/index.ts`) — with source
`//<provider>/unknown`, `id` the sha256 of headers+body, and the raw
payload intact, so a delivery is never silently dropped even when an
adapter is broken. Neither shipped adapter ever exercises this fallback
path.

A new provider must register in `src/adapters/index.ts` and nowhere else —
in particular, it must not touch `src/ingress/index.ts`, `src/egress/index.ts`,
or `src/store/index.ts`, all of which are already provider-agnostic. Add
fixtures under `test/fixtures/<provider>/` (cite the documentation each one
was taken from, the way `test/fixtures/github/README.md` and
`test/fixtures/jira/README.md` do) and unit tests under
`test/unit/adapters/`, following the GitHub and Jira adapters as worked
examples.

## Testing and the gate stack

`bun run check` is the full local gate (mirrored by CI's `check` job):

```sh
bun run generate   # regenerates test/load — one load test per src/** and scripts/** file
bun run typecheck  # tsc --noEmit
bun test test/unit test/load test/live test/e2e
bun run scripts/coverage/gate.ts                   # coverage gate
bun run scripts/verify-generated-is-committed.ts   # test/load must already be committed and current
```

- **`test/unit`** — adapter, ingress, egress, and store unit tests against
  fixtures (`test/fixtures/github`, `test/fixtures/jira`), each fixture
  citing the exact provider documentation it was taken from.
- **`test/load`** — **generated**, one load test per file under `src/**` and
  `scripts/**` (`scripts/load/generate.ts`), proving every source file is
  loadable — or, for entry-point scripts that run side effects on import,
  that it parses and its relative imports resolve. Never hand-edit files
  under `test/load/`: regenerate with `bun run generate` and commit the
  result. `scripts/verify-generated-is-committed.ts` fails the gate if
  `git status --porcelain -- test/load` is non-empty.
- **`test/live`** — a real `eventsource` client against a real server,
  proving SSE resume across an actual disconnect/reconnect, filtered live
  delivery, an on-the-wire heartbeat, and the auth matrix.
- **`test/e2e`** (`test/e2e/gateway.test.ts`) — one end-to-end scenario
  driving a real local server over real HTTP, with the real registered
  adapters and a real `eventsource` client, using only committed fixtures.
  Proves, in order: subscribing from `earliest`; six documented-shape
  deliveries (both providers) arriving in `seq` order with exact type/id and
  lossless `data.raw.body` retention; unknown-event retention (a foreign
  event name and a non-JSON body, per provider) with the raw payload
  retained verbatim; dedupe; resume across a real disconnect/reconnect with
  no gaps or duplicate ids; `?type=`/`?subject=` filters; and the negative
  paths (bad signature → `401`, wrong bearer token → `401`).
- **Coverage gate** (`scripts/coverage/gate.ts`) — reads `coverage/lcov.info`
  and fails the build under **90% lines AND 90% functions**. `bunfig.toml`'s
  `coveragePathIgnorePatterns: ["test/**"]` excludes every file under
  `test/` — including the generated `test/load` suite — from the coverage
  measurement itself; the gate is over `src/**` and `scripts/**`.
- **`bun run smoke`** (`scripts/smoke.ts`) — a human-run, non-CI script that
  walks the same proof as `test/e2e` against a live server you point it at,
  printing each SSE frame as it arrives and exiting non-zero on the first
  thing that doesn't check out:

  ```sh
  CATAMORBIUS_URL=http://localhost:3000 \
  CATAMORBIUS_TOKENS=<token> WEBHOOK_SECRET_GITHUB=<secret> WEBHOOK_SECRET_JIRA=<secret> \
  bun run smoke
  ```

  It is not part of `bun run check` or CI — nothing in the gate depends on
  it. It's a tool for a human to sanity-check a running deployment by hand.
  It's excluded from the coverage denominator via `RUNS_ON_IMPORT`, and its
  generated load test is committed like any other source file's.

CI additionally runs `bun run build` (`bun build src/index.ts --outdir dist
--target bun`) to confirm the entry point bundles cleanly.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full history of changes, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## Deployment

Deployment: not covered in v0.1; see a future ticket. A systemd user-unit
template and environment-file template live in [`deploy/`](deploy/) in the
meantime.
