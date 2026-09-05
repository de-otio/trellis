---
title: Content reports API
description: The notice-and-action path (DSA Art. 16/17) — report categories, filing a report, the reporter's receipt and decision, and the SUPER_ADMIN review queue.
sidebar: Content reports API
order: 34
---

# Content reports API

The content-report path is Trellis's implementation of the DSA Art. 16
notice-and-action mechanism: a reporter picks a category from a
deployment-seeded vocabulary, files a report against a piece of content,
receives an Art. 16(4) receipt, and can read back the Art. 16(5) decision, the
Art. 17 statement of reasons, and the redress information. Operators review
`CONTENT` reports on a queue separate from the older LINK-report queue, because
the two run different state machines.

Core is **jurisdiction-neutral**: it ships no offence categories and no legal
copy. A deployment seeds its own `ReportCategory` rows
(`npm run seed:report-categories`) and supplies localized, counsel-approved
reporter copy through the `setReportTemplates` seam. Core routes only on each
category's `RoutingClass` — `ILLEGAL_PRIORITY`, `ILLEGAL`, `POLICY_VIOLATION`,
`FEEDBACK` — and never learns what a category means.

## Reporter-facing routes

- **Authentication:** every route requires a valid session
  (`401 {"error":"Unauthorized"}` otherwise).
- **CSRF:** required on `POST /api/reports`.
- Every response carries the standard security headers.

### GET `/api/report-categories`

The `ACTIVE` category vocabulary a client renders in its picker, ordered by
`sortOrder` then `key`. **Clients must read this rather than hard-code
categories** — the vocabulary is deployment-owned by design.

**Response (200):**

```json
{
  "categories": [{ "key": "harassment", "labels": { "en": "Harassment", "de": "Belästigung" } }]
}
```

`routingClass` is deliberately **withheld** (not even selected): it is the
operator's routing decision, and telling a reporter which categories take the
priority path is an oracle over the deployment's enforcement posture. Inactive
categories are omitted entirely — that flag is how a deployment ships a
category before its legal review lands.

The route is session-gated like filing a report: the vocabulary is only useful
to someone who can act on it, and it describes the deployment's enforcement
posture.

### POST `/api/reports`

File a content report.

**Rate limit:** 20 reports per hour per user (`429` when exceeded).

**Request body:**

```json
{
  "categoryKey": "harassment",
  "resourceType": "post",
  "resourceId": "clx123abc",
  "reason": "Optional free text, up to 1000 characters"
}
```

| Field          | Constraint                                                    |
| -------------- | ------------------------------------------------------------- |
| `categoryKey`  | 1–200 characters; must name an `ACTIVE` category              |
| `resourceType` | `post` \| `comment` \| `media` \| `entity` \| `user` \| `url` |
| `resourceId`   | 1–512 characters                                              |
| `reason`       | optional, ≤ 1000 characters                                   |

**Response (201 Created):**

```json
{
  "success": true,
  "report": {
    "id": "cmr…",
    "status": "pending",
    "categoryKey": "harassment",
    "createdAt": "2026-09-04T10:15:00.000Z"
  }
}
```

**Response (200 OK) — deduplicated.** One _open_ report (`pending` or
`acknowledged`) is allowed per reporter × resource × category. A repeat
returns the existing report with `"deduplicated": true` and does **not**
re-send the receipt.

**Side effects on creation:**

- The **Art. 16(4) receipt** is sent to the reporter (notification + email
  transports), best-effort — a delivery failure never fails the request, and
  the receipt is always readable back via `GET /api/reports/:id`.
- For categories routing to `ILLEGAL_PRIORITY` or `ILLEGAL`, the
  **operator-alert hook** fires.
- For `ILLEGAL_PRIORITY` against a content target, the **carve-out** runs at
  intake without waiting for a human: the resource is hidden, the original is
  preserved under an evidence hold through the injected
  `EvidencePreservationStore`, a _suppressed_ statement of reasons is written
  (audit record only — never delivered, so the affected account is not tipped
  off), media is marked `illegal-suspected` so it is never offered the appeal
  path, and a `pending` authority report is created. **Nothing is submitted to
  any authority**; filing stays human-gated (`markAuthorityReportSubmitted`).
  The carve-out never throws and the reporter's response body is identical
  either way, so it is not an oracle. A mis-wired deployment (an
  `ILLEGAL_PRIORITY` category active with no evidence store) mutates nothing,
  fires the compliance alarm hook, and still returns `201`.

