# Jira Cloud webhooks — investigation against Atlassian's docs

Research task for the `jira` provider adapter (Task B, tracked separately).
**No adapter code ships in this document** — it is the contract Task B
implements against. Every factual claim below cites the Atlassian URL it
came from. Claims are marked one of:

- **CONFIRMED** — the docs say this, quote/URL attached.
- **REFUTED** — the docs say something different from the working assumption; what they say instead is quoted.
- **UNDOCUMENTED** — the docs are silent; the fallback this project will use is stated explicitly.
- **catamorbius convention** — not a Jira feature at all, invented by this project.

Primary source, fetched and read in full (raw HTML, not just an AI summary —
see methodology note at the end): **<https://developer.atlassian.com/cloud/jira/platform/webhooks/>**
("Webhooks", Jira Cloud platform guide). All unattributed quotes in sections
(a)–(d) and the site-host section are from this page unless another URL is
given inline. Page banner at fetch time: *"Ending Connect support — You can
no longer publish Connect apps on the Atlassian Marketplace... Have an
existing Connect app? You can incrementally migrate it to Forge."* — relevant
context for the Connect/Forge sub-questions below.

---

## (a) Request verification

**Working assumption:** an admin-registered Jira Cloud webhook (Settings →
System → WebHooks) accepts a `secret` and Jira sends an HMAC-SHA256 of the
request body in an `X-Hub-Signature` header formatted `sha256=<hex>`.

**Verdict: CONFIRMED**, for the registration mode a Jira admin actually uses.

> "To ensure your server only processes deliveries from Jira Cloud, you need
> to: Create a secret token for your webhook. Store the token securely on
> your server. Validate incoming webhook payloads against the token to
> verify they're coming from Jira Cloud."
>
> "Jira Cloud will use your secret token to create a HMAC signature and
> include it in a `X-Hub-Signature` header, formatted as `method=signature`,
> as defined by [WebSub]."
>
> "The HMAC is generated using your webhook's secret token, the payload
> contents, and the hash algorithm listed in `method`."
>
> Test vector given on the page: secret `It's a Secret to Everybody`,
> payload `Hello World!`, method `sha256` →
> `X-Hub-Signature: sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9`.
>
> "Note that these examples assume that Jira is using the `sha256` hash
> algorithm. Jira might start using another method for the HMAC in the
> future. The example code here will start failing if this happens."

So the header format is technically `<method>=<hex>` (WebSub-style), not
hardcoded `sha256=`, but `sha256` is the only method the docs show today and
the docs themselves warn that could change — Task B should read `method` out
of the header rather than assuming the `sha256=` prefix is a constant.

**Which registration modes get a secret at all — this is where the
assumption needed narrowing, not refuting:**

- **Jira Administration UI ("Settings → System → WebHooks") and the REST API
  at `/rest/webhooks/1.0/webhook`** (the docs call both together "admin
  webhooks" — *"Webhooks created in Jira Administration or registered by
  `/rest/webhooks/1.0/webhook` are called admin webhooks in this
  documentation."*) both support a `secret` field:
  > "You can secure webhooks registered through the REST API or webhooks
  > page by passing the `secret` field."
  The registration response even echoes it back as a boolean:
  > `"isSigned": true` — *"Where `isSigned` is true if a secret is defined."*
  This is the practical case for catamorbius: an operator (Jira admin)
  registers a webhook by hand or via this REST endpoint and sets a secret,
  which is exactly the flow `WEBHOOK_SECRET_JIRA` is meant to back.
- **The other REST API, `POST /rest/api/3/webhook`, "for Connect and OAuth
  2.0 apps"** — a *different*, app-scoped registration mechanism ("dynamic
  webhooks") restricted to a subset of events (`jira:issue_created`,
  `jira:issue_updated`, `jira:issue_deleted`, `comment_created`,
  `comment_updated`, `comment_deleted`, `issue_property_set`,
  `issue_property_deleted`, `sprint_*`, `jira:version_*`). Its documented
  request/response examples on this page show `jqlFilter`/`events`/`url`
  fields with **no `secret` or `isSigned` field** anywhere in the request or
  response bodies shown. The docs do not state this route supports a secret
  at all — UNDOCUMENTED, not refuted (the docs simply never raise the
  subject here, unlike the admin-webhook section which explicitly does).
