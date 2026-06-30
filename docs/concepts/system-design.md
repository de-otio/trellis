---
title: System Design
description: A high-level map of the components that make up a Trellis deployment and how they connect.
sidebar: System Design
order: 10
---

# System Design

## Architecture at a Glance

| Component | Technology | Role |
|-----------|-----------|------|
| API compute | ECS Fargate (ARM64) | Long-lived Node.js process, native DB pooling |
| Load balancer | Application Load Balancer | HTTPS termination, health-checked routing |
| CDN | CloudFront + Origin Access Control | Routes `/api/*`, `/media/*`, and static assets to different origins |
| Database | RDS PostgreSQL (Prisma ORM) | Single source of truth for content, auth, media, transactional data — and the social graph |
| Social graph | PostgreSQL (`PostgresGraphService`, SQL joins + recursive CTEs) | Scored relationships, circle tiers, typed entity edges, post-subject visibility — relational tables in the same database, not a separate graph store |
| KV / cache / rate-limiting | DynamoDB (single table, on-demand) | 15+ namespaces, TTL-based expiry |
| Auth | Amazon Cognito (user pools) | Pre-token Lambda trigger caches claims in DynamoDB |
| Object storage | S3 (media + web app) | Direct client uploads via presigned URLs |
| Background workers | Lambda (ARM64) | SQS consumers, cron jobs, image processing |
| Message queues | SQS | Activity, deletion, media, link-check, federation-inbox, federation-outbox queues with DLQs |
| Scheduled jobs | EventBridge Scheduler + Lambda | DynamoDB locks prevent double-execution |
| Email | AWS SES | Transactional email delivery |
| Image processing | Lambda + Sharp | On-demand resize/transcode from S3 originals |
| Federation | Fedify library (in ECS container) | ActivityPub inbox/outbox, HTTP signatures |
| Observability | CloudWatch Logs + Metrics + X-Ray | Dashboards, alarms, distributed traces |

## Request Flow

### API Request

```
Client app
    │  HTTPS
    ▼
CloudFront Distribution
    │  /api/* → forward to ALB origin
    ▼
Application Load Balancer (HTTPS)
    │  target group: Fargate tasks
    ▼
ECS Fargate — API Container (Node.js)
    │
    ├── Prisma → RDS PostgreSQL  (content, auth, media, social graph — source of truth)
    ├── GraphService → RDS PostgreSQL  (circles, relationships, discovery — SQL joins/CTEs)
    ├── DynamoDB                 (cache, rate limits, feature flags)
    └── SQS                      (enqueue async work)
```

`GraphService` is not a separate datastore — `PostgresGraphService` runs SQL against the same RDS PostgreSQL, using the same Prisma client.

### Circle View (Dual-Gated Visibility)

A circle read is a SQL join across the relationship, post-subject, and post tables in Postgres:

```
Client: GET /api/circles/0  (inner circle)
    │
    ▼
Fargate API — circle-handler
    │
    └── GraphService (PostgresGraphService) → RDS PostgreSQL
          one query joins relationships ⋈ post_subjects ⋈ posts
          filtered by tier & post radius,
          then loads post content, author, media
    │
    ▼
return JSON
```

Writes go straight to the relevant Postgres edge tables (`relationships`, `entity_relationships`, `entity_ownerships`, `post_subjects`) through `PostgresGraphService`, in the same transactional database as the domain rows — there is no second store to mirror or reconcile. See [graph-and-circles.md](graph-and-circles.md#one-database-the-graph-lives-in-postgres).

### Media Upload

Uploads go **through the API** (multipart POST), not via presigned
direct-to-S3 URLs. Images are re-encoded synchronously and written to the
`cas/` prefix; video/audio land in `pending/` and are processed asynchronously.

```
Client app
    │  POST /api/media/upload (multipart)
    ▼
Fargate API
    │  validate + route by content type
    ├─ image:  re-encode (strip EXIF/GPS) → write cas/{tenant}/{hash}
    └─ video/audio: write pending/{tenant}/{upload}; row = PENDING
                        │  S3 event notification (pending/)
                        ▼
                  SQS media-processing queue
                        │
                        ▼
       Lambda media-processing-worker — transcode-and-discard,
            hash cleaned bytes, start VISUAL + AUDIO moderation tracks
                        │
                        ▼
       media-completion-worker — fan in both tracks;
            on approval, promote cleaned bytes → cas/{tenant}/{hash}
```

See [Media Moderation](media-moderation.md) for the moderation lifecycle and
the fail-closed serve gate.

### Media Delivery

```
Client app
    │  HTTPS GET /api/media/{hash}
    ▼
CloudFront → Fargate API
    │  fail-closed serve gate: serve only APPROVED, non-hidden objects
    ▼
S3 cas/ object (private; read server-side via OAC)
```

### Background Work (SQS → Lambda)

```
Fargate API
    │  enqueue message
    ▼
SQS queue
    │  trigger
    ▼
Lambda worker
    │  success → message deleted
    │  failure × 3 → DLQ
    ▼
DLQ alarm → SNS → alert
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

The HTTP API runs in ECS Fargate. Background workers (SQS consumers, crons, image processing, Cognito triggers) run in Lambda.

A long-lived Fargate process manages its own Prisma connection pool, eliminating the need for RDS Proxy and keeping the API tier simple with no cold starts and consistent latency.

Lambda remains the right choice for workers because those workloads are sporadic — they run only when triggered, scale to zero between invocations, and don't benefit from a persistent connection pool.

### DynamoDB over a dedicated cache cluster

DynamoDB on-demand costs nothing at zero traffic and scales automatically. The [single-table design](dynamodb-single-table.md) consolidates all KV namespaces (session tokens, rate-limit counters, feature flags, moderation cache, cost tracking counters, federation locks) into one table.

### Lambda + Sharp for image processing

Lambda + Sharp provides full control over image transformations at low volume and avoids third-party service dependencies.

### SSM Parameter Store for inter-stack communication

CDK cross-stack object references create hard coupling between stacks. Instead, every stack writes its outputs to SSM and downstream stacks read from SSM. This means any stack can be deployed or destroyed independently.

## Network Topology

```
                Internet
                    │
           ┌────────▼────────┐
           │   CloudFront    │  DDoS protection
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
              │    ALB      │  Public subnets
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
┌────▼─────┐  ┌─────▼───────┐  ┌───────────▼───┐
│   RDS    │  │  DynamoDB   │  │  SQS / SES /  │
│ Postgres │  │ (single tbl)│  │  SSM / S3     │
│ (private │  │  (endpoint) │  │  (endpoints)  │
│  subnet) │  └─────────────┘  └───────────────┘
└──────────┘
```

Key network properties:
- ALB spans two public subnets (AWS requirement)
- Fargate tasks run in private subnets; outbound internet via a NAT device
- S3 and DynamoDB accessed via free VPC gateway endpoints — no NAT cost for these services
- RDS in an isolated subnet — no internet route in or out
- Lambda workers that need RDS run in the same private subnet as Fargate; others run outside VPC
