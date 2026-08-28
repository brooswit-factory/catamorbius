# catamorbius

A webhook → CloudEvents → SSE event gateway. It receives webhooks from
providers (Jira, GitHub; more later) and serves them as resumable SSE streams
of [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)
with lossless retention. It is provider-agnostic and standalone — no coupling
to any particular consumer.

Four thin layers: **ingress** → **normalize** → **durable log** (`bun:sqlite`;
the autoincrement `seq` is the stream cursor) → **SSE egress**.

This repo currently implements ingress, normalization, and the durable log.
SSE egress (`GET /events`) lands in a follow-up story.

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
| `CATAMORBIUS_TOKENS` | Comma-separated bearer tokens accepted by `GET /events`. Parsed here; consumed by the upcoming SSE story. |
| `CATAMORBIUS_DEV_MODE` | Set to exactly `1` to enable dev mode (see below). |

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
- **`GET /events`** — coming in the SSE story.

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

`toEvents` is expected to handle payloads it doesn't recognize itself,
emitting a single `<provider>.unknown` event with its best-effort id/source
and the raw payload intact. If it throws instead, the generic ingress layer
wraps the delivery as `<provider>.unknown` on its behalf — with source
`//<provider>/unknown`, `id` the sha256 of headers+body, and the raw payload
intact — so a delivery is never silently dropped.