- **Connect apps' static webhook module** (declared in the app descriptor):
  > "Declare a webhook module in the descriptor of your Atlassian Connect
  > app (this will register the webhook for your app automatically and
  > ensures webhooks are signed with your app's `sharedSecret`)"
  This is a *different* signing mechanism tied to the app's Connect
  `sharedSecret` (Connect's JWT-based app auth), not the `secret`/
  `X-Hub-Signature` flow above. This page doesn't say which header carries
  that signature or what its format is — UNDOCUMENTED on this page. Moot for
  catamorbius anyway: Connect is being sunsted ("Ending Connect support...
  migrate to Forge") and nobody stands up a Connect app just to feed
  catamorbius.
- **Forge**: this page contains no description of a raw outbound HTTP
  webhook delivery for Forge apps at all — Forge triggers invoke a function
  inside the Forge platform sandbox rather than POSTing to an
  operator-configured external URL the way admin/Connect webhooks do.
  UNDOCUMENTED on this page, and out of scope for catamorbius's ingress
  model (which needs an external `POST /webhooks/jira` target) regardless.

**Conclusion for Task B:** implement HMAC verification against the admin
webhook flow — read `secret` from `WEBHOOK_SECRET_JIRA`, compute HMAC over
the raw body using the algorithm named in the `X-Hub-Signature` header's
`method` (`sha256` today), and compare against the header's hex digest in
constant time. **No catamorbius-invented header is needed.** This resolves
the engineering constraint cleanly, better than the ticket's fallback path
anticipated: Jira signs the *raw body* with a secret the operator supplies
out of band at registration time — `verify(headers, rawBody, secret)` has
everything it needs. The URL/query-string limitation the ticket worried
about never bites here, because Jira's signature scheme was never
query-string-based to begin with (unlike, say, a `?token=` scheme would be).

**Redaction check** (per `src/ingress/index.ts`, read directly):

```ts
const REDACTED_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
function redactHeaders(headers) {
  ...
  if (REDACTED_HEADER_NAMES.has(lower) || lower.includes("signature") || lower.includes("token")) continue;
  ...
}
```

`adapter.verify(headers, rawBody, secret)` is called with the **unredacted**
`headers` object (`ingress/index.ts` line ~80, before `redactHeaders` is
ever applied). Redaction only happens afterward, when building the stored
`data.raw.headers` for the events an adapter returns (lines ~94–97) and in
the generic `wrapUnknown` fallback (line ~39). `X-Hub-Signature` contains the
substring `"signature"`, so it is caught by the existing generic filter and
**will never reach the durable log**, with no adapter-specific work needed —
exactly what house rule (3) from the epic requires. No custom header, no new
redaction rule.

---

## (b) Per-delivery identifier

**Working assumption:** an `X-Atlassian-Webhook-Identifier` header, and
whether it is stable across Jira's own retries (needed to use it as the
CloudEvent `id` for `(source, id)` dedupe).

**Verdict: CONFIRMED**, including the retry-stability question — this is a
stronger result than the ticket's fallback path anticipated.

> "Every webhook contains the `X-Atlassian-Webhook-Identifier` header that
> provides an identifier for a webhook. This identifier is unique within a
> Jira Cloud tenant and is the same across retries. After you have processed
> a webhook, you can use the identifier to filter out retries."

So: present on every delivery, and explicitly documented as **stable across
retries** — a genuine delivery id, not a fresh id per HTTP attempt. Two
related, separately-documented headers:

> "The `X-Atlassian-Webhook-Retry` header with the current retry count is
> included with webhooks that have been retried."

> "Each webhook contains `X-Atlassian-Webhook-Flow` header with `Primary` or
> `Secondary` value." — Primary/Secondary distinguishes a top-level webhook
> from webhooks fired as a side effect of a bulk/cascade operation (the docs'
> example: deleting an issue sends `issue_deleted` as Primary, with
> dependent `comment_deleted`/`attachment_deleted`/`issuelink_deleted`, etc.
> as Secondary).

**Recommendation for Task B:** use the raw `X-Atlassian-Webhook-Identifier`
value directly as the CloudEvent `id` (or a deterministic, reversible
transform of it — e.g. prefixed — but no hashing is needed since it's
already a stable, tenant-scoped identifier). Because the identifier's
uniqueness is scoped to "a Jira Cloud tenant" and not global, and this
project's dedupe key is the pair `(source, id)` where `source` already
encodes the tenant host as `//jira/<site host>` (see below), the pair stays
collision-safe across tenants even though the identifier alone is not
globally unique. **No content-hash fallback is needed for the primary path**
— that fallback remains valuable only as the existing generic
throw-guard/`wrapUnknown` backstop already in `src/ingress/index.ts`, for
the case where an adapter throws or a delivery is malformed before an id can
be extracted; that generic behavior is unchanged by this document.

One header-redaction note: `X-Atlassian-Webhook-Identifier` contains neither
`"signature"` nor `"token"` as a substring, so it passes the generic
redaction filter unmodified and **is** stored in `data.raw.headers` — correct,
since it isn't a credential.

---

## (c) Event names and envelope

### Full documented event catalog

Source: <https://developer.atlassian.com/cloud/jira/platform/webhooks/#available-webhook-events>
(section "Available webhook events" — *"The string in parentheses is the
name of the `webhookEvent` in the response."*):

| Family | Events (`webhookEvent` value) |
| --- | --- |
| Platform | `app_access_to_objects_blocked`, `app_access_to_objects_in_container_blocked` |
| Issue | `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted` (JQL filtering supported) |
| Issue property | `issue_property_set`, `issue_property_deleted` (JQL filtering supported) |
| Worklog | `worklog_created`, `worklog_updated`, `worklog_deleted` (JQL filtering supported) |
| Comment | `comment_created`, `comment_updated`, `comment_deleted` (JQL filtering supported) |
| Attachment | `attachment_created`, `attachment_deleted` (JQL filtering supported) |
| Issue link | `issuelink_created`, `issuelink_deleted` |
| Issue type | `issuetype_created`, `issuetype_updated`, `issuetype_deleted` |
| Project | `project_created`, `project_updated`, `project_deleted`, `project_soft_deleted` (moved to trash), `project_restored_deleted` (restored from trash), `project_archived`, `project_restored_archived` |
| Version | `jira:version_released`, `jira:version_unreleased`, `jira:version_created`, `jira:version_moved`, `jira:version_updated`, `jira:version_deleted` — **and** `jira:version_deleted` reused for "merged" too: *"merged (`jira:version_deleted`) note, this is the same webhook event name as the 'deleted' event, but the response will include a `mergedTo` property"* (elsewhere on the same page, in the REST-API-scopes table, this merge variant is separately labeled `jira:version_merged` — the docs are internally inconsistent about the event name for a merge; treat `webhookEvent === "jira:version_deleted"` with a `mergedTo` property present as the disambiguator, don't rely on the name alone) |
| Filter | `filter_created`, `filter_updated`, `filter_deleted` |
| User | `user_created`, `user_updated`, `user_deleted` |
| System configuration ("option") | `option_voting_changed`, `option_watching_changed`, `option_unassigned_issues_changed`, `option_subtasks_changed`, `option_issuelinks_changed`, `option_timetracking_changed`, `option_timetracking_provider_changed` |
| Sprint | `sprint_created`, `sprint_deleted`, `sprint_updated`, `sprint_started`, `sprint_closed` |
| Board | `board_created`, `board_updated`, `board_deleted`, `board_configuration_changed` |
| Jira expressions | `jira_expression_evaluation_failed` |

This is the complete list on the page — no others were found.

### Common envelope

> "Every callback contains the webhookEvent ID, timestamp, and information
> about the entity associated with the event (for example issue, project, or
> board)... For example, issue-related events contain the
> `issue_event_type_name` field... This is the structure of a callback for
> an issue-related event:"

```json
{
  "timestamp",
  "webhookEvent",
  "issue_event_type_name",
  "user": { "...": "See User shape below" },
  "issue": { "...": "See Issue shape below" },
  "changelog": { "...": "See Changelog shape below" }
}
```

Full documented example ("the following is an example of the JSON sent in
an issue update callback"), reproduced verbatim including the doc's own
typo (`accoundId`, not `accountId` — flagged so Task B doesn't "fix" a
fixture into non-conformance with the source):

```json
{
  "issue": {
    "id": "99291",
    "self": "https://your-domain.atlassian.net/rest/api/2/issue/99291",
    "key": "JRA-20002",
    "fields": {
      "summary": "I feel the need for speed",
      "created": "2009-12-16T23:46:10.612-0600",
      "description": "Make the issue nav load 10x faster",
      "labels": ["UI", "dialogue", "move"],
      "priority": {
        "self": "https://your-domain.atlassian.net/rest/api/2/priority/3",
        "iconUrl": "https://your-domain.atlassian.net/images/icons/priorities/minor.svg",
        "name": "Minor",
        "id": "3"
      }
    }
  },
  "user": {
    "self": "https://your-domain.atlassian.net/rest/api/2/user?accountId=99:27935d01-92a7-4687-8272-a9b8d3b2ae2e",
    "accoundId": "99:27935d01-92a7-4687-8272-a9b8d3b2ae2e",
    "accountType": "atlassian",
    "avatarUrls": {
      "16x16": "https://your-domain.atlassian.net/secure/useravatar?size=small&avatarId=10605",
      "48x48": "https://your-domain.atlassian.net/secure/useravatar?avatarId=10605"
    },
    "displayName": "Bryan Rollins [Atlassian]",
    "active": "true",
    "timeZone": "Europe/Warsaw"
  },
  "changelog": {
    "items": [
      { "toString": "A new summary.", "to": null, "fromString": "What is going on here?????", "from": null, "fieldtype": "jira", "field": "summary" },
      { "toString": "New Feature", "to": "2", "fromString": "Improvement", "from": "4", "fieldtype": "jira", "field": "issuetype" }
    ],
    "id": 10124
  },
  "timestamp": 1606480436302,
  "webhookEvent": "jira:issue_updated",
  "issue_event_type_name": "issue_generic"
}
```

Bulk-operation addendum, documented separately:
> "If a bulk operation triggers the webhook, the field `bulkOperationMetaData`
> is added to the webhook payload." — `{ "bulkOperationMetaData": { "sendMail": false } }` alongside the usual fields.

### `timestamp` unit — **UNDOCUMENTED** (as an explicit statement)

The docs never state in prose that `timestamp` is epoch milliseconds. The
only evidence is the example value `1606480436302` (13 digits, resolves to
2020-11-27 in epoch-*milliseconds*, but to a nonsensical date ~50,000 years
out in epoch-seconds) — strongly consistent with epoch milliseconds by
inspection, but not a documented statement. **Fallback for this project:**
treat `timestamp` as epoch milliseconds, per the numeric example, and
convert to the CloudEvent `time` RFC 3339 string accordingly; if a future
delivery's `timestamp` doesn't parse as a sane recent date under that
assumption, that's a signal the assumption needs revisiting, not proof it
was wrong at investigation time.

### Field shapes (documented)

> **Issue shape:** "The same shape returned from the Jira REST API when an
> issue is retrieved with NO expand parameters." (links to Get issue,
> example `https://your-domain.atlassian.net/rest/api/2/issue/JRA-2000`) —
> confirms `issue.id`, `issue.key`, `issue.self`, `issue.fields.summary` per
> the example payload above.
>
> **User shape:** "The same shape returned from the Jira REST API when a
> user is retrieved, but without the `locale`, `emailAddress`, `groups`, and
> `applicationRoles` fields... The user is always present in a webhook POST
> for issue events. The user includes an `accountType` field that is used to
> distinguish different types of users, such as normal users (`atlassian`),
> app users (`app`), and Jira Service Management customers (`customer`)." —
> confirms `user.displayName`, `user.accountId` (documented field name; the
> example payload's `accoundId` is a doc typo, not a schema change),
> `user.self`, `user.accountType`.
>
> **Changelog shape:** "An array of changed items, with one entry for each
> field that has been changed. The changelog is only provided for the
> `jira:issue_updated` event." — confirms `changelog.items[]`, each with
> `field`, `fieldtype`, `from`, `fromString`, `to`, `toString`.
>
> **Comment shape:** "The same shape returned from the Jira REST API when a
> comment is retrieved... The comment is provided for comment related
> webhooks." (links to Get comment, example
> `https://your-domain.atlassian.net/rest/api/3/issue/JRA-9/comment/252789`)

The webhooks page itself does not embed a full example `comment_created` or
`worklog_*` payload — only the general envelope + the one `jira:issue_updated`
example above. For `comment.*` and `worklog.*` field shapes, this document
additionally verified the **REST API schema** the webhooks page points to
(not an assumption from memory — fetched and read the OpenAPI schema
embedded in the page):

- Comment schema — <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-id-get> —
  `Comment` object properties: `author` (UserDetails), `body` (Atlassian
  Document Format), `created` (date-time), `id`, `jsdAuthorCanSeeRequest`
  (bool), `jsdPublic` (bool), `properties` (EntityProperty[]), `renderedBody`,
  `self` (URL of the comment), `updateAuthor` (UserDetails), `updated`
  (date-time), `visibility`.
- Worklog schema — <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/#api-rest-api-3-issue-issueidorkey-worklog-id-get> —
  `Worklog` object properties: `author` (UserDetails), `comment` (ADF),
  `created` (date-time), `id`, `issueId` (**the worklog's own object
  carries its parent issue id**, `issueId`, distinct from any top-level
  envelope `issue` object), `properties`, `self` (URL, format `uri`),
  `started` (date-time), `timeSpent`, `timeSpentSeconds`.

### Does the top-level envelope carry `issue` for `comment_*` / `worklog_*` events? — **UNDOCUMENTED**

The webhooks page states plainly that `issue` is part of the envelope for
"an issue-related event" and shows only the `jira:issue_updated` example.
It separately states the comment/worklog objects are "provided for
comment/worklog related webhooks," but **does not explicitly say** whether
`comment_created`/`worklog_created` etc. *also* carry a sibling top-level
`issue` object the way `jira:issue_updated` does. The one adjacent, weaker
signal: the URL variable-substitution table states *"{issue.key} and
{issue.id} are available to webhooks registered for events related to
issues"* (a broader category than just the `jira:issue_*` family) — but that
governs URL templating, not the JSON payload shape, so it is not read as
confirmation here.

**Fallback for this project:** Task B should treat `issue` as present for
`comment_*` and `worklog_*` payloads defensively (i.e., code and fixtures
should not assume it is always there, but the mechanical typing shouldn't
error if it's absent either) — build fixtures for both a "with issue" and a
"without issue" shape for these two families if practical, since the docs
leave real ambiguity here. This is the one place this investigation
recommends hedging rather than picking a single documented shape, because
there is no documented shape to pick.

### Non-issue events (sprint / board / version / project / user)

The docs do not reproduce example payloads for these families either. What
is documented: URL template variables confirm each family's entity has at
minimum an `id` (`{board.id}`, `{sprint.id}`, `{project.id}`/`{project.key}`,
`{mergedVersion.id}`) reachable off the event. Beyond that, per-family
payload shape is **UNDOCUMENTED** on this page — Task B's fixtures for
these families should be built from the entity's own REST API "get" shape
(Get board, Get sprint, Get project, Get version), the same pattern this
document used for comment/worklog above, and marked as such rather than
copied from a webhook-specific example that doesn't exist in the docs.

---

## (d) Headers

Documented headers accompanying a delivery, all from
<https://developer.atlassian.com/cloud/jira/platform/webhooks/>:

| Header | Documented behavior |
| --- | --- |
| `X-Hub-Signature` | Present "when secret configured" on an admin webhook — see (a). Format `method=signature`, e.g. `sha256=<hex>`. |
| `X-Atlassian-Webhook-Identifier` | "Every webhook contains" this — stable delivery id, same across retries. See (b). |
| `X-Atlassian-Webhook-Retry` | "included with webhooks that have been retried" — current retry count. Absent on a first attempt. |
| `X-Atlassian-Webhook-Flow` | "Each webhook contains" this — `Primary` or `Secondary`. |
| `X-Atlassian-Webhook-Trace` | Optional, Connect-app-only: *"To trace the origin of a webhook, Connect apps can attach the additional `X-Atlassian-Webhook-Trace` HTTP header with any value consisting of a string of up to 1024 printable ASCII characters to a REST API request."* Not relevant to admin webhooks (no Connect app involved), included here for completeness. |

**UNDOCUMENTED on this page:** `Content-Type` and `User-Agent` of the
*incoming delivery request itself*. The only `Content-Type: application/json`
occurrences on the page are in `curl` examples for *registering* a webhook
against Jira's REST API — not a statement about what content-type Jira sets
when *it* POSTs a webhook to the operator's callback URL. Given `"By
default, a webhook will send a request with a JSON callback when it is
triggered"` it is a safe operational assumption that the delivery itself is
`application/json`, but that is this document's inference, not a quoted
fact — flagged per house rules rather than presented as confirmed.

---

## Site host derivation

catamorbius derives the CloudEvent `source` as `//jira/<site host>` from the
payload's own `self` URLs (`issue.self`, `user.self`, `comment.self`,
`project.self`), e.g. `https://wroosbit.atlassian.net/rest/api/2/issue/10759`
→ `wroosbit.atlassian.net`, falling back to `//jira/unknown` when none is
derivable.

- **`issue.self`** — CONFIRMED present, shown directly in the documented
  example above: `"self":"https://your-domain.atlassian.net/rest/api/2/issue/99291"`.
- **`user.self`** — CONFIRMED present, same example:
  `"self":"https://your-domain.atlassian.net/rest/api/2/user?accountId=..."`.
- **`comment.self`** — CONFIRMED via the REST API Comment schema (see (c)):
  `"self": { "description": "The URL of the comment.", ... }`. Not shown in
  a webhook-specific example on the webhooks page itself, since none exists
  for comment events, but confirmed as part of the shape the webhooks page
  says comment payloads reuse ("the same shape returned from the Jira REST
  API when a comment is retrieved").
- **`project.self`** — **UNDOCUMENTED** by direct example. No project
  payload example (webhook or REST) was fetched as part of this
  investigation; it is expected by the general "same shape as the REST API"
  convention the docs establish for issue/user/comment, but that is an
  extrapolation, not a confirmed fact for `project` specifically.

**Events that lack any `self`-bearing object to derive a host from:**
`option_*` (system configuration toggles), `jira_expression_evaluation_failed`,
and `app_access_to_objects_*` — none of these families were shown carrying
an `issue`/`user`/`comment`/`project` object in anything this investigation
found documented. These should fall back to `//jira/unknown`.

---

## Summary — the four working assumptions

| # | Assumption | Verdict |
| --- | --- | --- |
| (a) | Admin webhook + `secret` → HMAC-SHA256 in `X-Hub-Signature: sha256=<hex>` | **CONFIRMED** for admin/`/rest/webhooks/1.0/webhook` registration (the practical case); header format is actually `method=signature` per WebSub, `sha256` just being the only documented method today. UNDOCUMENTED whether the app-scoped `/rest/api/3/webhook` route supports a secret at all. No custom catamorbius header needed — implement HMAC verification directly against `X-Hub-Signature`. |
| (b) | `X-Atlassian-Webhook-Identifier`, stable across retries, usable as CloudEvent `id` | **CONFIRMED**, explicitly, including retry stability — use it directly as `id`, no content-hash fallback needed for the primary path. |
| (c) | Documented event list + envelope, `timestamp` in epoch ms, comment/worklog carry parent `issue` | Event list **CONFIRMED** (table above). Envelope core fields **CONFIRMED** via the one documented example. `timestamp` unit **UNDOCUMENTED** (inferred epoch-ms from the example value only). Comment/worklog carrying a top-level `issue` object **UNDOCUMENTED** — recommend hedging in fixtures/typing rather than assuming either way. |
| (d) | Documented delivery headers | `X-Hub-Signature`, `X-Atlassian-Webhook-Identifier`, `X-Atlassian-Webhook-Retry`, `X-Atlassian-Webhook-Flow`, `X-Atlassian-Webhook-Trace` all **CONFIRMED**. `Content-Type`/`User-Agent` of the delivery itself **UNDOCUMENTED** on this page. |

---

## Methodology note

`WebFetch`-style tools that pass page content through a small summarization
model carry real hallucination/paraphrase risk for a document whose whole
point is quote-for-quote accuracy. To avoid that, this investigation fetched
the webhooks page's **raw HTML directly** (it is server-rendered, not a pure
client-side SPA shell — confirmed by grepping the raw response for
`X-Hub-Signature` and `X-Atlassian-Webhook-Identifier` before trusting any
extracted text), stripped it to plain text locally, and every quote above
was pulled from that raw text with `grep`/direct inspection, not generated
by an intermediate model asked to "summarize." The Comment/Worklog REST
schema snippets in (c) were extracted the same way, from the OpenAPI schema
embedded in those pages' raw HTML. No page returned a 404 and no page was
unreachable during this investigation; the gaps marked UNDOCUMENTED above
are genuine silences in the source material, not fetch failures.
