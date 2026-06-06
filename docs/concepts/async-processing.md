---
title: Async Processing
description: How Trellis handles background work via SQS queues and EventBridge Scheduler.
sidebar: Async Processing
order: 14
---

# Async Processing: SQS + EventBridge

## SQS Queues

Each queue has a corresponding dead-letter queue (DLQ) for failed messages.

| Queue | Visibility Timeout | Max Receive Count | Retention | Purpose |
|-------|-------------------|-------------------|-----------|---------|
| `delete-account` | 120s | 3 | 7 days | Account deletion pipeline |
| `media-processing` | 120s | 3 | 3 days | Image resize/optimize |
| `media-reconciliation` | 60s | 3 | 3 days | Orphaned media cleanup |
| `link-check` | 30s | 3 | 1 day | Link security verification |
| `federation-outbox` | 30s | 3 | 3 days | Outgoing ActivityPub delivery |

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

S3 sends an event to the `media-processing` queue when a file lands in `originals/`:

```typescript
mediaBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(mediaProcessingQueue),
  { prefix: 'originals/' },
);
```

The `mediaProcessingWorker` Lambda picks up the event, processes the image with Sharp, and writes derivatives back to S3.

## Summary

| Queue / Schedule | Service | Purpose |
|------------------|---------|---------|
| `delete-account` | SQS | Account deletion pipeline |
| `link-check` | SQS | Safe Browsing validation |
| `media-reconciliation` | SQS | Storage consistency checks |
| `media-processing` | SQS | Async image processing |
| `federation-outbox` | SQS | Outgoing ActivityPub delivery (feature-gated) |
| Every 5 minutes | EventBridge | Expired sessions, temp tokens |
| Hourly | EventBridge | Metrics aggregation, feed cache |
| Nightly | EventBridge | Media reconciliation, exports |
| Nightly (offset) | EventBridge | Orphan cleanup |