**Errors:**

| Status | `error`            | When                                 |
| ------ | ------------------ | ------------------------------------ |
| `400`  | `VALIDATION_ERROR` | Body fails the schema above          |
| `400`  | `INVALID_CATEGORY` | `categoryKey` is unknown or inactive |
| `401`  | `Unauthorized`     | No session                           |
| `429`  | —                  | Rate limit exceeded                  |
| `500`  | —                  | Unexpected failure                   |

### GET `/api/reports/mine`

The authenticated reporter's own reports, newest first.

**Query parameters:** `limit` (default `20`, clamped to `1..50`), `cursor`
(the `createdAt` of the last item on the previous page).

**Response (200):**

```json
{
  "reports": [
    {
      "id": "cmr…",
      "reportType": "CONTENT",
      "resourceType": "post",
      "resourceId": "clx123abc",
      "categoryKey": "harassment",
      "status": "pending",
      "resolution": null,
      "reason": null,
      "createdAt": "2026-09-04T10:15:00.000Z"
    }
  ],
  "cursor": "2026-09-04T10:15:00.000Z",
  "hasMore": false
}
```

### GET `/api/reports/:id`

The status poll for one of the reporter's own reports — the whole Art. 16
loop in one document, so a lost email never costs the reporter their
confirmation or their outcome.

**Response (200):**

```json
{
  "report": {
    "id": "cmr…",
    "reportType": "CONTENT",
    "resourceType": "post",
    "resourceId": "clx123abc",
    "categoryKey": "harassment",
    "status": "decided",
    "createdAt": "2026-09-04T10:15:00.000Z"
  },
  "receipt": {
    "confirmed": true,
    "receivedAt": "2026-09-04T10:15:00.000Z",
    "title": "…",
    "body": "…"
  },
  "decision": {
    "outcome": "actioned",
    "decidedAt": "2026-09-05T09:00:00.000Z",
    "title": "…",
    "body": "…"
  },
  "statementOfReasons": {
    "restriction": "…",
    "issuedAt": "2026-09-05T09:00:00.000Z"
  },
  "remedies": { "title": "…", "body": "…" }
}
```

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `receipt`            | Art. 16(4). Always present — the row's existence _is_ the receipt                                                                                                                                                                                                                                                                                            |
| `decision`           | Art. 16(5). `null` until the report is `decided`; `outcome` is `actioned` or `rejected`, with the matching copy                                                                                                                                                                                                                                              |
| `statementOfReasons` | Art. 17, as far as it concerns the reporter: the **fact** that a restriction was applied and its kind. `null` before a decision, for a `rejected` report (nothing was restricted), and always for a _suppressed_ statement — the anti-tip-off carve-out is never leaked back through this door. Never the affected user, the template key, or its parameters |
| `remedies`           | Art. 16(5) redress information; travels with the decision. Core ships a neutral, deliberately non-jurisdictional fallback — a deployment supplies its own via `setReportTemplates`                                                                                                                                                                           |

`title`/`body` copy comes from the deployment's templates, with core's neutral
fallback where none is configured.

**Errors:** `404 {"error":"NOT_FOUND"}` for a report that does not exist **or
belongs to someone else** — the two are indistinguishable, so ids cannot be
enumerated. `401`, `500`.

`/api/reports/mine` and `/api/reports/:id` share a path shape; the handler
resolves the literal `mine` to the listing explicitly, so `mine` is never
treated as a report id whatever the router's tie-break.

## Admin routes

- **Authentication:** JWT Bearer via the auth middleware
  (`401` otherwise), then **`SUPER_ADMIN`** global role
  (`403 {"error":"FORBIDDEN"}` otherwise, checked before any read).
- **CSRF:** required on the `POST` routes.

### GET `/api/admin/content-reports`

The `CONTENT` review queue, **oldest first** — Art. 16 handling is
deadline-bearing, so the item that has waited longest is shown first. LINK and
ACCOUNT reports are not in this queue; they keep their own surface under
`/api/admin/reports`.

