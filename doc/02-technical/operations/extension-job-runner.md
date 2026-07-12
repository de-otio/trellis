# Extension job runner (O-1)

An extension declares scheduled work via `TrellisExtension.jobs` (see
[Scheduled jobs](../../../docs/reference/extension-api.md#scheduled-jobs) for
the author-facing contract). This note is the operator/architecture view: where
the runner executes, how single-flight is enforced, and how a job's timeout
and lock recovery behave. Implementation:
[`apps/api/src/lib/extension-job-runner.ts`](../../../apps/api/src/lib/extension-job-runner.ts).

## Where it runs — the API container, not a worker Lambda

Declared jobs run **in-process inside the API container** (the `server.ts`
process, started by `startExtensionJobRunners()` at boot alongside the rest of
extension registration). This is deliberate, not incidental: the worker
Lambdas (`apps/api/src/lambda/*.ts`, bundled from `@de-otio/trellis/dist/lambda/*`)
load **zero** extensions — nothing in that bundle path calls
`registerExtension`. An extension's job body, its `crossTenantRead` models,
and its dependency graph exist only inside the process that registered the
extension, so the API container is the only place a job can run.

Practically: a job runs on **every** API task in the Fargate service (dev and
prod both run more than one task under normal load), on a plain
`setInterval` sized to its declared `schedule` (`"hourly"` → 3,600,000 ms,
`"daily"` → 86,400,000 ms). The interval is `unref()`'d so it never keeps the
process alive on its own. Cluster-wide single-flight — making sure only one
task's tick actually executes the job body on a given cadence — is the lock's
job, not the interval's.

## Single-flight lock — DynamoDB conditional put

The lock generalizes the existing `hourly-cron.ts` conditional-put idiom, with
two fixes that idiom does not have (both required once the cadence and the
job-body duration can vary per extension job, unlike the fixed-shape hourly
cron):

- **Partition key**: `job:<extensionId>:<jobId>` (`jobLockPk`), `sk: "lock"`,
  in the same KV table the rest of the platform's DynamoDB single-table design
  uses (`DYNAMODB_TABLE`, or `${stage}-trellis` if unset).
- **Acquire**: a conditional `PutItem` —
  `attribute_not_exists(pk) OR #ttl < :now` — so a task acquires the lock
  either when nothing holds it, or when the current holder's TTL has already
  expired (crash recovery: a task that died mid-job releases nothing, and the
  next tick after TTL expiry picks the lock back up automatically).
- **TTL = `timeoutSeconds + marginSeconds`, not a flat hour.** The
  `hourly-cron` idiom this was generalized from used a flat one-hour TTL,
  which is fine for a fixed hourly job but would badly over-hold the lock for
  a fast job on a short cadence — a 30-second job under an hour-TTL lock would
  self-block every other task (and every later tick on the same task) for
  the rest of the hour if it crashed without releasing. The TTL here is sized
  to the job's own declared timeout (default 300 s) plus a safety margin
  (default 60 s), so a crashed holder's lock expires shortly after its own
  timeout would have fired anyway.
- **`lockToken` + conditional release.** On acquire, the runner writes a fresh
  `crypto.randomUUID()` as `lockToken` alongside the lock item. Release is a
  conditional `DeleteItem` — `ConditionExpression: "lockToken = :myToken"` —
  never an unconditional delete. This closes a lock-stealing race the
  `hourly-cron` idiom doesn't need to worry about (its TTL and duration are
  fixed): if task A's job overruns its TTL, task B can legitimately re-acquire
  the (expired) lock and start its own run. When task A's overrun body finally
  finishes and tries to release, its `lockToken` no longer matches — the
  conditional delete is a silent no-op, and it never deletes task B's live
  lock.

## Timeout and abort

The job body (`job.run(ctx)`) is wrapped in `Promise.race` against a
`setTimeout(timeoutSeconds * 1000)`. If the timer fires first:

1. The runner calls `AbortController.abort()` on the `signal` passed into the
   job context (a cooperative cancellation point a job body can observe; not
   a forced kill — Node has no safe way to interrupt an in-flight `await`).
2. The race rejects with `JobTimeoutError`.
3. The lock is released in a `finally` (conditionally, per the token check
   above) regardless of whether the body threw, timed out, or completed.

A job's failure — timeout or any thrown error — is logged and swallowed at
the tick level (`runJobOnce` never throws); a rejected tick can never bubble
into an unhandled rejection or take down the API process's timer loop.

## What a job can touch

The job context handed to `run()` is built **by construction** so the only
cross-tenant reads possible are the models the manifest declared in
`crossTenantRead` — resolving an undeclared model at context-build time throws
`UndeclaredJobModelError` before the body ever executes, so a typo or an
attempt to read an undeclared table fails loudly and immediately rather than
silently returning `undefined`. Per-row writes go through `ctx.tenant(tid)`,
which re-mints the row's tenant id with `"job"` provenance
(`mint-tenant-id.ts`, forensic/audit logging only — not a security boundary)
and hands back the same enforce-always scoped `ScopedDb` extension request
handlers use. There is no other path to a core model or to a write from
inside a job body.

## Current status (O-1 v1)

No extension in this repository declares a job yet — `@skybber/ext-dogs` owns
routes and taxonomy seed data, not tables, so the runner registers zero
timers today (`startExtensionJobRunners` no-ops cleanly when
`ext.jobs` is absent on every registered extension). The mechanism is infra
ahead of its first consumer, by design; see the O-1 design document (§5.2/§12.4)
for the worked example (a cross-tenant due-date sweep) this was built for.
