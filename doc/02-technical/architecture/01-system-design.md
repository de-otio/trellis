# System Design

## Architecture at a Glance

| Component | AWS Service | Notes |
|-----------|------------|-------|
| API compute | ECS Fargate (ARM64 Graviton, Spot) | Long-lived Node.js process, native DB pooling |
| Load balancer | Application Load Balancer (ALB) | HTTPS termination, health-checked routing |
| CDN | CloudFront + OAC | Routes `/api/*`, `/media/*`, `/*` to different origins |
| Database | RDS PostgreSQL 16 (db.t4g.micro, single AZ) | Prisma ORM, built-in connection pooling — source of truth for content, auth, media |
| Graph database | Neo4j AuraDB (Cypher over Bolt) | Social graph: scored relationships, circle tiers, typed entity edges, post-subject visibility. Managed externally (Neo4j Aura console) by the consuming deployment; not provisioned by CDK — see [14-graph-and-circles.md](14-graph-and-circles.md) |
| KV / cache / rate-limiting | DynamoDB (single table, on-demand) | 15+ namespaces, TTL-based expiry |
| Auth | Amazon Cognito (user pools) | Pre-token Lambda trigger caches claims in DynamoDB |
| Object storage | S3 (media + web app) | Direct client uploads via presigned URLs |
| Background workers | Lambda (ARM64) | SQS consumers, cron jobs, image processing |
| Message queues | SQS (6 queues + 6 DLQs) | Activity, deletion, media, link-check, federation-inbox, federation-outbox |
| Scheduled jobs | EventBridge Scheduler + Lambda | DLQ + DynamoDB locks prevent double-execution |
| Email | AWS SES | Cost-tracked via CostAccumulator |
| Image processing | Lambda + Sharp | On-demand resize/transcode from S3 originals |
| Federation | Fedify library (in ECS container) | ActivityPub inbox/outbox, signatures |
| Observability | CloudWatch Logs + Metrics + X-Ray | Dashboards, alarms, distributed traces |
| IaC | AWS CDK (TypeScript) | 8 stacks, SSM-only inter-stack communication |
| Secrets | AWS Secrets Manager + SSM | DB credentials in Secrets Manager; IDs in SSM |

## Request Flow

### API Request (Flutter → Fargate)

```
Flutter app
    │  HTTPS
    ▼
CloudFront Distribution
    │  /api/* → forward to ALB origin
    ▼
Application Load Balancer (HTTPS:443)
    │  target group: Fargate tasks
    ▼
ECS Fargate — API Container (Node.js)
    │
    ├── Prisma → RDS PostgreSQL  (content, auth, media — source of truth)
    ├── GraphService → Neo4j AuraDB  (circles, relationships, discovery — Bolt, password from Secrets Manager)
    ├── DynamoDB                 (cache, rate limits, feature flags)
    └── SQS                      (enqueue async work, including graph-sync retries)
```

### Circle View (Dual-Gated Visibility)

Circle reads and writes are split across Postgres and Neo4j AuraDB:

```
Client: GET /api/circles/0  (inner circle)
    │
    ▼
Fargate API — circle-handler
    │
    ├── GraphService → Neo4j AuraDB
    │     Cypher: viewer -[RELATES_TO]-> target
    │             filtered by tier & post radius
    │     returns: post IDs ordered by createdAt
    │
    └── Prisma → RDS
          fetches post content, author, media for those IDs
    │
    ▼
merge + return JSON
```