**Query parameters:**

| Parameter      | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `status`       | `pending` \| `acknowledged` \| `decided` — anything else is `400 VALIDATION_ERROR`           |
| `categoryKey`  | Exact match                                                                                  |
| `routingClass` | `ILLEGAL_PRIORITY` \| `ILLEGAL` \| `POLICY_VIOLATION` \| `FEEDBACK` — anything else is `400` |
| `limit`        | Default `50`, clamped to `1..100`                                                            |
| `cursor`       | The `createdAt` of the last item on the previous page                                        |

**Response (200):**

```json
{
  "reports": [
    {
      "id": "cmr…",
      "resourceType": "post",
      "resourceId": "clx123abc",
      "categoryKey": "harassment",
      "routingClass": "POLICY_VIOLATION",
      "reporterUserId": "cmq…",
      "reason": null,
      "status": "pending",
      "resolution": null,
      "resolvedAt": null,
      "createdAt": "2026-09-04T10:15:00.000Z"
    }
  ],
  "hasMore": false,
  "cursor": "2026-09-04T10:15:00.000Z"
}
```

`routingClass` **is** returned here (unlike the reporter-facing category list),
so an operator can triage without the category vocabulary at hand.

### POST `/api/admin/content-reports/:id/decision`

Drive the lifecycle `pending → acknowledged → decided`.

**Request body:**

```json
{ "status": "decided", "resolution": "actioned" }
```

| Field        | Constraint                                                        |
| ------------ | ----------------------------------------------------------------- |
| `status`     | `acknowledged` \| `decided`                                       |
| `resolution` | `actioned` \| `rejected`; **required** when `status` is `decided` |

Deciding goes through the lifecycle mechanism, which is what sends the
reporter their Art. 16(5) decision notice — a report cannot be decided without
its reporter being notified.

**Response (200):**

```json
{ "success": true, "report": { "id": "cmr…", "status": "decided", "resolution": "actioned" } }
```

**Errors:**

| Status | `error`              | When                                                                                                            |
| ------ | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `400`  | `INVALID_JSON`       | Body is not JSON                                                                                                |
| `400`  | `VALIDATION_ERROR`   | Unknown `status`, or `decided` without a `resolution`                                                           |
| `403`  | `FORBIDDEN`          | Caller is not `SUPER_ADMIN`                                                                                     |
| `404`  | `NOT_FOUND`          | No such report, or the id names a LINK/ACCOUNT report — the wrong state machine is never entered                |
| `409`  | `INVALID_TRANSITION` | Illegal transition (for example deciding an already-decided report); the existing decision is never overwritten |

### Report-category administration

`SUPER_ADMIN`, JWT Bearer, CSRF on writes:

| Route                                               | Purpose                                                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/report-categories`                  | All categories, including inactive                                                                                                                                                  |
| `POST /api/admin/report-categories`                 | Upsert by `key`. Body: `{ key, routingClass, labels: Record<string,string>, active?, sortOrder? }`. `400 INVALID_JSON` / `VALIDATION_ERROR`                                         |
| `POST /api/admin/report-categories/:key/deactivate` | Sets `active: false` and writes an audit event; `404 NOT_FOUND` for an unknown key, `409 CONFLICT` if the category is already inactive. Response `{ ok: true, key, active: false }` |

## What a consuming application must wire

Core ships neutral fallbacks and **fail-safe defaults**: the evidence store and
the moderation-feedback sink throw until configured, the authority channel is a
manual no-op. Before activating any `ILLEGAL_*` category, inject:
`setEvidencePreservationStore`, `setAuthorityReportChannel`,
`setModerationFeedbackSink`, `setStatementDelivery`, `setComplianceAlarmHook`,
`setOperatorAlertHook`, and `setReportTemplates` for the localized reporter
copy.

The evidence hold is honoured where it matters: the nightly hard-delete of
soft-deleted media, the account-deletion media erasure, and the orphaned-media
purge all skip an original under a live hold, so evidence is never purged
while a case is open.

## See also

- [Compliance](../security-and-privacy/compliance.md) — where this sits in the
  obligations map.
- [Blocks API](./blocks-api.md) — the other user-side remedy.
