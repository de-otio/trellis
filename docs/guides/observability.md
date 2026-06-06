---
title: Observability
description: How Trellis instruments logging, tracing, metrics, and alarms.
sidebar: Observability
order: 50
---

# Observability

Trellis ships as an npm library, not a deployed service. It provides
**structured logging** and the hooks needed for tracing and metrics; the
surrounding observability stack — log groups and their retention, dashboards,
alarms, and notification wiring — is owned and provisioned by the consuming
application, not by Trellis. The infrastructure-level material below
(CloudWatch log groups, X-Ray topology, alarm thresholds, CDK snippets) is
illustrative of how a consuming application typically wires this up; the
concrete names, retentions, and thresholds are that application's policy.

## Logging

### API process: the shared `getLogger()` logger

The API is a long-lived Node.js process. Logging goes through Trellis's logger
adapter (`apps/api/src/lib/logger.ts`), which delegates to
`@de-otio/saas-foundation`'s pino-backed, structured, request-context-aware
logger. Call sites resolve the logger with `getLogger()` and use a positional
`(message, data?)` shape — they do **not** construct `pino` directly:

```typescript
import { getLogger } from "../lib/logger";

const logger = getLogger();

logger.info("Post created", { postId, authorId, visibility });
logger.warn("Rate limit approaching", { userId, remaining: 5 });
logger.error("Database query failed", { err, query: "findPosts" });
```

Inside a request scope the resolved logger automatically carries
`requestId`/`tenantId` context. The log level is taken from `LOG_LEVEL`.

### Lambda workers: AWS Lambda Powertools

Lambda workers and cron functions use Lambda Powertools for structured logging with automatic request context:

```typescript
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({
  serviceName: 'trellis-worker',
  logLevel: process.env.LOG_LEVEL ?? 'INFO',
});
```

### Log groups and retention

| Log group | Source | Retention |
|-----------|--------|-----------|
| `/ecs/{stage}/api` | API container | 14 days |
| `/ecs/{stage}/xray` | X-Ray sidecar | 7 days |
| `/aws/lambda/{stage}-*Worker` | Queue workers | 7 days |
| `/aws/lambda/{stage}-*Cron` | Cron jobs | 7 days |
| `/aws/lambda/{stage}-*Trigger` | Cognito triggers | 7 days |
| `/aws/rds/instance/*/postgresql` | RDS slow query log | 14 days |

Always set explicit retention in CDK — the default is "never expire", which leads to unbounded CloudWatch costs.

### Log levels

| Environment | Default level | Override |
|-------------|--------------|----------|
| dev | debug | `LOG_LEVEL` env var |
| prod | info | `LOG_LEVEL` env var |

### Correlation IDs

Every request receives a correlation ID that propagates through all layers:

```
Client → CloudFront → ALB → Fargate → SQS message → Worker Lambda
                              ↓            ↓               ↓
                          X-Request-Id  messageAttribute  requestId
```

The API generates a UUID per request (or reads `X-Request-Id` from the ALB). Propagate it when enqueuing SQS messages:

```typescript
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(payload),
  MessageAttributes: {
    correlationId: { DataType: 'String', StringValue: requestId },
  },
}));
```

---

## Tracing (X-Ray)

> The Trellis package does not bundle `aws-xray-sdk` or `aws-embedded-metrics`;
> the patterns in this section are how a consuming application that runs on AWS
> typically adds tracing and custom metrics around Trellis. Treat them as
> integration guidance, not shipped Trellis code.

### API process: X-Ray sidecar

The X-Ray daemon runs as a sidecar container. The API sends traces to `localhost:2000`.

Use `aws-xray-sdk` in the application:

```typescript
import AWSXRay from 'aws-xray-sdk-core';

// Capture all outgoing HTTP calls
AWSXRay.captureHTTPsGlobal(require('http'));
AWSXRay.captureHTTPsGlobal(require('https'));

// Custom subsegments for important operations
export async function handleGetPosts(req: Request) {
  const segment = AWSXRay.getSegment()!;
  const subsegment = segment.addNewSubsegment('getPosts');

  try {
    const posts = await db.post.findMany({ /* ... */ });
    subsegment.addAnnotation('postCount', posts.length);
    return posts;
  } catch (err) {
    subsegment.addError(err as Error);
    throw err;
  } finally {
    subsegment.close();
  }
}
```

