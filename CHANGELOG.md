# Changelog

All notable changes to `catamorbius`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.
The release gate runs only on PRs whose base is `main`; task PRs into a story branch run `check` only. A story ships main exactly one semver step, regardless of how many task PRs it contains.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

## [0.2.0] - 2026-09-02
### Added
- `HOST` env var (`src/config.ts`, `src/index.ts`): the interface the gateway binds. Unset behaves exactly as before — every interface — so no existing deployment, test, or dev run changes behavior by upgrading; set it to bind a single interface (e.g. loopback).

### Removed
- `deploy/catamorbius.service`: the `ExecStartPre`/`ExecStopPost` iptables DROP-rule workaround and its `sudo` dependency. The unit now pins `HOST=127.0.0.1` directly and binds loopback via the gateway itself, so it starts on a host with no passwordless `sudo` at all.

### Changed
- `deploy/README.md` and `deploy/catamorbius.env.example`: dropped the sudoers/Install-step-1 material (no longer needed — nothing to preserve, including the step-numbering defect it carried); rewrote the not-LAN-reachable verification section for the new single signature (connection refused, curl exit `7`), keeping a short note that the interim DROP rule used to produce a timeout (exit `28`) instead, so an older runbook doesn't misread today's exit `7` as a fault.

## [0.1.0] - 2026-08-28
### Added
- The full v0.1.0 product, proven end-to-end in CI: **ingress** (`POST /webhooks/:provider`, byte-exact HMAC verification, dedupe-aware storage, the `<provider>.unknown` throw-guard) → **normalize** (GitHub and Jira provider adapters, both mechanically typed with no event-name allowlist) → **durable log** (`bun:sqlite`, append-only, the autoincrement `seq` as the resumable stream cursor) → **SSE egress** (`GET /events`, bearer auth, `type`/`source`/`subject` filters, `Last-Event-ID`/`?from` cursor resume, heartbeats).
- `test/e2e/gateway.test.ts`: one end-to-end scenario driving a real local server over real HTTP, with the real registered adapters (`buildApp({ config, store })`, not `test/live`'s `adapters: []`) and a real `eventsource` client, using only committed fixtures. Proves, in order: subscribing from `earliest`; six documented-shape deliveries (both providers) arriving in seq order with exact type/id and lossless `data.raw.body` retention; unknown-event retention (a foreign event name and a non-JSON body, per provider) with the raw payload retained verbatim; dedupe (a redelivery is `202 duplicate:true` with the same seq and delivers nothing new); resume across a real disconnect/reconnect (two deliveries posted while the client is down, received exactly once on reconnect, no gaps or duplicate ids across the whole run); `?type=`/`?subject=` filters against exact, ordered lists; and the negative paths (bad signature → `401` and a silent stream, wrong bearer token → `401`, and `GET /healthz` reporting the true final seq). Wired into both `package.json`'s `check` script and `.github/workflows/ci.yml`'s test step, alongside `test/live`.
- `bun run smoke` (`scripts/smoke.ts`): a human-readable walk of the same (a)-(e) proof against a server the operator points it at (`CATAMORBIUS_URL`, tokens/secrets from env by name, never printed), printing each SSE frame as it arrives and exiting non-zero on the first thing that doesn't check out. Not a CI gate; excluded from the coverage denominator via `RUNS_ON_IMPORT` in `scripts/load/inventory.ts`, with its generated load test committed.

### Fixed
- `src/egress/index.ts`: the live-subscriber `controller.enqueue` inside `store.subscribe` is now guarded exactly like the heartbeat enqueue (catch → `cleanup()`). Previously an already-closed subscriber's controller could throw out of `store.append` *after* the row was already committed, turning a successful webhook delivery into a 500 and (since the throw aborted the subscriber loop) starving every subscriber registered after the dead one.
- `src/adapters/jira.ts` `deriveTime`: added a plausibility window (on/after 2000-01-01, no more than a day past receipt) around the millis-epoch interpretation of `body.timestamp`. A seconds-epoch value previously produced a bogus 1970 date instead of falling back to receipt time; the UNDOCUMENTED verdict on the timestamp's unit in `docs/jira-webhooks.md` is unchanged — this is a sanity check layered on top of that inference, not a new claim about it.

### Changed
- README.md finalized as the complete v0.1 contract, cross-read against `src/` line by line: restructured the env var table with explicit Default/Required columns; documented `com.github.unknown`/`com.atlassian.jira.unknown` as what an integrator actually receives for a delivery an adapter can't parse, distinguishing that from the rarer generic `<provider>.unknown` ingress throw-guard fallback (the previously-drifted claim — see below); expanded `POST /webhooks/<provider>` into a full `GET`/`POST` reference with the GitHub-vs-Jira signature-header difference (`X-Hub-Signature-256: sha256=<hex>` vs. `X-Hub-Signature: <method>=<hex>`), delivery-id/dedupe headers, and worked curl examples for both providers; added the `//<provider>/unknown` source-collision caveat under each provider's `source` rule; expanded "Cursor & durability" into "Durability and cursor semantics" with the "retention policy: none in v0.1" line and the backfill-not-backpressured known limitation; added "Testing and the gate stack" (test/unit, test/load, test/live, test/e2e, the coverage gate, `bun run smoke`), a CHANGELOG pointer, and the one-line "Deployment: not covered in v0.1" section.
  - Confirmed drift fixed: the **Endpoints** section previously said a malformed body is stored as a single `<provider>.unknown` event. That's the shape of `src/ingress/index.ts`'s `wrapUnknown` throw-guard, which only fires if an adapter's `toEvents` itself throws — the path an integrator actually hits goes through the adapter and produces the fully-qualified `com.github.unknown` / `com.atlassian.jira.unknown`. Both are now documented, with the distinction stated explicitly.
  - Two review fixes: the Jira `time` bullet now reflects `deriveTime`'s plausibility window (a syntactically valid but implausible millis value, e.g. a seconds-epoch timestamp, falls back to receipt time rather than being treated as "parseable"); and "Adding a provider" no longer conflates an adapter's own fully-qualified unknown type with the ingress throw-guard's bare `<provider>.unknown` fallback, and now also notes the guard fires when `toEvents` returns a non-conforming event, not only when it throws.

## [0.0.4] - 2026-08-28
### Added
- `docs/jira-webhooks.md`: investigation of Jira Cloud webhook request verification, per-delivery-id dedupe, the documented event catalog and envelope, and delivery headers, against Atlassian's current documentation. CONFIRMED: admin/`/rest/webhooks/1.0/webhook` secret → HMAC-SHA256 `X-Hub-Signature` header (directly usable, no custom header needed); `X-Atlassian-Webhook-Identifier` is stable across retries (usable directly as CloudEvent `id`); the full `webhookEvent` catalog and common envelope. UNDOCUMENTED: `timestamp` unit is only inferable from the example value, not stated; whether `comment_*`/`worklog_*` payloads carry a top-level `issue` object; delivery `Content-Type`/`User-Agent`.
- `src/adapters/jira.ts`, registered in `src/adapters/index.ts`: the `jira` provider adapter, implemented strictly against `docs/jira-webhooks.md`. `verify` reads the HMAC method out of the WebSub-style `X-Hub-Signature: <method>=<hex>` header rather than assuming `sha256=`, hashes the exact raw body, and constant-time compares (an unsupported method is a verification failure, never a pass). `id` uses `X-Atlassian-Webhook-Identifier` directly when present, else a deterministic SHA-256 over `(webhookEvent, timestamp, issue.id or comment.id, raw body)`. `type` is derived mechanically from `webhookEvent` with no allowlist of event names. `source` is `//jira/<site host>` from the payload's own `self` URLs, else `//jira/unknown`. An unparseable or `webhookEvent`-less delivery becomes a single `com.atlassian.jira.unknown` event with the raw payload retained; `toEvents` never throws.
- `test/fixtures/jira/`: JSON fixtures for `jira:issue_created`/`_updated`/`_deleted`, `comment_created`/`_updated`, `worklog_created` (each of the latter two families in both a with- and without-top-level-`issue` shape, per the documented hedge), a deliberately foreign `webhookEvent` value, a non-JSON body, and known-good/known-bad HMAC verification vectors — every fixture cites the Atlassian doc page or REST schema it was taken from in `test/fixtures/jira/README.md`.
- `test/unit/adapters/jira.test.ts` and `test/unit/adapters/jira-ingress.test.ts`: unit coverage of every fixture through `toEvents` (id/source/type/time/subject/summary exactly, `raw.body` deep-equal), the mechanical foreign-event typing, the non-JSON and no-`webhookEvent` unknown-event paths, id determinism, header retention, and every `verify()` fixture; an ingress-level suite through the real Elysia server proving 202/duplicate dedupe, 401 on bad signature, and the 503/dev-mode missing-secret rule for the `jira` provider specifically.
- README: a "Jira" subsection under the event format contract documenting the verification mechanism, id/source/type/time/subject/summary derivation, and what remains undocumented vs. confirmed (mirroring `docs/jira-webhooks.md`), plus a "Register a Jira Cloud webhook" configuration paragraph.

## [0.0.3] - 2026-08-28
### Added
- SSE egress (`src/egress`): `GET /events`, mounted alongside `/healthz` and the webhook routes in `src/server.ts`.
- Bearer auth against `CATAMORBIUS_TOKENS`, compared per-token in constant time (hash-then-`timingSafeEqual`, so timing never leaks token length or which token matched). Missing/wrong token → `401` with `WWW-Authenticate: Bearer`; no tokens configured → `503` (naming `CATAMORBIUS_TOKENS` in the log) or, in dev mode, an open connection with a per-connection `WARN` line.
- Byte-exact frame format: a leading `retry: 3000` reconnect hint, then `event: <type>` / `id: <seq>` / `data: <CloudEvents JSON>` per event, and a `: heartbeat` comment every `CATAMORBIUS_HEARTBEAT_MS` (new config, default `15000`).
- `type` (prefix, mirroring the store's underscore-literal semantics), `source`, and `subject` (exact) filters, ANDed, applied identically to backfill and live events.
- Cursor resume via `Last-Event-ID` (replay `seq > N`) and `?from=earliest`/`?from=N` (replay `seq >= N`), with `Last-Event-ID` winning when both are present — the reconnect case. A cursor beyond the latest `seq` is live-only, not an error; a malformed cursor is `400`.
- No missed or duplicated events across the backfill → live boundary: the store subscription is established before backfill paging begins, live rows arriving mid-backfill are buffered and flushed by `seq`, and every frame's `id:` on a connection is strictly increasing.
- Cleanup on client disconnect/request abort: the store subscription is removed and the heartbeat timer cleared, with no leaked listeners or timers.
- `test/unit/egress` (frame format against a golden string, filters, the full cursor precedence table, the auth matrix, heartbeat timing, disconnect cleanup) and `test/live` (a real `eventsource` client against a real server proving resume across an actual disconnect/reconnect, filtered live delivery, an on-the-wire heartbeat, and a 401 on a bad token) — both run unconditionally in `bun run check` and CI.
- README: a full `GET /events` section (auth, frame format, filters, cursor precedence, heartbeats, the browser-`EventSource` header limitation, curl/TypeScript examples), replacing the three SSE forward-references.

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
