# AWS-Only Redesign: Overview

## Motivation

The original Trellis architecture split infrastructure across multiple platforms (Cloudflare, Supabase, Resend, Terraform). This created high cognitive load, integration friction, and made AI-assisted development harder. The architecture was consolidated to AWS-only in early 2025.

## Goals

1. **Single cloud provider** — AWS only. One billing console, one IAM system, one set of APIs.
2. **TypeScript CDK for IaC** — infrastructure defined in the same language as the application, type-safe, and AI-friendly.
3. **Minimize cost** — target ~$41/month at low traffic, scaling proportionally.
4. **Minimize ops burden** — managed services, no servers to patch (Fargate + Lambda).
5. **Strict cost guardrails** — 9 layers of cost protection (see [12-cost-estimates.md](12-cost-estimates.md)).
6. **AI-optimized SDLC** — architecture and tooling designed for AI-assisted development, testing, and deployment.
7. **Clean start** — new repo, no migration baggage, but preserve all feature requirements.

## Constraints

- **Single AZ initially** — high availability is a future concern, not a launch requirement.
- **No backward compatibility** — app is not yet live; clean slate.
- **Flutter frontend** — the Flutter app remains the primary client; only backend/infra changes.
- **ActivityPub support** — federation via Fedify must continue to work.
- **Regional expansion** — China expansion is a future requirement; architecture must not preclude it but need not implement it now.

## Design Principles

1. **Right tool for the workload** — Fargate for long-lived API, Lambda for event-driven workers.
2. **Managed over self-hosted** — RDS over self-managed PostgreSQL, SES over SMTP servers.
3. **Convention over configuration** — CDK constructs with sensible defaults, minimal config surface.
4. **Defense in depth for costs** — 9 independent layers of cost protection.
5. **Observable by default** — structured logging, X-Ray tracing, CloudWatch dashboards from day one.
6. **Least privilege everywhere** — fine-grained IAM roles per function/task, not shared roles.

## Entity-Centric Social Model

The social layer is **entity-first**: entities (defined by the loaded domain extension) are the primary social objects, not user metadata. Users have relationships with entities; entities have typed relationships with other entities; posts are *about* entities. Human-to-human relationships still exist but are secondary.

The graph layer lives in **Neo4j AuraDB** alongside Postgres. Postgres remains the source of truth for content, auth, media, and transactional data. The graph stores scored relationships, circle membership, typed entity edges, and the post-subject edges needed for dual-gated visibility queries. AuraDB is a managed Neo4j service provisioned by the consuming deployment (outside the CDK that ships with trellis); the API reaches it over Bolt with credentials pulled from Secrets Manager at startup.

See [14-graph-and-circles.md](14-graph-and-circles.md) for the full model, schema, dual-write contract, and extension hooks.

## Extension Architecture

Trellis's core is domain-agnostic. Domain-specific functionality is provided by **extensions** — pluggable modules that register entity types, metadata schemas, routes, feed strategies, recommendation strategies, lifecycle hooks, and — after the redesign — entity relationship types, discovery facets, and relationship signal providers.

| Concept | Description |
|---------|-------------|
| `TrellisExtension` | Interface that every extension implements (defined in `packages/extension-api`) |
| `ExtensionContext` | Scoped context passed to extensions — limited DB access, no secrets |
| `ExtensionDb` | Compile-time boundary exposing only safe Prisma models (no user/security tables) |
| `ExtensionGraphService` | Read-only proxy over the graph layer — extensions can traverse but not write edges |
| Extension Registry | Startup-validated list of loaded extensions (`apps/api/src/extensions.ts`) |
| Hook Dispatcher | Fires lifecycle hooks (e.g. `onEntityCreated`) with 5s timeout + circuit breaker |

Extensions live in `extensions/{name}/` as separate npm workspace packages (e.g., `@trellis/ext-{domain}`). See the [glossary](../../00-getting-started/glossary.md) for term definitions.

## Document Index

| Document | Contents |
|----------|----------|
| [01-architecture.md](01-architecture.md) | High-level architecture and service mapping |
| [02-compute.md](02-compute.md) | ECS Fargate (API) + Lambda (workers/crons) |
| [03-database.md](03-database.md) | RDS PostgreSQL, Prisma pooling, migrations, monitoring |
| [04-storage-cdn.md](04-storage-cdn.md) | S3, CloudFront OAC, media pipeline |
| [05-auth.md](05-auth.md) | Cognito with cached token trigger |
| [../identity-federation/](../identity-federation/) | **Multi-tenant identity & IdP federation** — Tenant model, per-tenant SAML/OIDC, self-service onboarding, tenant-scoped roles, agent-friendly setup + compliance discovery |
| [../user-profile/](../user-profile/) | **User profile core** — Profile management, privacy settings, account transparency, profile API, data model |
| [../data-portability/](../data-portability/) | **Data portability (GDPR Art. 15)** — Export API, JSON/ActivityPub data format, validation, versioning |
| [../media/](../media/) | **Media pipeline & metadata** — Media data model, API, metadata extraction, processing, privacy/security considerations |
| [06-async-processing.md](06-async-processing.md) | SQS (6 queues), EventBridge, cron locks |
| [07-activitypub.md](07-activitypub.md) | ActivityPub federation on AWS |
| [08-cdk-structure.md](08-cdk-structure.md) | CDK project layout and patterns |
| [09-cost-controls.md](09-cost-controls.md) | 9-layer cost protection |
| [10-cost-estimates.md](10-cost-estimates.md) | Monthly cost breakdown (~$41-56/month) |
| [11-ai-integration.md](11-ai-integration.md) | AI in the software development lifecycle |
| [12-security.md](12-security.md) | Security architecture |
| [13-observability.md](13-observability.md) | Logging, monitoring, tracing |
| [14-flutter-changes.md](14-flutter-changes.md) | Frontend migration notes |
| [15-ecs-vs-lambda.md](15-ecs-vs-lambda.md) | ECS vs Lambda analysis |
| [16-fargate-best-practices.md](16-fargate-best-practices.md) | Fargate best-practice infrastructure |
| [17-email-ses.md](17-email-ses.md) | Email: SES only, bounce/complaint handling |
| [18-dynamodb-single-table.md](18-dynamodb-single-table.md) | DynamoDB key design, access patterns, TTL |
| [19-ai-operated-sdlc.md](19-ai-operated-sdlc.md) | AI-operated SDLC: local dev, deploy, ops, incidents |
| [14-graph-and-circles.md](14-graph-and-circles.md) | Entity-centric model, Neo4j AuraDB, circles, dual-write |
