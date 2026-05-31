# Getting Started

## Quick Links

| Role | Start here |
|------|-----------|
| Developer | [Local Setup](../02-technical/development/local-setup.md) |
| Operations | [Deployment Guide](../02-technical/operations/deployment.md) |
| Architecture | [System Overview](../02-technical/architecture/00-overview.md) |

## What is Trellis?

Trellis is a **generic, multi-tenant social-network core** built on ActivityPub (federated social protocol), with domain-specific functionality provided by **pluggable extensions**. It's designed to be community-owned, low-cost, and easy to operate. ActivityPub federation is **disabled by default** and enabled per environment.

The core platform provides users, posts, feeds, follows, groups, moderation, and federation. Extensions add domain-specific entity types, metadata schemas, taxonomy, feed personalization, and recommendations — without modifying the core.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API | Node.js 22 on ECS Fargate (ARM64 Graviton) |
| Database | PostgreSQL 16 on RDS + DynamoDB single-table |
| Auth | AWS Cognito with Lambda triggers |
| Frontend | Flutter (iOS, Android, web) |
| Storage | S3 + CloudFront CDN |
| Queues | SQS + Lambda workers |
| Crons | EventBridge Scheduler + Lambda |
| Federation | ActivityPub via Fedify |
| IaC | AWS CDK (TypeScript) |
| Cost | ~$41–56/month |

## Repository Structure

```
apps/api/           Node.js HTTP API — business logic, routes, handlers
                    (published as @de-otio/trellis; runs in ECS Fargate
                    in the consuming deployment)
packages/
  extension-api/    Shared extension interface types
                    (published as @de-otio/trellis-extension-api)
prisma/             Database schema + migrations
scripts/            Local dev helpers
doc/                Documentation (you are here)
```

Verticals build on Trellis as separate repos: they register a domain
extension (e.g. `@trellis/ext-{domain}`) against `@de-otio/trellis` and
own their own frontend and CDK infra. Trellis is not deployed standalone
— the consuming deployment provisions and owns the live AWS environment.