### Lambda workers: built-in X-Ray

Lambda workers use `tracing: lambda.Tracing.ACTIVE`. No sidecar is needed — Lambda has native X-Ray integration.

---

## Metrics (CloudWatch)

### Built-in metrics (no cost)

**ECS Container Insights** (enabled on cluster):
- Task CPU and memory utilization
- Network bytes in/out, storage read/write
- Running and pending task count

**ALB:**
- `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_4XX`, `HTTPCode_Target_5XX`
- `HealthyHostCount`, `UnHealthyHostCount`

**Lambda:**
- `Invocations`, `Duration`, `Errors`, `Throttles`, `ConcurrentExecutions`

**RDS:**
- `CPUUtilization`, `DatabaseConnections`, `FreeableMemory`, `ReadIOPS`, `WriteIOPS`, `FreeStorageSpace`

### Custom metrics (Embedded Metrics Format)

Use CloudWatch Embedded Metrics Format to emit custom metrics via structured log lines at no extra cost:

```typescript
import { createMetricsLogger, Unit } from 'aws-embedded-metrics';

export async function emitMetric(
  name: string,
  value: number,
  dimensions: Record<string, string> = {},
) {
  const metrics = createMetricsLogger();
  metrics.setNamespace('Trellis');
  for (const [k, v] of Object.entries(dimensions)) {
    metrics.setDimensions({ [k]: v });
  }
  metrics.putMetric(name, value, Unit.Count);
  await metrics.flush();
}

// Usage
await emitMetric('PostCreated', 1, { visibility: 'PUBLIC' });
await emitMetric('ExternalApiCall', 1, { service: 'openai' });
```

**Key custom metrics:**

| Metric | Dimensions | Purpose |
|--------|-----------|---------|
| `PostCreated` | visibility | Content creation rate |
| `MediaUploaded` | mimeType | Upload patterns |
| `AuthFailed` | reason | Security monitoring |
| `ExternalApiCall` | service | Cost tracking |
| `FederationActivity` | type (inbox, outbox) | ActivityPub traffic |
| `RateLimited` | endpoint | Rate limit effectiveness |

---

## Alarms

### Critical alarms

| Alarm | Metric | Threshold | Purpose |
|-------|--------|-----------|---------|
| API Error Rate | ALB `HTTPCode_Target_5XX` | > 5% for 5 min | API is failing |
| API Latency | ALB `TargetResponseTime` p99 | > 5 s for 5 min | API is slow |
| Unhealthy Targets | ALB `UnHealthyHostCount` | > 0 for 2 min | Task is down |
| DB CPU | RDS `CPUUtilization` | > 80% for 10 min | DB overloaded |
| DB Connections | RDS `DatabaseConnections` | > 60 for 5 min | Connection exhaustion risk |
| DB Storage | RDS `FreeStorageSpace` | < 4 GB | Disk filling up |
| DLQ Messages | SQS `ApproximateNumberOfMessagesVisible` | > 0 for 1 min | Worker failures |

### Warning alarms

| Alarm | Metric | Threshold | Purpose |
|-------|--------|-----------|---------|
| Lambda Throttles | `Throttles` | > 5 in 5 min | Approaching concurrency limit |
| DynamoDB Write Spike | `ConsumedWriteCapacityUnits` | > 500 in 5 min | Unusual write activity |
| External API Errors | `ExternalApiError` (custom) | > 10 in 5 min | Third-party issues |

### Wiring alarms to notifications (CDK example)

```typescript
const alertTopic = new sns.Topic(this, 'Alerts');
alertTopic.addSubscription(new subs.EmailSubscription('admin@example.com'));

criticalAlarm.addAlarmAction(new cwa.SnsAction(alertTopic));
```
