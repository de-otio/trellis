# Compute: ECS Fargate (Primary) + Lambda (Workers)

## Architecture Decision

**ECS Fargate** handles all API traffic (user-facing and, when enabled, ActivityPub). **Lambda** handles event-driven workloads (queue workers, cron jobs, Cognito triggers, image processing). See [15-ecs-vs-lambda.md](15-ecs-vs-lambda.md) for the full analysis and [16-fargate-best-practices.md](16-fargate-best-practices.md) for the Fargate configuration details.

## Why Hybrid

| Workload | Runtime | Reason |
|----------|---------|--------|
| API (`/api/*`, `/health`) | ECS Fargate | Long-lived process, native DB pooling, no cold starts |
| ActivityPub endpoints | ECS Fargate (same container) | Same process, same DB pool |
| SQS queue workers | Lambda | Sporadic, scales to zero, isolated per queue |
| Cron jobs | Lambda | Runs briefly, scales to zero |
| Image processing | Lambda | CPU-burst with Sharp, scales to zero |
| Cognito triggers | Lambda | Required by Cognito |

## ECS Fargate: API Service

Full configuration in [16-fargate-best-practices.md](16-fargate-best-practices.md). Key specs:

```
Task size:      0.25 vCPU / 0.5 GB (ARM64 Graviton)
Desired count:  1 (auto-scales to 4)
Capacity:       FARGATE_SPOT (dev), FARGATE (prod base)
Networking:     Private subnet, ALB in public subnet
DB access:      Prisma connection pool (no RDS Proxy needed)
Sidecar:        X-Ray daemon
```

### Request Flow

```
Client → CloudFront → ALB (HTTPS:443) → Fargate (port 3000) → RDS PostgreSQL
                                                             → DynamoDB (cache)
                                                             → SQS (async work)
                                                             → SES (email)
```

### Route Handling

All routes are handled by the same Fargate container. The existing TypeScript route registry works as-is — no Lambda adapter needed, just a standard Node.js HTTP server:

```typescript
// server.ts
import { createServer } from 'node:http';
import { handleRequest } from './router';

const server = createServer(async (req, res) => {
  const response = await handleRequest(toWebRequest(req));
  writeResponse(res, response);
});

server.listen(3000, () => {
  console.log('API listening on port 3000');
});
```

Routes previously split across Lambda functions (API, ActivityPub, redirect) are all handled by one process. HTTP Signature verification for ActivityPub runs as middleware, not a separate function.

## Lambda: Queue Workers

One Lambda per SQS queue for isolation and independent scaling. These Lambdas are **not in VPC** — they don't need direct RDS access. They write results to DynamoDB or SQS, and the Fargate API reads from there.

| Function | Queue | Concurrency | Timeout | VPC | Purpose |
|----------|-------|-------------|---------|-----|---------|
| `deleteAccountWorker` | `delete-account` | 2 | 60s | Yes (RDS) | Account deletion pipeline |
| `mediaProcessingWorker` | `media-processing` | 3 | 60s | No | Image resize/optimize with Sharp |
| `mediaReconciliationWorker` | `media-reconciliation` | 5 | 30s | Yes (RDS) | Orphaned media cleanup |
| `linkCheckWorker` | `link-check` | 5 | 15s | No | Link security verification → DynamoDB |
| `federationOutboxWorker` | `federation-outbox` | 5 | 15s | No | Outgoing ActivityPub delivery |

**VPC placement rationale**: Only workers that need to read/write RDS are in the VPC. Workers that only interact with DynamoDB, S3, SQS, or external APIs run outside the VPC — faster cold starts, no NAT dependency for external API calls.

### Lambda Configuration (All Workers)

```
Runtime:        Node.js 22.x
Architecture:   arm64 (Graviton — 20% cheaper)
Memory:         256 MB (512 MB for mediaProcessingWorker)
```

### SQS Event Source Mapping

