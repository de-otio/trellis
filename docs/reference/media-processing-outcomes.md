# Media processing outcomes and the recovery sweep

Reference for `processMediaMessage`, `planRecovery` and `sweepMedia`, and for
the optional port members a consuming application implements to get the full
behaviour. Every method below is **optional and additive**: an application that
implements none of them keeps the behaviour it had before.

## `processMediaMessage(body, deps, clock)`

Processes one queue message and returns a `ProcessingOutcome`, independent of
the queue transport.

| Outcome                                   | Meaning                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `{ kind: "done" }`                        | Nothing more to do for this message.                                   |
| `{ kind: "retry", reason }`               | Try again now.                                                         |
| `{ kind: "defer", delaySeconds, reason }` | Capacity, not a fault: come back after `delaySeconds`. Not an attempt. |

`clock` is `{ mediaAgeSeconds, maxMediaAgeSeconds }`. The maximum is operator
config; core has no default.

Rules, in the order they apply:

1. A media object whose lifecycle is neither `UPLOADED` nor `AWAITING_UPLOAD`
   (the bytes-arrived transition is still driven) is `done`, before any work.
2. A persisted cleaned version (a `stagingVersionId` and a real `contentHash`
   on the row) is reused. The transcode is not run again and the pin is never
   replaced.
3. Every track about to start is reserved with one `reserveTracks` call, before
   the first provider start.
4. Only tracks without a live row are started. A row is live when it has a job
   id and is not superseded; a reserved placeholder is started again.
5. A `ModerationProviderError` with `capacity: true`, and the daily spend gate,
   give `defer` with `config.deferDelaySeconds`. With no delay configured they
   are handled as a retryable fault. Deferring is bounded by the media's age: at
   or past `maxMediaAgeSeconds` the object is settled to REVIEW on the
   `technical` ground (rule 6) instead of deferred again.
6. A retryable fault is `retry` while `mediaAgeSeconds < maxMediaAgeSeconds`.
   At or past the bound the object is settled to REVIEW on the `technical`
   ground (compare-and-set from `UPLOADED`) and the message is `done`.
7. A non-retryable fault settles REVIEW on the `unprocessable` ground
   (compare-and-set from `UPLOADED`) and the message is `done`.

`processObjectKey` and `processRecord` keep their shape: they run the same core
with a clock that can never reach the bound, and map outcomes back to the
`ack` / `fail` dispositions.

### Optional members this uses

| Member                                                         | Where                                                            | Needed for rules                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `reserveTracks(mediaId, tracks)`                               | `deps.store` (same signature as `CompletionStore.reserveTracks`) | 3                                                                                         |
| `listModerationJobs(mediaId)`                                  | `MediaPersistencePort`                                           | 4                                                                                         |
| `holdForReview(mediaId, { ground, expectedFrom })` → `boolean` | `MediaPersistencePort`                                           | 6, 7 (compare-and-set; without it `markMediaForReview` is used, unconditional, no ground) |
| `stagingVersionId`, `contentHash`, `hasAudio`                  | `MediaFileRow`                                                   | 2                                                                                         |
| `hasAudio`                                                     | `persistCleanedContent` argument                                 | 2 (so a reuse knows whether an AUDIO job is due)                                          |
| `deferDelaySeconds`                                            | `MediaProcessingConfig`                                          | 5                                                                                         |
| `pinnedVersion`, `superseded`                                  | `ModerationJobRow`                                               | read by the consuming application's store; the stock Prisma store returns neither         |

## `planRecovery({ media, now, config })`

Pure. At most one action per candidate, in input order.

| Candidate                                                                              | Action                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `UPLOADED`, age ≥ `maxMediaAgeSeconds`                                                 | `settle-technical` (wins over re-enqueue) |
| `UPLOADED`, older than `settleWindowSeconds`, a track missing a live row (or no track) | `reenqueue-processing`                    |
| `APPROVED`, older than `settleWindowSeconds`, `casObjectPresent === false`             | `repair-promotion`                        |
| anything else, anything inside the settle window                                       | none                                      |

## `sweepMedia(deps)`

Reads up to `batchSize` candidates through `MediaRecoveryStore`, plans, and
executes. With no config (or an invalid one, per `validateRecoverySweepConfig`)
it is disabled and logs one WARN.

- `settle-technical` uses the normal fan-in: an undecided track counts as
  review, an absent track is not approval, and a quarantined track still wins.
- Every lifecycle write is a compare-and-set through `settleMedia`; there is no
  claim or dedupe row, so two sweepers running together produce one transition.
- `repair-promotion` calls the existing pinned promotion, then announces `ready`
  through `emitResolved` (best-effort): the completion that approved the object
  could not, because its own promotion failed. If a settle lands on APPROVED
  (both tracks had approved, nothing settled the object), the sweep promotes
  first and announces afterwards.
- `enqueueProcessing(mediaId)` is called on every run while an object stays
  stalled; core keeps no record of what it already re-sent, so the consumer
  should make it idempotent per object (a deduplication id, or a check for a
  message already in flight).

`MediaRecoveryStore` has three members: `findRecoveryCandidates`, `settleMedia`
and `findMedia`. The sweep runs before the stale-upload reaper; see
`lib/media/stale-media-reap.ts`.

## Schema

`media_moderation_jobs.job_id` is nullable so `reserveTracks` can store a
placeholder. The change is additive; the existing unique index is unchanged
and admits any number of NULLs.
