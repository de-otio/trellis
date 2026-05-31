# Async Processing: SQS + EventBridge

## SQS Queues

Each queue has a corresponding dead-letter queue (DLQ) for failed messages.

### Queue Configuration

| Queue | DLQ | Visibility Timeout | Max Receive | Retention | Purpose |
|-------|-----|-------------------|-------------|-----------|---------|
| `delete-account` | `delete-account-dlq` | 120s | 3 | 7 days | Account deletion pipeline |
| `media-processing` | `media-processing-dlq` | 120s | 3 | 3 days | Image resize/optimize |
| `media-reconciliation` | `media-reconciliation-dlq` | 60s | 3 | 3 days | Orphaned media cleanup |
| `link-check` | `link-check-dlq` | 30s | 3 | 1 day | Link security verification |
| `federation-outbox` | `federation-outbox-dlq` | 30s | 3 | 3 days | Outgoing ActivityPub delivery |

### DLQ Alarm

A CloudWatch alarm fires when any DLQ has messages (> 0), indicating processing failures that need attention.

```typescript
// CDK
new Alarm(this, 'DlqAlarm', {
  metric: dlqQueue.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  treatMissingData: TreatMissingData.NOT_BREACHING,
  actionsEnabled: true,
  alarmActions: [snsTopic],
});
```

## Lambda ↔ SQS Integration

Each queue triggers a dedicated Lambda function via an **event source mapping**:

```typescript
// CDK
new SqsEventSource(mediaProcessingQueue, {
  batchSize: 5,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true, // Partial batch failure support
});
```

**Key settings**:
- `reportBatchItemFailures: true` — only retry failed messages, not the whole batch
- `maxBatchingWindow` — wait up to N seconds to batch messages (reduces Lambda invocations)
- `batchSize` — process multiple messages per invocation (amortize cold start)

## Recursive Lambda Protection

**Critical guardrail**: Prevent Lambda → SQS → Lambda infinite loops.

### Safeguards

1. **Max receive count = 3** on all queues — after 3 processing failures, message goes to DLQ
2. **Reserved concurrency limits** on all worker Lambdas — caps parallel executions
3. **Message deduplication** — check for `ApproximateReceiveCount` in handler; log warning if > 1
4. **Circuit breaker in code** — if a handler detects it's re-processing the same message, skip it:

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

| Schedule | Expression | Lambda | Purpose |
|----------|-----------|--------|---------|
| Every 5 min | `rate(5 minutes)` | `cleanupCron` | Expired sessions, temp tokens |
| Hourly | `rate(1 hour)` | `hourlyCron` | Metrics aggregation, feed cache |
| Nightly (2 AM) | `cron(0 2 * * ? *)` | `nightlyCron` | Media reconciliation trigger, exports |
| Maintenance (3 AM) | `cron(0 3 * * ? *)` | `maintenanceCron` | DB vacuum hints, orphan cleanup |

### Cron Lambda Guardrails

- **Timeout**: 60s max (crons should be fast; heavy work goes to SQS)
- **Concurrency**: Reserved = 1 (only one instance at a time)
- **Idempotent**: All cron jobs must be safe to re-run (EventBridge guarantees at-least-once)
- **DynamoDB lock**: Prevents overlapping executions (see [02-compute.md](02-compute.md))
- **EventBridge DLQ**: Failed invocations go to a dead-letter queue (see [02-compute.md](02-compute.md))
- **Retry policy**: Max 1 retry, max event age 5 minutes — prevents stale cron invocations piling up

## S3 Event Notifications

S3 → SQS for media upload processing:

```typescript
// CDK
mediaBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(mediaProcessingQueue),
  { prefix: 'originals/' },
);
```

When a file lands in `originals/`, S3 sends an event to the `media-processing` queue. The `mediaProcessingWorker` Lambda picks it up, processes the image, and writes derivatives back to S3.

## Queue and Schedule Summary

| Queue / Schedule | Service | Purpose |
|------------------|---------|---------|
| `delete-account` | SQS | Account deletion pipeline |
| `link-check` | SQS | Safe Browsing validation |
| `media-reconciliation` | SQS | Storage consistency checks |
| `media-processing` | SQS | Async image processing |
| `federation-outbox` | SQS | Outgoing ActivityPub delivery (feature-gated) |
| Every 5 min | EventBridge | Expired sessions, temp tokens |
| Hourly | EventBridge | Metrics aggregation, feed cache |
| Nightly (2 AM) | EventBridge | Media reconciliation, exports |
| Maintenance (3 AM) | EventBridge | DB vacuum hints, orphan cleanup |
