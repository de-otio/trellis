---
title: Database
description: How Trellis uses RDS PostgreSQL as its transactional source of truth alongside a graph database for social-graph queries.
sidebar: Database
order: 12
---

# Database: RDS PostgreSQL + Graph Database

Trellis runs a hybrid data layer. **PostgreSQL** is the source of truth for content, auth, media, and transactional data. The **graph database** (Neo4j AuraDB) holds the social graph: scored relationships, circle tiers, typed entity edges, and post-subject visibility. See [graph-and-circles.md](graph-and-circles.md) for the graph side, including the dual-write contract that keeps Postgres and the graph in sync.

## RDS PostgreSQL

PostgreSQL (version 16) with Prisma ORM. Key configuration choices:

- Private subnet placement — no public internet route
- Automated backups with point-in-time recovery
- AES-256 encryption at rest
- Performance Insights and Enhanced Monitoring enabled
- Slow-query logging (queries exceeding a configured threshold are logged to CloudWatch)
- Lock timeout and statement timeout configured to prevent runaway queries

**Connection pooling**: The Fargate API is a long-lived process with Prisma's built-in connection pool. RDS Proxy is not required. Lambda workers that need direct RDS access open short-lived connections; most workers use DynamoDB or SQS instead.

```typescript
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

prisma.$on('query' as any, (e: any) => {
  if (e.duration > 1000) {
    logger.warn('Slow query', { duration: e.duration, query: e.query });
  }
});
```

**HA upgrade path**: When high availability is needed, migrate to Aurora PostgreSQL with a read replica. The Prisma connection string is the only change.

## Schema

The Prisma schema (`prisma/schema.prisma`) connects directly to RDS. The `User` model uses `cognitoSub` for auth identity.

### Entity-Centric Data Model

The social graph moved to the graph database; the Prisma schema covers the transactional half.

**Removed from Postgres:** `Follow`, `Friendship`, `PostVisibilityLevel` (these are now served by the graph layer).

**Added:**

- `EntityOwnership` — `userId`/`entityId`/`role` (`PRIMARY_OWNER` | `CO_OWNER` | `CARETAKER`) / `status` (`ACTIVE` | `SUSPENDED` | `FORMER`). Dual-written to the graph as `:User-[:OWNS]->:Entity`.
- `EntityRelationship` — typed entity-to-entity edges with `status` (`PENDING` | `CONFIRMED` | `DECLINED`) and initiator/confirmer bookkeeping. Dual-written to the graph once `CONFIRMED`.
- `CircleConfig` — per-user tier thresholds.
- `CircleReadState` — per-`(userId, entityId, tier)` mark-read state feeding the "caught up" signal.
- `ConnectionCode` + `ConnectionCodeRedemption` — redeemable invite codes replacing ad-hoc follow intents.
- Enums: `PostRadius` (`WHISPER` | `NORMAL` | `LOUD` | `SHOUT`), `EntityStatus` (`ACTIVE` | `MEMORIAL` | `INACTIVE`), `OwnershipRole`, `OwnershipStatus`.

**Modified:**

- `Entity` — drops `ownerId` (ownership is now a relation), adds `status`, `inactiveAt`, `memorialSettings`.
- `User` — drops follow counts, gains `circleConfig` and `circleReadStates` relations.
- `Post` — adds `radius: PostRadius` and `primaryEntityId`.
- `PostEntity` → `PostSubject` with an `isPrimary` flag. Dual-written to the graph as `:Post-[:ABOUT {isPrimary}]->:Entity`.

**Retained unchanged:**
Post, PostComment, PostSentiment, CommentSentiment, Entity, Group, GroupMember, MediaFile, UploadSession, PostMedia, PostCommentMedia, DirectMessage, CustomAudience, CustomAudienceMember, TaxonomyDimension, TaxonomyCategory, TaxonomyTaxon, FeatureToggle, SecurityEvent, Activity, PostGeoIndex, DomainReputation, LinkCheck, Invitation, CrossRegionConsent, IngestState, MfaEnrollment, UserEncryptionKey, Partner, RoleMetadata.

**Surveillance-hardening additions:**

- `InteractionEvent` — append-only behavioral event log (actor, target, type, `expiresAt`); retention-bounded; no content column.
- `Report` — replaces `LinkReport`; `reportType` discriminator (`LINK` | `ACCOUNT`); LINK reports carry an indexed `domain`.
- `FeatureToggle` — gains a nullable `tenantId`; uniqueness is now `[key, tenantId]` plus a partial global-unique index. Resolution is tenant → global → default.
- `SecurityEvent.retentionUntil` — tightened to NOT NULL (enforces hourly-cron pruning on every row).
- `User` — gains `signupMethod` + `invitationId`; `UserRole` gains `MODERATOR`.

## Migrations

### Development

```bash
npx prisma migrate dev --name add-feature
```

### Production

Run migrations as a **separate one-off Fargate task** — not in the API container's entrypoint, and not from a developer machine. This prevents migration failures from crash-looping the service:

```bash
aws ecs run-task \
  --cluster $CLUSTER \
  --task-definition $MIGRATION_TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["npx","prisma","migrate","deploy"]}]}'

aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK_ARN
```

### Zero-Downtime Migration Strategy (Expand-Contract)

For schema changes that could break running code:

1. **Expand**: Add new column/table (nullable or with default). Deploy migration.
2. **Deploy**: Update application code to write to both old and new columns.
3. **Backfill**: Migrate existing data to new column.
4. **Contract**: Remove old column in a subsequent migration once all code uses the new one.

This ensures tasks running on the old code continue to work while the migration runs.

### Pre-Migration Snapshots

Always take a manual database snapshot before production migrations and verify it completes before proceeding.

## Key Indexes

- `User.cognitoSub` (unique) — auth lookups
- `User.handle` (unique) — ActivityPub lookups
- `Post.authorId` + `Post.createdAt` — author-path feed queries
- `PostGeoIndex.geohash` — geo queries
- `PostSubject.(postId, entityId)` — post→entity fan-out, primary-subject filtering
- `EntityOwnership.(userId, entityId)` — ownership lookups
- `MediaFile.sha256Hash` — content-addressed dedup

Relationship-graph lookups (who does user X see in tier N?) are served by the graph database, not Postgres — see [graph-and-circles.md](graph-and-circles.md).

## Backup Strategy

| Layer | Method | Retention |
|-------|--------|-----------|
| Automated snapshots | RDS automated backups | Configurable window |
| Manual snapshots | Pre-migration snapshots | Until confirmed safe |
| Point-in-time recovery | RDS PITR | Matches backup window |
| Schema versioning | Prisma migration files in git | Forever |
