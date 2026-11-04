---
title: Hosting the media workers in your own process
description: How to bind the media-processing and media-completion cores to your own queue consumer — what the host must provide (backoff, deferral, receive-count handling, graceful drain) and what the stock worker does and does not run.
sidebar: Hosting media workers
order: 12
---

# Hosting the media workers in your own process

Trellis ships the two media consumers as **cores**: functions that take one
message and a bag of injected dependencies and return an outcome. They own the
media logic. They do not own the queue. Receiving, acking, delaying, retrying
and shutting down are the host's job — the host being your own worker process,
built on whatever SQS-shaped consumer library you prefer.

The stock worker (`apps/worker`) does **not** run these queues: it wires none of
their dependencies. See [Stock worker queue selection](#stock-worker-queue-selection).

## The surface

All from the package root, `@de-otio/trellis`:

| Export | Kind | Purpose |
|---|---|---|
| `processMediaMessage(record, deps)` | function | Process one `media-processing` message. |
| `MediaProcessingDeps` | type | Everything the processing core needs, injected. |
| `MediaProcessingRecordOutcome` | type | `ack` (optionally `poison`) or `fail`. |
| `handleMediaCompletion(body, deps)` | function | Process one `media-completion` message. |
| `CompletionDeps`, `CompletionStore` | types | Everything the completion core needs, injected. |
| `MediaCompletionRecordOutcome` | type | `applied`, `escalated`, `not-terminal`, `awaiting-sibling`, `lost-race`, `duplicate`, `unroutable`, `illegal-transition` or `retry`. |

Supporting types for building the dependency bags: `QueueRecordLike`,
`MediaProcessingConfig`, `MediaPersistencePort`, `MediaFileRow`,
`MediaWorkerLogger`, `StoragePort`, `TranscodePort`, `TranscribePort`,
`MediaSpendGuardPort`, `MetricsPort`, `CompletionCascade`,
`EscalationResultPort`.

The outcome and timing shapes a host can reason about without importing the cores are also at the root: `ProcessingOutcome` (`done` / `retry` / `defer`), `ProcessingClock`, and the recovery-sweep types (`MediaRecoverySweepConfig`, `RecoveryAction`, `RecoveryCandidate`, `RecoveryTrackState`, `CompletionQueueTiming`, with `validateRecoverySweepConfig`). These are types and a pure validator only; the orchestration still returns the record outcomes above.

Both cores expose a record named `RecordOutcome` internally; they are exported
under the two distinct names above so both fit at the package root.

There is no Prisma client and no module-global setter in this surface. Pass
your dependencies as arguments; do not rely on process-wide injection.

## Mapping an outcome to a queue action

| Outcome | Host action |
|---|---|
| processing `ack` (incl. `poison`) | Delete the message. |
| processing `fail` | Do **not** delete. Leave it for redelivery (with backoff, below). |
| completion `applied`, `escalated`, `not-terminal`, `awaiting-sibling`, `lost-race` | Delete the message. |
| completion `duplicate`, `unroutable`, `illegal-transition` | Delete the message — terminal, and must never loop to the dead-letter queue. |
| completion `retry` | Do **not** delete. Leave it for redelivery. |
| the core **throws** | Treat as `fail`. Never convert a throw into a delete. |

A message that you cannot parse or route at all is the cores' business, not the
host's — hand it over and act on the outcome.

## What the host must provide

### Backoff

The cores say *whether* to retry, never *when*. A host that redelivers a failed
message immediately will hammer a struggling dependency. Provide backoff: on
`fail`/`retry`, extend the message's visibility timeout so the next attempt
happens after a delay that grows with the number of attempts, with jitter and a
ceiling. Do the same for your *receive* loop when the queue itself is
unreachable, so a broken connection does not become a hot loop.

### Deferral is a re-send with a delay, not an attempt

If the host decides a message is not ready to be processed yet (a dependency
is down, a circuit breaker is open, you are draining), that is a **deferral**,
not a failure. Implement it by sending a *new* copy of the message with a
delivery delay and then deleting the original. Do not return it to the queue
via a visibility change or a failed handler: that raises the receive count and
walks a perfectly good message toward the dead-letter queue.

Send first, delete second. If the send fails, leave the original in place and
treat it as a failure.

### The receive count

The queue's receive count is the only attempt counter there is, and the
redrive policy acts on it. Understand what feeds it:

- every redelivery after a `fail`/`retry`/throw increments it — that is the
  point, and it is what eventually dead-letters a message that can never
  succeed;
- a deferral, being a fresh message, resets it. Cap deferrals yourself (a
  maximum count carried in a message attribute, plus a circuit breaker), or a
  permanently-blocked message will cycle forever without ever reaching the
  dead-letter queue.

Use the receive count to scale your backoff, and alarm on the dead-letter
queue, not on the first failure.

### Graceful drain

On shutdown signal:

1. stop receiving new messages;
2. let in-flight handlers finish, bounded by a drain timeout shorter than your
   orchestrator's kill timeout;
3. delete messages that completed; leave the rest. An unfinished message
   simply becomes visible again after its visibility timeout — the cores are
   idempotent on redelivery;
4. only then close database pools and clients.

Never delete a message because it was in flight when you were told to stop.

## Dependencies

You inject everything: storage, transcode, transcribe, moderation provider,
persistence, spend guard, metrics, logger. Core ships no concrete adapters for
them. Construct your dependency bags once at start-up and reuse them; keep
secrets out of the bags where the port does not need them.

## Stock worker queue selection

The stock worker reads `WORKER_ENABLED_QUEUES`, a comma-separated list of queue
names (`delete-account`, `media-processing`, `media-completion`, `link-check`,
`followers-events`, `federation-outbox`, `user-export`).

- **Unset:** every queue is consumed, except a queue whose dependencies are not
  wired in the process. The media queues are only consumed when their
  dependencies are wired, which the stock worker does not do — so by default it
  does not poll them. Messages on those queues wait for your own host.
- **Set:** exactly the listed queues. Listing a queue whose dependencies are
  not wired, or a name that is not a queue, is a configuration error: the
  process logs it and exits non-zero before touching any secret or queue.

Run the stock worker with `WORKER_ENABLED_QUEUES` listing only the queues it
should own, and your own host on the media queues, so the two never consume the
same queue.
