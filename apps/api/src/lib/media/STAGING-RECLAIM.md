# Staging-object reclamation: the gap the purge does not close

**2026-08-08.** Written while fixing the nightly purge's orphan bug. This
records a *remaining* gap, deliberately not fixed in that change, and why.

## What is reclaimed today

| Key shape | Reclaimed by | Trigger |
|---|---|---|
| `cas/{tenantId}/{contentHash}` (approved bytes) | nightly purge, `workers/nightly-cron.ts` step 1 | `MediaFile.deletedAt` older than 7 days |
| `pending/{tenantId}/{uploadId}`, `processing/{tenantId}/{contentHash}` (staging) | `deleteStagingObjects`, called once by each account-deletion path | account deletion only |
| staging for abandoned uploads | `scheduled/media-stale-cleanup.ts` | PENDING/FAILED rows past the reap window |

## The gap

**Staging objects have exactly one delete attempt, and no retry.**

`user-media-erasure.ts` does not read staging keys from a column — it *derives*
them from the `MediaFile` row, via `pendingKey(tenantId, uploadId)` and
`processingKey(tenantId, contentHash)`. So the keys exist only as long as the
row does.

The account-deletion paths soft-delete those rows and then call
`deleteStagingObjects` once. If that call fails, both callers now log at
`error` and mark the completion record `stagingCleanupIncomplete` — but nothing
retries. The row survives (soft-deleted) for the purge's 7-day window, so the
keys remain *derivable* for a week; after the purge hard-deletes the row, the
staging objects are unreachable and unattributable. Nothing in the system will
ever name them again.

The purge itself does not attempt staging keys at all. It deletes only
`originalKey` / `thumbnailKey` / `optimizedKey`.

## Why the obvious fix is not obviously safe

Have the purge delete each row's staging keys too, just before hard-deleting
it. That would make the whole thing self-healing: a staging delete that failed
during account deletion gets retried nightly for seven days, and — with the
orphan fix — the row is not purged until every one of its keys is gone.

The hazard is `processing/{tenantId}/{contentHash}`. That key is derived from
the **content hash**, which is shared by every row with identical bytes in the
tenant. Purging user A's soft-deleted row would delete a staging object that
user B's live, mid-processing upload is using. The account-deletion path is
safe from this only because `user-media-erasure.ts` runs the shared-storage
predicate first and *retains* any row still referenced by another user — the
purge has no equivalent guard.

So the fix needs the same predicate applied at purge time: delete
`processing/…` only when no live row shares `(tenantId, contentHash)`. That is
correct and doable, but it is a data-loss-shaped change, and it belongs in its
own change with its own tests rather than riding along with a fix whose whole
point was to stop deleting things prematurely.

`pending/{tenantId}/{uploadId}` has no such hazard — `uploadId` is unique per
upload — so it could be reclaimed by the purge independently, and that is the
smaller first step.

## Not addressed here either

- **No durable record of a failed erasure.** `stagingCleanupIncomplete` reaches
  a log line, not a table. A queryable one would let an Art. 17 response be
  answered accurately, and would let a sweep retry from the record rather than
  from a row that is about to be purged.
- **A permanently-unacceptable key now stalls its row forever.** The orphan fix
  defers such a row indefinitely, and it keeps consuming the purge's `take: 200`
  budget on every run. `purgeDeferred` in the "Soft-deleted media purged" log
  makes it observable — a count that only grows is the signal — but nothing
  escalates. An attempt counter would need a column.
