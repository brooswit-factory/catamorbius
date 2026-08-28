# GitHub webhook fixtures

Every payload here is written from the field shapes GitHub documents, never
from memory. Provenance per fixture:

| Fixture | Event doc (top-level fields, action values) | Nested object doc (entity shape) |
| --- | --- | --- |
| `ping.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#ping | `hook` fields (id, name, active, events, config, updated_at, created_at, url, ping_url, deliveries_url) from https://docs.github.com/en/rest/orgs/webhooks?apiVersion=2022-11-28#get-a-webhook-configuration-for-an-organization |
| `push.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#push (fields: ref, before, after, created, deleted, forced, base_ref, compare, commits, head_commit, pusher, repository, sender) | `commits[]`/`head_commit` shape (id, message, timestamp, url, author) is the documented Git commit summary object referenced by the push event fields above |
| `pull-request-opened.json`, `pull-request-closed-merged.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request (fields: action, number, pull_request, repository, sender; action values include `opened`, `closed`) | `pull_request` fields (number, state, title, user, body, created_at, updated_at, closed_at, merged_at, merge_commit_sha, merged, html_url) from https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request (schema shared with "Create a pull request") |
| `issues-opened.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues (fields: action, issue, repository, sender; action values include `opened`) | `issue` fields (number, title, state, user, body, created_at, updated_at, closed_at, html_url) from https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#get-an-issue |
| `issue-comment-created.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment (fields: action, comment, issue, repository, sender; action values include `created`) | `comment` fields (id, user, body, created_at, updated_at, html_url) from https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#get-an-issue-comment |
| `pull-request-review-submitted.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review (fields: action, pull_request, review, repository, sender; action values include `submitted`) | `review` fields (id, user, body, state, html_url, submitted_at, commit_id) from https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#get-a-review-for-a-pull-request |
| `release-published.json` | https://docs.github.com/en/webhooks/webhook-events-and-payloads#release (fields: action, release, repository, sender; action values include `published`) | `release` fields (id, tag_name, name, body, draft, prerelease, created_at, published_at, html_url, author) from https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28#get-a-release |
| `foreign-event.json` | Deliberately NOT in the docs — `x-github-event: some_future_thing` is a fictitious event name, used to prove the adapter types any event name mechanically with zero bespoke per-event code. |
| `non-json-body.txt` | Deliberately not JSON, to exercise the `<provider>.unknown` fallback for an unparseable delivery. |

The `repository` (id, full_name, html_url, owner.login/id) and `sender`/`user`
(login, id) shapes reuse exactly the minimal example GitHub's own webhook
docs page shows for the `issues` event's "Example webhook delivery" section,
plus `html_url` per the repository schema at
https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#get-a-repository.
Every fixture is trimmed to the fields the adapter or its tests actually
read — full REST responses carry many more fields than shown here; the
trimmed fields all match the documented name/type/shape, nothing is
invented.

`x-github-*` / `content-type` / `user-agent` delivery headers on every
fixture are the exact header names documented at
https://docs.github.com/en/webhooks/webhook-events-and-payloads (Delivery
headers section). No signature header is stored in these fixture files —
`test/unit/adapters/github.test.ts` computes `x-hub-signature-256` at test
time over `pull-request-opened.json`'s exact bytes using the throwaway
secret in `secret.ts`, per
https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries,
and derives the known-bad cases (wrong secret, tampered body, missing
header, sha1-only header, malformed `sha256=` value, correct-length-wrong
hex, wrong-length hex) from that same known-good signature so every case
stays byte-exact with the fixture file on disk.
