# Jira Cloud webhook fixtures

Every fixture here is written from a shape Atlassian's docs actually publish
— never invented from memory. See
[`docs/jira-webhooks.md`](../../../docs/jira-webhooks.md) for the full
investigation and quotes; this file cites, per fixture, exactly which
documented shape it comes from.

Each delivery fixture (all except the `verify-*` and `non-json-body.txt`
ones) is a JSON file shaped `{ headers, body }`: `body` is what Jira would
POST as the request body, `headers` are the documented delivery headers that
accompany it.

## Delivery fixtures

- **`issue-created.json`**, **`issue-deleted.json`** — envelope and
  `issue`/`user` shapes adapted from the one full documented example (see
  `issue-updated.json` below), with `webhookEvent`/`issue_event_type_name`
  changed and the changelog dropped, per
  <https://developer.atlassian.com/cloud/jira/platform/webhooks/> ("Every
  callback contains the webhookEvent ID, timestamp, and information about
  the entity" — the doc doesn't give a separate full example per issue
  event, only states they share this envelope).
- **`issue-updated.json`** — the **literal** documented example from
  <https://developer.atlassian.com/cloud/jira/platform/webhooks/#example-callback-for-an-issue-related-event>,
  reproduced verbatim, including the doc's own JSON typo `accoundId` (not
  `accountId`) on the `user` object — see docs/jira-webhooks.md's note on
  why this is deliberately not "fixed". Includes the documented `changelog`
  block ("The changelog is only provided for the `jira:issue_updated`
  event").
- **`comment-created-with-issue.json`**, **`comment-updated.json`** — comment
  shape from the Comment REST schema the webhooks page points to:
  <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-id-get>
  (`self`, `id`, `author`, `body`, `created`, `updated`, `jsdPublic`), with a
  top-level `issue` object per the envelope's issue-events shape.
- **`comment-created-without-issue.json`** — same comment shape, but with NO
  top-level `issue` object. Whether `comment_*` payloads carry a sibling
  `issue` object is explicitly **UNDOCUMENTED** on the webhooks page (see
  docs/jira-webhooks.md, "Does the top-level envelope carry `issue`...");
  this fixture is the doc's own recommended hedge — build both ways.
- **`worklog-created-with-issue.json`** — worklog shape from the Worklog REST
  schema: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/#api-rest-api-3-issue-issueidorkey-worklog-id-get>
  (`self`, `id`, `issueId`, `author`, `started`, `timeSpent`,
  `timeSpentSeconds`, `created`), with a top-level `issue` object.
- **`worklog-created-without-issue.json`** — same worklog shape, no top-level
  `issue` object — the same documented hedge as the comment pair above.
- **`foreign-event.json`** — a `webhookEvent` value ("jira:future_thing_happened")
  that does not appear anywhere in the documented event catalog
  (<https://developer.atlassian.com/cloud/jira/platform/webhooks/#available-webhook-events>).
  Exists to prove the adapter's type mapping is mechanical, not an
  allowlist: it must still type as
  `com.atlassian.jira.future.thing.happened`.
- **`non-json-body.txt`** — deliberately not JSON at all, to exercise the
  `<provider>.unknown` unrecognizable-delivery path required by
  `src/adapters/types.ts`'s `ProviderAdapter` contract.

All `user`/`issue`/`comment`/`worklog` `self` URLs use the literal
`your-domain.atlassian.net` placeholder host from Atlassian's own documented
example, so the adapter's site-host derivation runs against a realistic,
documented-shape URL rather than an invented one.

## Verification fixtures

All signed against the **known-good HMAC-SHA256 test vector given directly
on the docs page**
(<https://developer.atlassian.com/cloud/jira/platform/webhooks/>): secret
`It's a Secret to Everybody`, body `Hello World!`, method `sha256` →
`X-Hub-Signature: sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9`.
This is a throwaway key that exists only in Atlassian's own documentation
and this test fixture — not a real secret, so it may be committed per the
epic's secrets rule.

- **`verify-known-good.json`** — the vector as-is; `verify()` must return
  `{ ok: true }`.
- **`verify-bad-wrong-secret.json`** — same header/body, wrong secret.
- **`verify-bad-tampered-body.json`** — same header/secret, body changed
  after signing.
- **`verify-bad-missing-header.json`** — no `x-hub-signature` header at all.
- **`verify-bad-malformed-header.json`** — header present but not
  `method=hex` shaped.
- **`verify-bad-unsupported-method.json`** — header present and well-formed,
  but names a method (`md5`) other than the one method
  (`sha256`) the docs currently document; per docs/jira-webhooks.md (a), the
  docs themselves warn the method may change, so the adapter reads it from
  the header and must treat an unrecognized one as a verification failure,
  never a pass.
- **`verify-bad-wrong-length.json`** — header present, well-formed, and
  names the supported method, but the hex digest is the wrong length for a
  SHA-256 HMAC — must fail before the constant-time compare is ever
  attempted (so a length mismatch can never throw).

Each fixture's `expectedReason` field (when present) documents which
`VerifyFail.reason` the adapter is expected to return; the test file asserts
against it.
