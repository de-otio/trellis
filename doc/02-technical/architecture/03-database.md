# Database: RDS PostgreSQL + Neo4j AuraDB

Trellis runs a hybrid data layer. **Postgres** (this document) is the source of truth for content, auth, media, and transactional data. **Neo4j AuraDB** holds the social graph: scored relationships, circle tiers, typed entity edges, and post-subject visibility. AuraDB is a managed Neo4j service provisioned by the consuming deployment (through the Neo4j Aura console), outside the CDK that ships with trellis; the API connects over Bolt with credentials pulled from Secrets Manager at task startup. See [14-graph-and-circles.md](14-graph-and-circles.md) for the graph side, including the dual-write contract that keeps Postgres and the graph in sync.

## RDS PostgreSQL

## Instance Configuration

```
Engine:             PostgreSQL 16
Instance class:     db.t4g.micro (2 vCPU, 1 GB RAM — free tier eligible)
Storage:            20 GB gp3 (expandable, capped at 50 GB)
Multi-AZ:           No (single AZ initially)
Backup retention:   7 days (automated)
Encryption:         AES-256 (AWS managed key)
Public access:      No (isolated subnet, VPC only)
Performance Insights: Enabled (free for 7-day retention)
Enhanced Monitoring: Enabled (60-second interval)
```

### CDK

```typescript
const rdsInstance = new rds.DatabaseInstance(this, 'Db', {
  engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [rdsSg],
  credentials: rds.Credentials.fromSecret(dbCredentials),
  storageType: rds.StorageType.GP3,
  allocatedStorage: 20,
  maxAllocatedStorage: 50,
  multiAz: false,
  deletionProtection: stage === 'prod',
  backupRetention: Duration.days(7),
  monitoringInterval: Duration.seconds(60),
  enablePerformanceInsights: true,
  performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
  storageEncrypted: true,
  removalPolicy: stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  parameterGroup: new rds.ParameterGroup(this, 'DbParams', {
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
    parameters: {
      'log_min_duration_statement': '1000',   // Log queries > 1 second
      'log_connections': '1',
      'log_disconnections': '1',
      'lock_timeout': '10000',                // 10s lock timeout
      'statement_timeout': '30000',           // 30s query timeout
      'idle_in_transaction_session_timeout': '60000', // Kill idle-in-tx after 60s
    },
  }),
});
```

**Upgrade path**: When HA is needed, migrate to Aurora PostgreSQL (provisioned with a read replica). The Prisma connection string is the only change.

## Connection Pooling

**No RDS Proxy needed.** The Fargate API is a long-lived process with Prisma's built-in connection pool. This saves ~$22/month.

```typescript
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
});

// Log slow queries
prisma.$on('query' as any, (e: any) => {
  if (e.duration > 1000) {
    logger.warn('Slow query', { duration: e.duration, query: e.query });
  }
});
```

### Connection Limits

| Scenario | Tasks | Pool Size/Task | Total Connections | t4g.micro Limit |
|----------|-------|----------------|-------------------|-----------------|
| Pre-launch | 1 | 5 | 5 | ~80 |
| Growing | 2 | 5 | 10 | ~80 |
| Max auto-scale | 4 | 5 | 20 | ~80 |
| Lambda workers | ~5 concurrent | 1 each | 5 | ~80 |
| **Peak total** | — | — | **25** | **~80** |

Plenty of headroom. Lambda workers that need RDS (delete-account, media-reconciliation, crons) each open a single short-lived connection.

## Schema

The Prisma schema (`prisma/schema.prisma`) uses the standard PostgreSQL adapter connecting directly to RDS. The `User` model uses `cognitoSub` for auth identity.

### Entity-Centric Redesign — Schema Changes

The social graph has moved to Neo4j AuraDB; the Prisma schema kept the transactional half and dropped the reciprocal-follow tables.

**Removed:** `Follow`, `Friendship`, `PostVisibilityLevel`.

**Added:**
- `EntityOwnership` — `userId`/`entityId`/`role` (`PRIMARY_OWNER` | `CO_OWNER` | `CARETAKER`) / `status` (`ACTIVE` | `SUSPENDED` | `FORMER`). Dual-written to the graph as `:User-[:OWNS]->:Entity`.
- `EntityRelationship` — typed entity-to-entity edges with `status` (`PENDING` | `CONFIRMED` | `DECLINED`) and initiator/confirmer bookkeeping. Dual-written to the graph once `CONFIRMED`.
- `CircleConfig` — per-user tier thresholds (defaults t0≤10, t1≤30, t2≤100, t3 unbounded).
- `CircleReadState` — per-`(userId, entityId, tier)` mark-read state feeding the "caught up" signal.
- `ConnectionCode` + `ConnectionCodeRedemption` — redeemable invite codes replacing ad-hoc follow intents.
- Enums: `PostRadius` (`WHISPER` | `NORMAL` | `LOUD` | `SHOUT`), `EntityStatus` (`ACTIVE` | `MEMORIAL` | `INACTIVE`), `OwnershipRole`, `OwnershipStatus`.

