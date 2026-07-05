# Storage accounting — the shared invariant (T15 ⇄ T16, AR7)

**This is the ONE pinned-decisions section.** The per-tenant storage quota
(T16), the video cost & scale lifecycle guardrails (T15, consumer CDK), and
the GDPR media-erasure path (AR7) all derive from the object-state predicate
defined here and implemented in
[`apps/api/src/lib/media/storage-accounting.ts`](../../../apps/api/src/lib/media/storage-accounting.ts).
Do not restate these decisions elsewhere — link here.

## The invariant

Every stored S3 object falls into **exactly one** of two buckets; their union
is the total. No object may escape both — an object that neither counts
against a user's quota nor is platform-reclaimed is unbounded free storage
(a cost leak and an abuse channel).

### Bucket 1 — counts against the tenant's quota ⇒ user-reclaimable

A `MediaFile` row counts against its tenant's storage quota **iff**

```
lifecycle === APPROVED  &&  deletedAt IS NULL
```

(`quotaUsageWhere()` in `storage-accounting.ts` — both upload gates build
their usage aggregate through it.)

- **APPROVED only.** Users are never charged quota for content the platform
  blocked (`REVIEW` / `QUARANTINED` / `REJECTED`) or that never finished
  uploading (`AWAITING_UPLOAD` / `UPLOADED` / `UPLOAD_FAILED`).
- **Deletion frees quota immediately.** Soft-delete (setting `deletedAt`)
  excludes the row from the usage aggregate in the same instant.
- **Hard delete within N = 7 days.** The nightly cron's soft-deleted-media
  purge (`apps/api/src/lambda/nightly-cron.ts`, step 1) hard-deletes rows with
  `deletedAt` older than 7 days and batch-deletes their S3 objects (respecting
  CAS reference counting via `hasOtherLiveCasReference`).

### Bucket 2 — does NOT count ⇒ platform-reclaimed on a short TTL

Non-approved rows and abandoned/incomplete upload sessions. Bounded by:

- **Review-rate cap** (`env.media.reviewRateCap`, `MEDIA_REVIEW_RATE_CAP`,
  SSM-fed): once a tenant accumulates `cap` flagged objects
  (`REVIEW`/`QUARANTINED`) inside the rolling window (**24 h** default,
  `MEDIA_REVIEW_RATE_WINDOW_MS`), new uploads are denied with 429 at both
  upload gates (`apps/api/src/lib/media/review-rate-cap.ts`).
- **DB rows — abandonment TTL X = 24 h.** The stale-media reap
  (`apps/api/src/lib/media/stale-media-reap.ts`; hourly cron + scheduled job)
  deletes non-verdict rows (`AWAITING_UPLOAD`/`UPLOADED`/`UPLOAD_FAILED`)
  older than 24 h (`MEDIA_STALE_REAP_WINDOW_MS`) that the moderation pipeline
  never engaged. Verdict states are never reaped: `REVIEW`/`QUARANTINED`
  await a human; `REJECTED` carries the audit trail.
- **S3 staging bytes — consumer bucket lifecycle rules** (skybber `CdnStack`,
  media bucket):
  - `pending/` (raw direct-upload staging) **expires after 3 days** — longer
    than the 24 h DB reap and equal to the processing queue's 3-day message
    retention, so a redrivable message never points at expired bytes.
  - `processing/` (cleaned-but-unapproved bytes) **expires after 30 days** —
    the moderation-SLA bound for a human `REVIEW`/`QUARANTINED` verdict.
    A verdict older than that is an operational failure to surface, not bytes
    to keep.
  - `cas/` (approved, served bytes) never expires by lifecycle; it is
    reclaimed only through bucket 1 (user delete → nightly purge). Cold `cas/`
    objects transition to Intelligent-Tiering after 30 days (cost, not
    retention).

## Pinned decisions (the quick table)

| Decision | Value | Where enforced |
|---|---|---|
| Lifecycle values that count against quota | `APPROVED` only (and `deletedAt IS NULL`) | `quotaUsageWhere()`, both upload gates |
| Soft-delete frees quota | immediately | usage aggregate excludes `deletedAt != null` |
| Hard-delete window **N** | **7 days** after soft-delete | nightly cron step 1 |
| Abandonment TTL **X** (DB rows) | **24 h** (`MEDIA_STALE_REAP_WINDOW_MS`) | stale-media reap |
| `pending/` S3 staging expiry | **3 days** | consumer bucket lifecycle rule |
| `processing/` S3 staging expiry | **30 days** (moderation SLA bound) | consumer bucket lifecycle rule |
| Review-rate cap window | **24 h** (`MEDIA_REVIEW_RATE_WINDOW_MS`) | upload gates (429) |

Quota **limits** are a separate axis: effective limit =
`Tenant.storageQuotaBytes/`​`storageQuotaObjects` override `??` the SSM-fed
env default (`MEDIA_QUOTA_MAX_BYTES` / `MEDIA_QUOTA_MAX_OBJECTS`) — see
`apps/api/src/lib/media/quota-resolution.ts`. Operative values live in the
consumer's SSM, never in this repo (threshold-secrecy: the published tarball
must not carry a real quota).

## Verification

The four-case integration test
(`apps/api/test/integration/storage-accounting.integration.test.ts`) pins the
invariant end-to-end against a real Postgres:

1. upload → approve **counts** against quota;
2. upload → quarantine does **not** count (and sits in the TTL'd bucket);
3. delete frees quota immediately (and the nightly-purge scope picks the row
   up after N days);
4. an abandoned session leaves no counted bytes and falls inside the reap
   scope.
