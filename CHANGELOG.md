# Changelog

All notable changes to `catamorbius`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.
The release gate runs only on PRs whose base is `main`; task PRs into a story branch run `check` only. A story ships main exactly one semver step, regardless of how many task PRs it contains.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

## [0.0.2] - 2026-08-28
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
