# Changelog

All notable changes to `catamorbius`. Format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
entries are `## [x.y.z] - YYYY-MM-DD` with subsections from: `BREAKING`, `Added`, `Changed`, `Fixed`, `Removed`.
CI refuses a merge that changes `src/` or `package.json` without a new entry here.

## Versioning — what the numbers mean in this project

- **MAJOR** — a restructuring or rewrite that breaks a lot of things, requiring reimplementation by consumers. Requires a `### BREAKING` section.
- **MINOR** — a new feature, or a change to an existing feature that breaks just that feature.
- **PATCH** — a fix or correction that requires no consumer code changes, or very minor ones.

## [0.0.0] - 2026-08-28
### Added
- Repo scaffold: bun + Elysia + TypeScript, `GET /healthz`, and the suite-standard CI/release gate stack (mirrored from brooswit-factory/thatch).
