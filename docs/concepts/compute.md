---
title: Compute
description: How Trellis splits API traffic across ECS Fargate and Lambda workers.
sidebar: Compute
order: 11
---

# Compute: ECS Fargate (API) + Lambda (Workers)

## Architecture Decision

**ECS Fargate** handles all API traffic (user-facing and, when enabled, ActivityPub). **Lambda** handles event-driven workloads: queue workers, cron jobs, Cognito triggers, and image processing.

## Why Hybrid

| Workload | Runtime | Reason |
|----------|---------|--------|
| API (`/api/*`, `/health`) | ECS Fargate | Long-lived process, native DB pooling, no cold starts |
| ActivityPub endpoints | ECS Fargate (same container) | Same process, same DB pool |
| SQS queue workers | Lambda | Sporadic, scales to zero, isolated per queue |
| Cron jobs | Lambda | Runs briefly, scales to zero |
| Image processing | Lambda | CPU-burst workload, scales to zero |
| Cognito triggers | Lambda | Required by Cognito |

## ECS Fargate: API Service

The API runs as a single Node.js process on ARM64 Fargate. Key properties:

- ARM64 architecture (Graviton)
- Private subnet placement; ALB in public subnet
- Prisma connection pool (no RDS Proxy needed)
- X-Ray sidecar for distributed tracing
- Auto-scales between a minimum and a hard maximum for cost control

### Request Flow

```
Client → CloudFront → ALB (HTTPS) → Fargate (port 3000) → RDS PostgreSQL
                                                         → DynamoDB (cache)
                                                         → SQS (async work)
                                                         → SES (email)
```

### Route Handling

All routes are handled by the same Fargate container. `server.ts` runs a standard Node.js `http` server that converts Node's `IncomingMessage`/`ServerResponse` to and from the Web Fetch `Request`/`Response` types, then dispatches into a [Hono](https://hono.dev/) app — no Lambda adapter needed:

```typescript
// server.ts (simplified)
import http from 'node:http';
import { buildHonoApp } from './lib/app';

const honoApp = buildHonoApp();

const server = http.createServer(async (req, res) => {
  const webRequest = toWebRequest(req);
  const response = await honoApp.fetch(webRequest, { trellisEnv: env, requestContext });
  writeResponse(res, response);
});

server.listen(parseInt(process.env.PORT || '3000', 10));
```

Routes for API, ActivityPub, and redirects are all handled by one process. HTTP Signature verification for ActivityPub runs as middleware.

## Lambda: Queue Workers

One Lambda per SQS queue for isolation and independent scaling. Workers that only interact with DynamoDB, S3, SQS, or external APIs run outside VPC — faster cold starts, no NAT dependency for external calls.

The queues bound by the API process (`apps/api/src/env.ts`) are `user-export`, `delete-account`, `followers-events`, `link-check`, and `media-processing`.

| Function | Queue | VPC | Purpose | Status |
|----------|-------|-----|---------|--------|
| `delete-account-worker` | `delete-account` | Yes (RDS) | Account deletion pipeline | Implemented |
| `media-processing-worker` | `media-processing` | No | Image resize/optimize with Sharp | Implemented |
| `link-check-worker` | `link-check` | No | Link security verification → DynamoDB | Stub (`TODO: implement`) |
| `followers-events-worker` | `followers-events` | Yes (RDS) | Follower fan-out events | Stub (`TODO: implement`) |
| `media-reconciliation-worker` | (not bound in env) | Yes (RDS) | Orphaned media cleanup | Stub (`TODO: implement`) |
| `federation-outbox-worker` | (not bound in env) | No | Outgoing ActivityPub delivery | Stub (`TODO: implement`) |

> **Note on outbound federation.** There is no `federation-outbox` queue wired into the API process. Outgoing ActivityPub activities are delivered through Fedify directly (`deliverActivityWithFedify` in `apps/api/src/lib/activitypub/services/fedify-delivery.ts`); `federation-outbox-worker.ts` is a placeholder. See [ActivityPub federation](activitypub.md).

### SQS Event Source Mapping

```typescript
new SqsEventSource(queue, {
  batchSize: 5,
  maxBatchingWindow: Duration.seconds(10),
  reportBatchItemFailures: true,
});
```

## Lambda: Cron Jobs

Triggered by EventBridge Scheduler. Each has `reservedConcurrency: 1` to prevent overlap.

| Function | Schedule | VPC | Purpose |
|----------|----------|-----|---------|
| `cleanupCron` | every 5 minutes | No | Expired sessions, temp tokens (DynamoDB) |
| `hourlyCron` | every hour | Yes (RDS) | Metrics aggregation, feed cache refresh |
| `nightlyCron` | nightly | Yes (RDS) | Enqueue media reconciliation, exports |
| `maintenanceCron` | nightly (offset) | Yes (RDS) | Orphan cleanup |

### Overlap Prevention

Cron Lambdas are idempotent and use a DynamoDB lock to prevent overlapping executions:

```typescript
export async function withCronLock(name: string, fn: () => Promise<void>) {
  const lockKey = `cronlock:${name}`;
  const now = Math.floor(Date.now() / 1000);

  try {
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
    await docClient.delete({ TableName: TABLE, Key: { pk: lockKey, sk: 'lock' } });
  }
}
```

## Lambda: Cognito Triggers

Required by Cognito — must be Lambda. These are lightweight and infrequent.

| Function | Trigger | VPC |
|----------|---------|-----|
| `preSignUpTrigger` | Pre sign-up | No |
| `postConfirmationTrigger` | Post confirmation | Yes (RDS) |
| `preTokenGenerationTrigger` | Pre token generation | No |
| `customMessageTrigger` | Custom message | No |

`preTokenGenerationTrigger` reads from the DynamoDB claims cache rather than hitting RDS directly — keeping it outside the VPC for faster cold starts.