Writes fan out in the opposite direction: Postgres first (source of truth), then a best-effort GraphService sync. Failed graph writes enqueue to an SQS retry queue; a reconciliation worker can rebuild the graph from Postgres if needed. See [14-graph-and-circles.md](14-graph-and-circles.md#dual-write-contract).

### Media Upload

```
Flutter app
    │  GET /api/media/upload-url
    ▼
Fargate API
    │  generates presigned S3 PUT URL (15-min TTL)
    ▼
Flutter app
    │  PUT directly to S3 (presigned URL — bypasses API)
    ▼
S3 bucket (originals/)
    │  S3 event notification
    ▼
SQS media-processing queue
    │
    ▼
Lambda (Sharp) — resize, transcode, store derivatives
```

### Media Delivery

```
Flutter app
    │  HTTPS /media/*
    ▼
CloudFront
    │  /media/* → S3 origin (via OAC — bucket is not public)
    ▼
S3 (immutable cache headers, 1-year TTL at edge)
```

### Background Work (SQS → Lambda)

```
Fargate API
    │  enqueue message
    ▼
SQS queue (visibility timeout = Lambda timeout × 1.5)
    │  trigger
    ▼
Lambda worker
    │  success → message deleted
    │  failure × 3 → DLQ
    ▼
DLQ alarm → SNS → email alert
```

### Cron Jobs (EventBridge → Lambda)

```
EventBridge Scheduler (cron expression)
    │
    ▼
Lambda cron handler
    │  acquire DynamoDB lock (prevents double-run)
    ├── do work
    └── release lock
```

## Key Design Decisions

### Fargate for the API, Lambda for workers

**Decision**: The HTTP API runs in ECS Fargate. Background workers (SQS consumers, crons, image processing, Cognito triggers) run in Lambda.

**Rationale**: Lambda's pay-per-invocation model carries hidden fixed costs — RDS Proxy ($22/month, required for connection management) and NAT Gateway ($32/month, required for VPC egress). These costs accrue before a single user request is processed, totaling $54/month in "serverless tax."

Fargate eliminates both: a long-lived process manages its own Prisma connection pool (no RDS Proxy), and the Fargate task can run in a public subnet or behind a NAT Instance ($3/month). The result is a cheaper and simpler API tier with no cold starts and consistent P99 latency.

Lambda remains the right choice for workers because those workloads are sporadic — they run only when triggered, scale to zero between invocations, and don't benefit from a persistent connection pool.

Cost comparison at pre-launch traffic (~10K req/day):

| Option | Monthly total |
|--------|-------------|
| Lambda for API | ~$56 (includes RDS Proxy + NAT Gateway) |
| Fargate for API | ~$41 (no RDS Proxy, NAT Instance only) |

### RDS over Aurora Serverless

Aurora Serverless v2 has a minimum of 0.5 ACU, costing ~$43/month in compute alone before any storage or I/O. A `db.t4g.micro` RDS instance costs ~$12/month and handles pre-launch traffic comfortably. Aurora remains an option for future high-availability requirements.

### DynamoDB over ElastiCache

ElastiCache requires a continuously running cluster at $15+/month minimum. DynamoDB on-demand costs nothing at zero traffic and scales automatically. The single-table design consolidates all KV namespaces (session tokens, rate-limit counters, feature flags, AI moderation cache, cost tracking counters, federation locks) into one table.

### Lambda + Sharp over a managed image service

Lambda + Sharp provides full control over image transformations, costs ~$0 at low volume (Lambda free tier), and avoids third-party service dependencies.

### Rolling deploy over CodeDeploy blue/green

ECS rolling update with a deployment circuit breaker (`rollback: true`) handles the primary failure mode — bad image or crash loop — with zero additional infrastructure. CodeDeploy blue/green requires two target groups, an `appspec.yaml`, and additional IAM roles, adding complexity for marginal benefit at this scale.

### SSM Parameter Store for all inter-stack communication

CDK cross-stack object references compile to CloudFormation Exports, which create hard coupling between stacks. A stack that exports a value cannot be modified or deleted while another stack imports it. Instead, every stack writes its outputs to SSM (`/trellis/{stage}/`) and downstream stacks read from SSM. This means any stack can be deployed or destroyed independently.

## Compute Tier Detail

### Fargate (API)

- **Image**: ARM64 (Graviton), multi-stage Docker build
- **Sizing**: 0.25 vCPU / 0.5 GB RAM at pre-launch; scale to 0.5 vCPU / 1 GB as needed
- **Spot**: Fargate Spot pricing (~70% discount) with On-Demand fallback
- **Scaling**: `minCapacity: 1`, `maxCapacity: 4` (hard cap for cost control)
- **Health check**: `GET /health` every 30s, 3 retries before replacement
- **Connection pool**: Prisma `connection_limit=20` per task; 4 tasks × 20 = 80 max connections (within `db.t4g.micro` limit of ~87)

### Lambda (workers)

- **Runtime**: Node.js 22, ARM64
- **Concurrency**: `reservedConcurrentExecutions` set on every function (total ~55, well under the 100 account-level cap)
- **Timeouts**: 30s for queue workers, 60s for image processing, 900s (15 min) not used
- **VPC**: Only functions needing direct RDS access run in VPC; most workers use DynamoDB and S3 (accessed via gateway endpoints, no NAT needed)

## Network Topology

```
                    Internet
                        │
               ┌────────▼────────┐
               │   CloudFront    │  Shield Standard (DDoS, free)
               │   Distribution  │
               └──┬──────┬───┬───┘
                  │      │   │
         /media/* │      │   │ /*
                  │  /api/*  │
                  │      │   │
           ┌──────▼──┐   │  ┌▼─────────┐
           │  S3     │   │  │  S3      │
           │ (media) │   │  │  (web)   │
           └─────────┘   │  └──────────┘
                         │
                  ┌──────▼──────┐
                  │    ALB      │  Public subnets (2 AZs for ALB requirement)
                  └──────┬──────┘
                         │
         ┌───────────────▼───────────────┐
         │         Private subnet        │
         │  ┌────────────────────────┐   │
         │  │  ECS Fargate Task(s)  │   │
         │  │  Node.js API          │   │
         │  │  X-Ray sidecar        │   │
         │  └───────────┬───────────┘   │
         └──────────────┼───────────────┘
                        │
         ┌──────────────┼───────────────────────┐
         │              │                       │
   ┌─────▼────┐  ┌──────▼──────┐  ┌────────────▼──┐
   │   RDS    │  │  DynamoDB   │  │  SQS / SES /  │
   │ Postgres │  │ (single tbl)│  │  SSM / S3     │
   │ (private │  │  (endpoint) │  │  (endpoints)  │
   │  subnet) │  └─────────────┘  └───────────────┘
   └──────────┘

   NAT Instance (t4g.nano, ~$3/mo) — outbound internet for private subnet
   S3 Gateway Endpoint — free, bypasses NAT for S3 traffic
   DynamoDB Gateway Endpoint — free, bypasses NAT for DynamoDB traffic
```

Key network properties:
- ALB spans two public subnets (AWS requirement for ALB)
- Fargate tasks run in private subnets; outbound internet via NAT Instance (not NAT Gateway)
- S3 and DynamoDB accessed via free VPC gateway endpoints — no NAT cost for these services
- RDS in isolated subnet — no internet route in or out
- Lambda workers that need RDS run in the same private subnet as Fargate; others run outside VPC
