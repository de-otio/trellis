# Observability: Logging, Monitoring, Tracing

## Logging

### Fargate API: Structured Logging with Pino

The Fargate API is a long-lived Node.js process. Use `pino` for structured JSON logging:

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'trellis-api',
    stage: process.env.STAGE,
  },
});

// Usage
logger.info({ postId, authorId, visibility }, 'Post created');
logger.warn({ userId, remaining: 5 }, 'Rate limit approaching');
logger.error({ err, query: 'findPosts' }, 'Database query failed');
```

### Lambda Workers: AWS Lambda Powertools

Lambda workers and crons use Lambda Powertools for structured logging with automatic request context:

```typescript
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({
  serviceName: 'trellis-worker',
  logLevel: process.env.LOG_LEVEL ?? 'INFO',
});
```

### Log Groups

| Log Group | Source | Retention |
|-----------|--------|-----------|
| `/ecs/{stage}/api` | Fargate API container | 14 days |
| `/ecs/{stage}/xray` | X-Ray sidecar | 7 days |
| `/aws/lambda/{stage}-*Worker` | Lambda queue workers | 7 days |
| `/aws/lambda/{stage}-*Cron` | Lambda cron jobs | 7 days |
| `/aws/lambda/{stage}-*Trigger` | Cognito trigger Lambdas | 7 days |
| `/aws/rds/instance/*/postgresql` | RDS slow query log | 14 days |

**Always set retention** in CDK. The default is "never expire", which means unbounded CloudWatch costs.

### Log Levels

| Environment | Default Level | Override |
|-------------|--------------|----------|
| dev | debug | `LOG_LEVEL` env var |
| prod | info | `LOG_LEVEL` env var |

### Correlation IDs

Every request gets a correlation ID passed through all layers:

```
Client → CloudFront → ALB → Fargate → SQS message → Worker Lambda
                              ↓            ↓               ↓
                          X-Request-Id  messageAttribute  requestId
```

The Fargate API generates a UUID for each request (or reads `X-Request-Id` from the ALB). When enqueuing SQS messages, propagate it:

```typescript
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(payload),
  MessageAttributes: {
    correlationId: { DataType: 'String', StringValue: requestId },
  },
}));
```

## Tracing (X-Ray)

### Fargate: X-Ray Sidecar

The X-Ray daemon runs as a sidecar container (see [16-fargate-best-practices.md](16-fargate-best-practices.md)). The API container sends traces to `localhost:2000`.

Use the `aws-xray-sdk` in the application:

```typescript
import AWSXRay from 'aws-xray-sdk-core';
import { PrismaClient } from '@prisma/client';

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

### Lambda Workers: Built-in X-Ray

Lambda workers use `tracing: lambda.Tracing.ACTIVE` (set in GuardedLambda construct). No sidecar needed — Lambda has native X-Ray integration.

### X-Ray Cost

- Free tier: 100K traces/month
- Beyond: $5 per million traces
- At low traffic (~300K requests/month), sampling at 10% = 30K traces → free

### Sampling Rules

```typescript
// CDK
new xray.CfnSamplingRule(this, 'ApiSamplingRule', {
  samplingRule: {
    ruleName: 'trellis-api',
    resourceARN: '*',
    priority: 1000,
    fixedRate: 0.1,     // 10% of requests
    reservoirSize: 5,   // 5 requests/sec guaranteed
    serviceName: 'trellis-api',
    serviceType: '*',
    host: '*',
    httpMethod: '*',
    urlPath: '*',
    version: 1,
  },
});
```

## Metrics (CloudWatch)

### Built-In Metrics (Free)

ECS Container Insights (enabled on cluster) provides:
- Task CPU utilization, memory utilization
- Network bytes in/out, storage read/write
- Running/pending task count

ALB automatically emits:
- `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_4XX`, `HTTPCode_Target_5XX`
- `HealthyHostCount`, `UnHealthyHostCount`

Lambda automatically emits:
- `Invocations`, `Duration`, `Errors`, `Throttles`, `ConcurrentExecutions`

RDS automatically emits:
- `CPUUtilization`, `DatabaseConnections`, `FreeableMemory`, `ReadIOPS`, `WriteIOPS`, `FreeStorageSpace`

### Custom Metrics (EMF)

Use CloudWatch Embedded Metrics Format for zero-cost custom metrics. Emit structured JSON log lines that CloudWatch automatically extracts as metrics:

```typescript
import { createMetricsLogger, Unit } from 'aws-embedded-metrics';

export async function emitMetric(name: string, value: number, dimensions: Record<string, string> = {}) {
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

### Key Custom Metrics

| Metric | Dimensions | Purpose |
|--------|-----------|---------|
| `PostCreated` | visibility | Content creation rate |
| `MediaUploaded` | mimeType | Upload patterns |
| `AuthFailed` | reason | Security monitoring |
| `ExternalApiCall` | service (openai, google) | Cost tracking |
| `BudgetRemaining` | category | Budget consumption rate |
| `FederationActivity` | type (inbox, outbox) | ActivityPub traffic |
| `RateLimited` | endpoint | Rate limit effectiveness |

## Alarms

### Critical Alarms (→ Email/SNS)

| Alarm | Metric | Threshold | Purpose |
|-------|--------|-----------|---------|
| API Error Rate | ALB HTTPCode_Target_5XX | > 5% for 5 min | API is failing |
| API Latency | ALB TargetResponseTime p99 | > 5s for 5 min | API is slow |
| Unhealthy Targets | ALB UnHealthyHostCount | > 0 for 2 min | Fargate task down |
| DB CPU | RDS CPUUtilization | > 80% for 10 min | DB overloaded |
| DB Connections | RDS DatabaseConnections | > 60 for 5 min | Connection exhaustion |
| DB Storage | RDS FreeStorageSpace | < 4 GB | Disk filling up |
| DLQ Messages | SQS ApproximateNumberOfMessagesVisible | > 0 for 1 min | Worker failures |
| Budget | MonthlySpend | > 80% of budget | Cost overrun |

### Warning Alarms (→ Email only)

| Alarm | Metric | Threshold | Purpose |
|-------|--------|-----------|---------|
| Lambda Throttles | Throttles | > 5 in 5 min | Hitting concurrency limit |
| DynamoDB Write Spike | ConsumedWriteCapacityUnits | > 500 in 5 min | Unusual write activity |
| External API Errors | ExternalApiError (custom) | > 10 in 5 min | Third-party issues |

### Alarm Actions

```typescript
// CDK
const alertTopic = new sns.Topic(this, 'Alerts');
alertTopic.addSubscription(new subs.EmailSubscription('admin@example.com'));

// All critical alarms → this topic
criticalAlarm.addAlarmAction(new cwa.SnsAction(alertTopic));
```

## Dashboard

A CloudWatch dashboard providing at-a-glance operational visibility:

```typescript
// CDK
const dashboard = new cloudwatch.Dashboard(this, 'TrellisDashboard', {
  dashboardName: `${stage}-trellis`,
  widgets: [
    // Row 1: API Health (ALB metrics)
    [
      new GraphWidget({ title: 'API Requests', left: [albRequestCount] }),
      new GraphWidget({ title: 'API Latency (p50/p99)', left: [albP50, albP99] }),
      new GraphWidget({ title: 'API Errors (4xx/5xx)', left: [alb4xx, alb5xx] }),
    ],
    // Row 2: Fargate
    [
      new GraphWidget({ title: 'Fargate CPU', left: [taskCpu] }),
      new GraphWidget({ title: 'Fargate Memory', left: [taskMemory] }),
      new GraphWidget({ title: 'Running Tasks', left: [runningTasks] }),
    ],
    // Row 3: Database
    [
      new GraphWidget({ title: 'DB CPU', left: [dbCpu] }),
      new GraphWidget({ title: 'DB Connections', left: [dbConnections] }),
      new GraphWidget({ title: 'DB Free Storage', left: [dbStorage] }),
    ],
    // Row 4: Queues & Workers
    [
      new GraphWidget({ title: 'SQS Messages', left: queueMetrics }),
      new GraphWidget({ title: 'DLQ Depth', left: dlqMetrics }),
      new GraphWidget({ title: 'Lambda Errors', left: lambdaErrors }),
    ],
  ],
});
```

## Cost of Observability

| Service | Estimated Monthly Cost |
|---------|----------------------|
| CloudWatch Logs (~1 GB ingested) | $0.50 |
| CloudWatch Container Insights | $0.30 |
| CloudWatch Alarms (~20, 10 free) | $1.00 |
| X-Ray (30K traces, free tier) | $0.00 |
| **Total** | **~$1.80** |

> Skip the $3/month CloudWatch Dashboard initially. Use the free CloudWatch Metrics console and Container Insights console instead.
