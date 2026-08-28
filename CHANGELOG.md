# Changelog

All notable changes to `catamorbius`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.
The release gate runs only on PRs whose base is `main`; task PRs into a story branch run `check` only. A story ships main exactly one semver step, regardless of how many task PRs it contains.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

## [0.0.3] - 2026-08-28
### Added
- `docs/jira-webhooks.md`: investigation of Jira Cloud webhook request verification, per-delivery-id dedupe, the documented event catalog and envelope, and delivery headers, against Atlassian's current documentation. CONFIRMED: admin/`/rest/webhooks/1.0/webhook` secret → HMAC-SHA256 `X-Hub-Signature` header (directly usable, no custom header needed); `X-Atlassian-Webhook-Identifier` is stable across retries (usable directly as CloudEvent `id`); the full `webhookEvent` catalog and common envelope. UNDOCUMENTED: `timestamp` unit is only inferable from the example value, not stated; whether `comment_*`/`worklog_*` payloads carry a top-level `issue` object; delivery `Content-Type`/`User-Agent`.
- `src/adapters/jira.ts`, registered in `src/adapters/index.ts`: the `jira` provider adapter, implemented strictly against `docs/jira-webhooks.md`. `verify` reads the HMAC method out of the WebSub-style `X-Hub-Signature: <method>=<hex>` header rather than assuming `sha256=`, hashes the exact raw body, and constant-time compares (an unsupported method is a verification failure, never a pass). `id` uses `X-Atlassian-Webhook-Identifier` directly when present, else a deterministic SHA-256 over `(webhookEvent, timestamp, issue.id or comment.id, raw body)`. `type` is derived mechanically from `webhookEvent` with no allowlist of event names. `source` is `//jira/<site host>` from the payload's own `self` URLs, else `//jira/unknown`. An unparseable or `webhookEvent`-less delivery becomes a single `com.atlassian.jira.unknown` event with the raw payload retained; `toEvents` never throws.
- `test/fixtures/jira/`: JSON fixtures for `jira:issue_created`/`_updated`/`_deleted`, `comment_created`/`_updated`, `worklog_created` (each of the latter two families in both a with- and without-top-level-`issue` shape, per the documented hedge), a deliberately foreign `webhookEvent` value, a non-JSON body, and known-good/known-bad HMAC verification vectors — every fixture cites the Atlassian doc page or REST schema it was taken from in `test/fixtures/jira/README.md`.
- `test/unit/adapters/jira.test.ts` and `test/unit/adapters/jira-ingress.test.ts`: unit coverage of every fixture through `toEvents` (id/source/type/time/subject/summary exactly, `raw.body` deep-equal), the mechanical foreign-event typing, the non-JSON and no-`webhookEvent` unknown-event paths, id determinism, header retention, and every `verify()` fixture; an ingress-level suite through the real Elysia server proving 202/duplicate dedupe, 401 on bad signature, and the 503/dev-mode missing-secret rule for the `jira` provider specifically.
- README: a "Jira" subsection under the event format contract documenting the verification mechanism, id/source/type/time/subject/summary derivation, and what remains undocumented vs. confirmed (mirroring `docs/jira-webhooks.md`), plus a "Register a Jira Cloud webhook" configuration paragraph.

## [0.0.2] - 2026-08-28
### Added
- GitHub provider adapter (`src/adapters/github.ts`, registered in `src/adapters/index.ts`): HMAC-SHA256 signature verification (constant-time, distinct failure reasons, sha1 header ignored) and fully mechanical CloudEvents typing (`id`/`source`/`type`/`time`/`subject`/`summary`) with no allowlist of event names — an unrecognized event name types correctly with zero bespoke code.
- `test/fixtures/github/`: documented-shape payload fixtures (ping, push, pull_request opened/closed-merged, issues.opened, issue_comment.created, pull_request_review.submitted, release.published, a deliberately foreign event, and a non-JSON body), each fixture citing the exact GitHub documentation page it was taken from in `test/fixtures/github/README.md`.
- `test/unit/adapters/github.test.ts`: exact id/source/type/time/subject/summary assertions per fixture, verbatim raw-body retention, mechanical typing of the foreign event, unknown-event retention for non-JSON bodies, every HMAC known-good/known-bad case, and exact header-allowlist filtering.
- `test/unit/adapters/github-ingress.test.ts`: end-to-end coverage through the real server (`buildApp`) — valid delivery accepted, redelivery deduped by `x-github-delivery`, bad signature rejected, missing secret refused by default, missing secret accepted under dev mode with a WARN log.
- README: a "GitHub" subsection under "The event format contract" documenting the id/source/type/subject/summary/retained-header rules, the verification mechanism, the fixture-provenance rule, and how to register a GitHub webhook.

## [0.0.1] - 2026-08-28
### Added
- CloudEvents 1.0 envelope (`src/events`): types plus a `createCloudEvent` constructor and `isCloudEvent` validator.
- Provider adapter contract (`src/adapters/types.ts`) and an empty registry (`src/adapters/index.ts`) — no provider-specific code ships in this task.
- Durable append-only event log (`src/store`) on `bun:sqlite` in WAL mode, with idempotent `append`, filtered/paged `read`, `latestSeq`, and in-process `subscribe` fan-out.
- Env-only config (`src/config.ts`): `PORT`, `CATAMORBIUS_DB`, `WEBHOOK_SECRET_<PROVIDER>`, `CATAMORBIUS_TOKENS`, `CATAMORBIUS_DEV_MODE`, with the missing-secret 503/dev-mode rule.
- Generic ingress (`src/ingress`): `POST /webhooks/:provider`, byte-exact signature verification, dedupe-aware storage, and a throw-guard that stores unrecognized/malformed deliveries as `<provider>.unknown`.
- `src/server.ts` builds the Elysia app from config + store + registry; `GET /healthz` reports `{ ok, seq }`.
- Fake-adapter-driven test suite (`test/unit`, fake adapter in `test/support`) covering verification, multi-event delivery, the throw-guard, dedupe, the missing-secret/dev-mode rule, store round-tripping, read filters, and subscribe fan-out.
- README with the full event-format contract, env var table, endpoint/status-code reference, and "adding a provider" guide.

### Fixed
- `isCloudEvent` now validates into `data`: `data.raw` must be an object with a string-valued `headers` map and a present `body` key, and `data.summary` must be an object. A non-conforming adapter envelope that passed the old shallow check (e.g. `data: {}`) no longer crashes `store.append` with a 500 — it is caught by the existing throw-guard and stored as `<provider>.unknown`.
- The generic ingress path now redacts credential-bearing headers (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, and any header whose name contains `signature` or `token`) before a delivery is stored, on both the throw-guard fallback and every adapter-produced event's `data.raw.headers`. `verify()` still receives the full, unredacted headers.

## [0.0.0] - 2026-08-28
### Added
- Repo scaffold: bun + Elysia + TypeScript, `GET /healthz`, and the suite-standard CI/release gate stack (mirrored from brooswit-factory/thatch).