**Modified:**
- `Entity` — drops `ownerId` (ownership is now a relation), adds `status`, `inactiveAt`, `memorialSettings`.
- `User` — drops follow counts, gains `circleConfig` and `circleReadStates` relations.
- `Post` — adds `radius: PostRadius` and `primaryEntityId`.
- `PostEntity` → `PostSubject` with an `isPrimary` flag. Dual-written to the graph as `:Post-[:ABOUT {isPrimary}]->:Entity`.

### Retained As-Is

All transactional models carry over unchanged:
- Post, PostComment, PostSentiment, CommentSentiment
- Entity, Group, GroupMember
- MediaFile, UploadSession, PostMedia, PostCommentMedia
- DirectMessage, CustomAudience, CustomAudienceMember
- TaxonomyDimension, TaxonomyCategory, TaxonomyTaxon
- FeatureToggle, SecurityEvent, Activity
- PostGeoIndex, DomainReputation, LinkCheck, LinkReport
- Invitation, CrossRegionConsent, IngestState
- MfaEnrollment, UserEncryptionKey, Partner, RoleMetadata

## Migrations

### Development

```bash
npx prisma migrate dev --name add-feature
```

### Production

Run migrations as a **separate one-off Fargate task** — not in the API container's entrypoint, and not from a developer machine. This prevents migration failures from crash-looping the service.

```bash
# CI/CD step — run migration as one-off task
aws ecs run-task \
  --cluster $CLUSTER \
  --task-definition $MIGRATION_TASK_DEF \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides '{"containerOverrides":[{"name":"migrate","command":["npx","prisma","migrate","deploy"]}]}'

# Wait for it to complete
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK_ARN
```

### Zero-Downtime Migration Strategy (Expand-Contract)

For schema changes that could break running code, use the expand-contract pattern:

1. **Expand**: Add new column/table (nullable or with default). Deploy migration.
2. **Deploy**: Update application code to write to both old and new columns.
3. **Backfill**: Migrate existing data to new column.
4. **Contract**: Remove old column in a subsequent migration once all code uses the new one.

This ensures the running Fargate tasks (on the old code) continue to work while the migration runs.

### Pre-Migration Snapshots

Always take a manual RDS snapshot before production migrations:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier prod-trellis \
  --db-snapshot-identifier pre-migration-$(date +%Y%m%d-%H%M)
```

## Monitoring & Alarms

### RDS Alarms

```typescript
// CDK
// CPU
new Alarm(this, 'DbCpuAlarm', {
  metric: rdsInstance.metricCPUUtilization(),
  threshold: 80,
  evaluationPeriods: 3,
  alarmActions: [alertTopic],
});

// Storage — critical: prevent disk full
new Alarm(this, 'DbStorageAlarm', {
  metric: rdsInstance.metricFreeStorageSpace(),
  threshold: 4 * 1024 * 1024 * 1024,  // 4 GB remaining
  comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
  evaluationPeriods: 1,
  alarmActions: [alertTopic],
});

// Connections
new Alarm(this, 'DbConnectionsAlarm', {
  metric: rdsInstance.metricDatabaseConnections(),
  threshold: 60,  // 75% of ~80 limit
  evaluationPeriods: 3,
  alarmActions: [alertTopic],
});

// Free memory
new Alarm(this, 'DbMemoryAlarm', {
  metric: rdsInstance.metricFreeableMemory(),
  threshold: 100 * 1024 * 1024,  // 100 MB
  comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
  evaluationPeriods: 3,
  alarmActions: [alertTopic],
});
```

### Slow Query Logging

The RDS parameter group logs queries taking > 1 second. These appear in CloudWatch Logs under `/aws/rds/instance/{id}/postgresql`. Set retention:

```typescript
new logs.LogGroup(this, 'RdsLogs', {
  logGroupName: `/aws/rds/instance/${rdsInstance.instanceIdentifier}/postgresql`,
  retention: logs.RetentionDays.TWO_WEEKS,
});
```

## Indexes

Carry over all existing indexes. Key ones:

- `User.cognitoSub` (unique) — auth lookups
- `User.handle` (unique) — ActivityPub lookups
- `Post.authorId` + `Post.createdAt` — author-path feed queries
- `PostGeoIndex.geohash` — geo queries
- `PostSubject.(postId, entityId)` — post→entity fan-out, primary-subject filtering
- `EntityOwnership.(userId, entityId)` — ownership lookups
- `MediaFile.sha256Hash` — content-addressed dedup

Relationship-graph lookups (who does user X see in tier N?) are served by Neo4j AuraDB, not Postgres — see [14-graph-and-circles.md](14-graph-and-circles.md).

## Backup Strategy

| Layer | Method | Retention |
|-------|--------|-----------|
| Automated snapshots | RDS automated backups | 7 days |
| Manual snapshots | Pre-migration snapshots | Until confirmed safe |
| Point-in-time recovery | RDS PITR | 7-day window |
| Schema versioning | Prisma migration files in git | Forever |
| `maxAllocatedStorage: 50` | Auto-expand with cap | Prevents disk-full and unbounded cost |
