---
title: Database
description: How Trellis uses RDS PostgreSQL as its single transactional source of truth, including the social graph.
sidebar: Database
order: 12
---

# Database: RDS PostgreSQL

**PostgreSQL** is Trellis's single source of truth — for content, auth, media, and the social graph alike. There is no separate graph database: scored relationships, circle tiers, typed entity edges, and post-subject visibility are all relational tables served over SQL (joins + recursive CTEs) by `PostgresGraphService`. See [graph-and-circles.md](graph-and-circles.md) for how the graph layer maps onto these tables.

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

The classic follow/friend model was replaced by an entity-centric graph — but that graph lives in Postgres too. The relationship and entity-relationship edges are dedicated tables (`relationships`, `entity_relationships`), alongside the ownership and post-subject edges that already lived in Postgres.

**Removed from Postgres:** `Follow`, `Friendship`, `PostVisibilityLevel` — replaced by the `relationships` edge table and the `PostRadius` enum.

**Added:**

- `EntityOwnership` (`entity_ownerships`) — `userId`/`entityId`/`role` (`PRIMARY_OWNER` | `CO_OWNER` | `CARETAKER`) / `status` (`ACTIVE` | `REMOVED` | `LEFT`). The owns edge.
- `Relationship` (`relationships`) — the scored user→target edge (`targetType` is `"user"` | `"entity"`): `computedScore`, `manualScore`, `tier`, `connectionMethod`, `interactionCount`, `lastInteractionAt`, `reciprocated`, JSON `signals`.
- `EntityRelationship` (`entity_relationships`) — typed entity-to-entity edges with `type` and `status` (`PENDING` | `CONFIRMED` | `REJECTED`) plus initiator bookkeeping. The edge becomes visible to traversals once `CONFIRMED`.
- `CircleConfig` — per-user tier thresholds.
- `CircleReadState` — per-`(userId, entityId, tier)` mark-read state feeding the "caught up" signal.
- `ConnectionCode` + `ConnectionCodeRedemption` — redeemable invite codes replacing ad-hoc follow intents.
- Enums: `PostRadius` (`WHISPER` | `NORMAL` | `LOUD` | `SHOUT`), `EntityStatus` (`ACTIVE` | `MEMORIAL` | `TRANSFERRED`), `OwnershipRole`, `OwnershipStatus` (`ACTIVE` | `REMOVED` | `LEFT`), `EntityRelationshipType`, `EntityRelationshipStatus`.

**Modified:**

- `Entity` — drops `ownerId` (ownership is now the `entity_ownerships` edge), adds `status` and related lifecycle fields.
- `User` — drops follow counts, gains `circleConfig` and `circleReadStates` relations.
- `Post` — adds `radius: PostRadius` and `primaryEntityId`.
- `PostEntity` → `PostSubject` (`post_subjects`) with an `isPrimary` flag. The about edge.

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
- `Relationship.(userId)`, `(targetType, targetId)`, `(userId, tier)` — forward/reverse graph traversal and circle-tier membership
- `EntityRelationship.(entityId, type, status)`, `(relatedEntityId, type, status)` — entity-relationship traversal and pending-by-owner

Relationship-graph lookups (who does user X see in tier N?) are SQL joins over these edge tables in the same database — see [graph-and-circles.md](graph-and-circles.md).

## Backup Strategy

| Layer | Method | Retention |
|-------|--------|-----------|
| Automated snapshots | RDS automated backups | Configurable window |
| Manual snapshots | Pre-migration snapshots | Until confirmed safe |
| Point-in-time recovery | RDS PITR | Matches backup window |
| Schema versioning | Prisma migration files in git | Forever |
