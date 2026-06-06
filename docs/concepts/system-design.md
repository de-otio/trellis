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
| Database | RDS PostgreSQL (Prisma ORM) | Source of truth for content, auth, media, and transactional data |
| Graph database | Neo4j AuraDB (Cypher over Bolt) | Social graph: scored relationships, circle tiers, typed entity edges, post-subject visibility |
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
    ├── Prisma → RDS PostgreSQL  (content, auth, media — source of truth)
    ├── GraphService → Neo4j AuraDB  (circles, relationships, discovery)
    ├── DynamoDB                 (cache, rate limits, feature flags)
    └── SQS                      (enqueue async work)
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

Writes fan out in the opposite direction: Postgres first (source of truth), then a best-effort GraphService sync. Failed graph writes enqueue to an SQS retry queue; a reconciliation worker can rebuild the graph from Postgres if needed. See [graph-and-circles.md](graph-and-circles.md#dual-write-contract).

### Media Upload

```
Client app
    │  GET /api/media/upload-url
    ▼
Fargate API
    │  generates presigned S3 PUT URL (short TTL)
    ▼
Client app
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
Client app
    │  HTTPS /media/*
    ▼
CloudFront
    │  /media/* → S3 origin (via OAC — bucket is not public)
    ▼
S3 (immutable cache headers, long-lived edge cache)
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
