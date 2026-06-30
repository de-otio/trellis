---
title: Async Processing
description: How Trellis handles background work via SQS queues and EventBridge Scheduler.
sidebar: Async Processing
order: 14
---

# Async Processing: SQS + EventBridge

## SQS Queues

The API process binds six SQS queues (`apps/api/src/env.ts`): `user-export`, `delete-account`, `followers-events`, `link-check`, `media-processing`, and `media-reconciliation`. Each has a corresponding dead-letter queue (DLQ) for failed messages. Concrete per-queue tuning (visibility timeout, retention) is owned by the deploying application's infrastructure, not by Trellis.

| Queue | Worker | Purpose | Status |
|-------|--------|---------|--------|
| `user-export` | (export handler) | GDPR/data-portability exports | Implemented |
| `delete-account` | `delete-account-worker` | Account deletion pipeline | Implemented |
| `media-processing` | `media-processing-worker` | Transcode video/audio + start moderation tracks | Implemented |
| `media-reconciliation` | `media-reconciliation-worker` | Reconcile uploaded media into DB rows | Implemented |
| `link-check` | `link-check-worker` | Link security verification | Stub (`TODO: implement`) |
| `followers-events` | `followers-events-worker` | Follower fan-out events | Stub (`TODO: implement`) |

The `media-completion-worker` (which fans in the moderation tracks and promotes
approved bytes) is triggered by moderation-completion events wired in the
deploying application's infrastructure, not by an API-bound queue. See
[Media Moderation](media-moderation.md).

> Outbound ActivityPub delivery does **not** use an SQS queue. Activities are delivered through Fedify directly; see [ActivityPub federation](activitypub.md).

### DLQ Alarm

A CloudWatch alarm fires when any DLQ has messages (> 0), indicating processing failures that need attention.

## Lambda ↔ SQS Integration

Each queue triggers a dedicated Lambda function via an **event source mapping**:

```typescript
new SqsEventSource(mediaProcessingQueue, {
  batchSize: 5,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true, // Only retry failed messages, not the whole batch
});
```

**Key settings:**
- `reportBatchItemFailures: true` — only retry failed messages, not the whole batch
- `maxBatchingWindow` — wait up to N seconds to batch messages (reduces Lambda invocations)
- `batchSize` — process multiple messages per invocation (amortizes cold start cost)

## Recursive Lambda Protection

**Critical guardrail**: Prevent Lambda → SQS → Lambda infinite loops.

### Safeguards

1. **Max receive count = 3** on all queues — after 3 processing failures, message goes to DLQ
2. **Reserved concurrency limits** on all worker Lambdas — caps parallel executions
3. **Message deduplication** — `ApproximateReceiveCount` is checked in handlers; a warning is logged if > 1
4. **Circuit breaker in code** — if a handler detects it's re-processing the same message, it skips:

```typescript
export async function handleMessage(record: SQSRecord) {
  const receiveCount = parseInt(record.attributes.ApproximateReceiveCount);
  if (receiveCount > 2) {
    console.warn(`Message ${record.messageId} received ${receiveCount} times, skipping`);
    return; // Will go to DLQ after max receives
  }
  // ... process normally
}
```

## EventBridge Scheduler (Cron Jobs)

Each schedule invokes a dedicated Lambda.

| Schedule | Lambda | Purpose |
|----------|--------|---------|
| Every 5 minutes | `cleanupCron` | Expired sessions, temp tokens |
| Hourly | `hourlyCron` | Metrics aggregation, feed cache |
| Nightly | `nightlyCron` | Media reconciliation trigger, exports |
| Nightly (offset) | `maintenanceCron` | Orphan cleanup |

### Cron Lambda Guardrails

- **Timeout**: Short timeout — crons should be fast; heavy work goes to SQS
- **Concurrency**: Reserved = 1 (only one instance at a time)
- **Idempotent**: All cron jobs must be safe to re-run (EventBridge guarantees at-least-once delivery)
- **DynamoDB lock**: Prevents overlapping executions (see [compute.md](compute.md))
- **EventBridge DLQ**: Failed invocations go to a dead-letter queue
- **Retry policy**: Limited retries with a short maximum event age — prevents stale cron invocations piling up

## S3 Event Notifications

S3 sends an event to the `media-processing` queue when a video/audio object lands under the `pending/` prefix (the prefix the upload path writes for async media):

```typescript
mediaBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(mediaProcessingQueue),
  { prefix: 'pending/' },
);
```

The `media-processing-worker` Lambda picks up the event, transcodes-and-discards
the upload to a clean staging key, hashes the cleaned bytes, and starts the
VISUAL + AUDIO moderation tracks. The `media-completion-worker` later fans in
both tracks and, on approval, promotes the cleaned bytes to the served `cas/`
prefix. Images are not processed here — they are re-encoded synchronously in the
API upload handler. See [Media Moderation](media-moderation.md) and
[Storage & CDN](storage-and-cdn.md).

> The exact S3-event wiring (which prefix triggers which queue) is owned by the
> deploying application's infrastructure; the snippet above shows the shape.

## Summary

| Queue / Schedule | Service | Purpose |
|------------------|---------|---------|
| `user-export` | SQS | GDPR/data-portability exports |
| `delete-account` | SQS | Account deletion pipeline |
| `link-check` | SQS | Safe Browsing validation |
| `media-processing` | SQS | Async video/audio transcode + moderation |
| `media-reconciliation` | SQS | Reconcile uploaded media into DB rows |
| `followers-events` | SQS | Follower fan-out events |
| Every 5 minutes | EventBridge | Expired sessions, temp tokens |
| Hourly | EventBridge | Metrics aggregation, feed cache |
| Nightly | EventBridge | Media reconciliation, exports |
| Nightly (offset) | EventBridge | Orphan cleanup |