```typescript
// CDK
new SqsEventSource(queue, {
  batchSize: 5,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true,
});
```

## Lambda: Cron Jobs

Triggered by EventBridge Scheduler. Each has `reservedConcurrency: 1` to prevent overlap.

| Function | Schedule | Timeout | VPC | Purpose |
|----------|----------|---------|-----|---------|
| `cleanupCron` | `rate(5 minutes)` | 60s | No | Expired sessions, temp tokens (DynamoDB) |
| `hourlyCron` | `rate(1 hour)` | 60s | Yes (RDS) | Metrics aggregation, feed cache refresh |
| `nightlyCron` | `cron(0 2 * * ? *)` | 60s | Yes (RDS) | Enqueue media reconciliation, exports |
| `maintenanceCron` | `cron(0 3 * * ? *)` | 60s | Yes (RDS) | Orphan cleanup |

### Overlap Prevention

Cron Lambdas are idempotent and use a DynamoDB lock to prevent overlapping executions:

```typescript
export async function withCronLock(name: string, fn: () => Promise<void>) {
  const lockKey = `cronlock:${name}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Acquire lock (fails if already held and not expired)
    await docClient.put({
      TableName: TABLE,
      Item: { pk: lockKey, sk: 'lock', ttl: now + 300, holder: process.env.AWS_LAMBDA_LOG_STREAM_NAME },
      ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': now },
    });
  } catch (e) {
    if ((e as any).name === 'ConditionalCheckFailedException') {
      console.warn(`Cron ${name} skipped — previous execution still running`);
      return;
    }
    throw e;
  }

  try {
    await fn();
  } finally {
    // Release lock
    await docClient.delete({ TableName: TABLE, Key: { pk: lockKey, sk: 'lock' } });
  }
}
```

### EventBridge Scheduler Configuration

```typescript
// CDK
new scheduler.CfnSchedule(this, 'CleanupSchedule', {
  name: `${stage}-cleanup`,
  scheduleExpression: 'rate(5 minutes)',
  flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 2 },
  target: {
    arn: cleanupCronFn.functionArn,
    roleArn: schedulerRole.roleArn,
    retryPolicy: {
      maximumRetryAttempts: 1,  // Retry once on failure
      maximumEventAgeInSeconds: 300,  // Drop if > 5 min old
    },
    deadLetterConfig: { arn: cronDlqArn },  // DLQ for failed invocations
  },
});
```

## Lambda: Cognito Triggers

Required by Cognito — must be Lambda. These are lightweight and infrequent.

| Function | Trigger | Concurrency | Timeout | VPC |
|----------|---------|-------------|---------|-----|
| `preSignUpTrigger` | Pre sign-up | 5 | 10s | No |
| `postConfirmationTrigger` | Post confirmation | 5 | 10s | Yes (RDS) |
| `preTokenGenerationTrigger` | Pre token generation | 10 | 5s | No |
| `customMessageTrigger` | Custom message | 5 | 5s | No |

`preTokenGenerationTrigger` reads from DynamoDB cache (not RDS directly) — see [05-auth.md](05-auth.md). This keeps it outside the VPC for fast cold starts.

## Lambda Concurrency Summary

| Function | Reserved Concurrency |
|----------|---------------------|
| `deleteAccountWorker` | 2 |
| `mediaProcessingWorker` | 3 |
| `mediaReconciliationWorker` | 5 |
| `linkCheckWorker` | 5 |
| `federationOutboxWorker` | 5 |
| `cleanupCron` | 1 |
| `hourlyCron` | 1 |
| `nightlyCron` | 1 |
| `maintenanceCron` | 1 |
| `preSignUpTrigger` | 5 |
| `postConfirmationTrigger` | 5 |
| `preTokenGenerationTrigger` | 10 |
| `customMessageTrigger` | 5 |
| **Total reserved** | **50** |

Well under the 100 account-wide limit requested in [09-cost-controls.md](09-cost-controls.md).
