# Changelog

All notable changes to `catamorbius`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.
The release gate runs only on PRs whose base is `main`; task PRs into a story branch run `check` only. A story ships main exactly one semver step, regardless of how many task PRs it contains.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

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
