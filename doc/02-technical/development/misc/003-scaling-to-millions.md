# Plan 003: Scaling Trellis to Millions of Users

**Status:** Reference plan
**Last updated:** 2026-03-22

This plan defines the infrastructure scaling milestones from the current architecture (~hundreds of users) to millions of DAU. Each phase is triggered by observable metrics, not guesswork. The goal is to make each transition smooth, low-risk, and just-in-time.

## Current Baseline

| Component | Dev | Prod |
|---|---|---|
| ECS tasks | 1 (max 2) | 2 (max 4) |
| Task size | 0.25 vCPU / 512 MiB | 0.5 vCPU / 1 GiB |
| RDS instance | db.t4g.micro (1 GiB) | db.t4g.small (2 GiB) |
| RDS max_connections | ~112 | ~225 |
| Connection pool | Per-request, max 1 (broken) | Per-request, max 1 (broken) |
| DynamoDB | On-demand (pay-per-request) | On-demand (pay-per-request) |
| Cache | DynamoDB KV (5 min TTL feeds) | DynamoDB KV (5 min TTL feeds) |
| CDN | CloudFront (API uncached) | CloudFront (media cached 365d) |
| NAT | t4g.nano instance | Managed NAT Gateway |
| ALB | Internal + CF VPC Origin | Internet-facing |
| Queues | 5 SQS + Lambda workers | 5 SQS + Lambda workers |

## Cost Context

Current monthly spend estimate:
- Dev: ~$40-60/month
- Prod: ~$100-150/month

Each scaling phase includes cost impact so you can budget ahead.

---

## Phase 0: Fix the Foundation (Now)

**Trigger:** Immediate — the system cannot handle 2 concurrent requests reliably.
**Capacity after:** ~2,000-6,000 req/s, ~50K-600K DAU
**Cost impact:** $0 (code change only)
**Effort:** 2-3 days
**Plan:** [002-database-connections-and-cloudflare-cleanup.md](002-database-connections-and-cloudflare-cleanup.md)

### What

- Singleton `pg.Pool` per process (max 10 dev, 15 prod)
- 30s idle timeout (not 500ms)
- Graceful shutdown on SIGTERM
- Remove Cloudflare architecture remnants

### Why this unlocks everything

Every subsequent phase assumes a working connection pool. Without it, scaling tasks or adding RDS Proxy won't help — each request still opens a fresh connection.

---

## Phase 1: Vertical Scaling (1K-10K DAU)

**Trigger:** Any of:
- RDS CPU sustained >70% (burst credits depleting)
- ECS task CPU sustained >70%
- p99 response time >500ms
- `pool.waitingCount > 0` in metrics

**Capacity after:** ~10K-50K DAU
**Cost impact:** +$20-50/month
**Effort:** 1-2 hours (config changes only)

### 1a. Upsize ECS tasks

```
Dev:  0.25 vCPU / 512 MiB  →  0.5 vCPU / 1 GiB
Prod: 0.5 vCPU / 1 GiB     →  1 vCPU / 2 GiB
```

**File:** `infra/lib/config/dev.ts`, `infra/lib/config/prod.ts`

Change `fargate.cpu` and `fargate.memoryLimitMiB`. Redeploy. Zero downtime (rolling deploy).

### 1b. Upsize RDS (if DB is the bottleneck)

```
Dev:  db.t4g.micro  →  db.t4g.small  (112 → 225 connections, 1 → 2 GiB)
Prod: db.t4g.small  →  db.t4g.medium (225 → 450 connections, 2 → 4 GiB)
```

**File:** `infra/lib/stacks/data-stack.ts` — change `instanceType`.

RDS applies this with a brief failover (~30s downtime for single-AZ, near-zero for multi-AZ prod). Schedule during low traffic.

### 1c. Increase pool size proportionally

After upsizing RDS, recalculate: `floor((max_connections - 13) / (max_tasks * 2))`.

For db.t4g.medium with 4 prod tasks: `floor(437 / 8) = 54` → use 20-25 comfortably.

---

## Phase 2: Horizontal Scaling (10K-100K DAU)

**Trigger:** Any of:
- Single ECS task at CPU ceiling even after vertical scaling
- Need for higher availability (>2 tasks for fault tolerance)
- Traffic spikes that auto-scaling can't absorb fast enough

**Capacity after:** ~100K-500K DAU
**Cost impact:** +$50-150/month (more tasks + larger RDS)
**Effort:** 1-2 days

### 2a. Increase ECS max task count

```
Dev:  max 2  →  max 4
Prod: max 4  →  max 8-12
```

**File:** `infra/lib/config/prod.ts` — `fargate.maxTaskCount`.

### 2b. Add request-count-based auto-scaling

Current scaling uses CPU (70%) and memory (80%). Add ALB request count target:

```typescript
// infra/lib/stacks/api-stack.ts
scaling.scaleOnRequestCount('RequestScaling', {
  targetGroup,
  requestsPerTarget: 1000,  // per task per minute
  scaleInCooldown: Duration.seconds(120),
  scaleOutCooldown: Duration.seconds(30),
});
```

This reacts faster than CPU-based scaling for traffic spikes.

### 2c. Recalculate pool sizing for more tasks

With 12 prod tasks on db.t4g.medium:
```
max_concurrent = 12 * 2 = 24 (rolling deploy)
pool_per_task = floor(437 / 24) = 18
recommended = 15
```

At this point, connection pool headroom starts to tighten. This is the trigger for Phase 3.

---

## Phase 3: Introduce Redis Cache (50K-500K DAU)

**Trigger:** Any of:
- DynamoDB costs exceeding $20/month for KV/cache operations
- Feed/list queries dominating RDS CPU (>50% of query load is repeated reads)
- p99 for feed endpoints >200ms
- Need for pub/sub (real-time notifications, WebSocket fan-out)

**Capacity after:** Reduces DB load by 60-80% for read-heavy workloads
**Cost impact:** +$15-50/month (ElastiCache Serverless or t4g.micro node)
**Effort:** 3-5 days

### Why Redis and not just more DynamoDB

DynamoDB is excellent for the current KV pattern (rate limits, CSRF, sessions), but Redis is better for:

| Use case | DynamoDB | Redis |
|---|---|---|
| Simple KV with TTL | Good | Good |
| Feed caching (large JSON) | Expensive at scale (WCU cost) | Cheap (memory-based) |
| Sorted sets (leaderboards, timelines) | Requires GSI + scan | Native `ZRANGEBYSCORE` |
| Pub/sub (real-time events) | Not supported | Native |
| Cache invalidation patterns | Manual TTL only | TTL + keyspace notifications + patterns |
| Sub-millisecond reads | ~5-10ms | ~0.5-1ms |
| Cost at high read volume | Per-RCU billing adds up | Flat monthly for node size |

### 3a. Deploy ElastiCache (Redis OSS mode)

**Option A — ElastiCache Serverless (simplest):**
```typescript
// infra/lib/stacks/data-stack.ts
const redis = new elasticache.CfnServerlessCache(this, 'Redis', {
  engine: 'redis',
  serverlessCacheName: `trellis-${stage}-cache`,
  securityGroupIds: [redisSg.securityGroupId],
  subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
  majorEngineVersion: '7',
  dailySnapshotTime: '03:00',
  snapshotRetentionLimit: stage === 'prod' ? 7 : 1,
});
```

Cost: ~$15-25/month minimum (scales with usage). No node management.

**Option B — ElastiCache node (cheaper at steady state):**
```typescript
const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
  replicationGroupDescription: `trellis-${stage}-cache`,
  engine: 'redis',
  cacheNodeType: 'cache.t4g.micro',  // 0.5 GiB, ~$9/month
  numCacheClusters: stage === 'prod' ? 2 : 1,  // Multi-AZ for prod
  automaticFailoverEnabled: stage === 'prod',
});
```

Cost: ~$9/month (dev), ~$18/month (prod with replica). Fixed capacity.

**Recommendation:** Start with a t4g.micro node. Serverless minimum is higher and you won't need auto-scaling at this stage.

### 3b. Create a Redis cache adapter

```typescript
// apps/api/src/lib/cache/redis-cache.ts
import { createClient } from 'redis';

let client: ReturnType<typeof createClient> | null = null;

export async function getRedisClient() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => logger.error('Redis error', err));
    await client.connect();
  }
  return client;
}

export async function cachedQuery<T>(
  key: string,
  ttlSeconds: number,
  queryFn: () => Promise<T>,
): Promise<T> {
  const redis = await getRedisClient();
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const result = await queryFn();
  await redis.set(key, JSON.stringify(result), { EX: ttlSeconds });
  return result;
}
```

### 3c. Migrate high-traffic cache keys from DynamoDB to Redis

Priority order (by read volume):
1. **Feed cache** — largest JSON payloads, most frequent reads
2. **Friend lists** — read on every feed query for privacy filtering
3. **Feature toggles** — read on every request, rarely changes
4. **Rate limits** — high volume, Redis `INCR` + `EXPIRE` is atomic and faster
5. **Sessions** — keep in DynamoDB (Redis eviction would log users out)

### 3d. Graceful shutdown for Redis

```typescript
process.on('SIGTERM', async () => {
  await DatabaseConnectionManager.closePool();
  await redisClient?.quit();
  process.exit(0);
});
```

### Keep DynamoDB for

- Session storage (must survive cache eviction)
- CSRF tokens (short-lived, low volume)
- User deletion state machines
- Anything that must not be lost on Redis restart

---

## Phase 4: Introduce RDS Proxy (100K+ DAU, 8+ ECS Tasks)

**Trigger:** Any of:
- More than 8 ECS tasks running
- Adding Lambda functions that need direct DB access
- Connection pool headroom <20% during rolling deploys
- `pool.waitingCount > 0` despite proper sizing

**Capacity after:** Virtually unlimited connection fan-out (hundreds of app connections → fewer DB connections)
**Cost impact:** +$22/month per vCPU of RDS instance
**Effort:** 2-4 hours

### Complexity Assessment: Low

RDS Proxy is one of the simpler AWS managed services to adopt. Here's why:

**What changes:**
1. One CDK construct (~30 lines)
2. One environment variable (`DATABASE_URL` points to proxy endpoint instead of RDS)
3. IAM role for proxy to access RDS credentials

**What does NOT change:**
- Application code (zero changes — same `pg.Pool`, same Prisma, same queries)
- Connection pool config (keep the in-process pool; it now connects to proxy instead of RDS)
- Schema, migrations, or ORM config
- Test infrastructure

### 4a. Add RDS Proxy to CDK

```typescript
// infra/lib/stacks/data-stack.ts
import * as rds from 'aws-cdk-lib/aws-rds';

const proxy = new rds.DatabaseProxy(this, 'RdsProxy', {
  proxyTarget: rds.ProxyTarget.fromInstance(database),
  secrets: [database.secret!],
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [dbSecurityGroup],
  requireTLS: true,
  idleClientTimeout: Duration.minutes(30),
  maxConnectionsPercent: 90,      // Use up to 90% of RDS max_connections
  maxIdleConnectionsPercent: 50,  // Keep 50% of pool idle for bursts
  borrowTimeout: Duration.seconds(30),
  dbProxyName: `trellis-${stage}-proxy`,
});

// Store proxy endpoint in SSM
new ssm.StringParameter(this, 'ProxyEndpoint', {
  parameterName: `/trellis/${stage}/rds-proxy-endpoint`,
  stringValue: proxy.endpoint,
});
```

### 4b. Update DATABASE_URL

**File:** `infra/lib/stacks/api-stack.ts`

Change the `DATABASE_URL` environment variable for ECS tasks to use the proxy endpoint instead of the direct RDS endpoint. The connection string format is identical — only the hostname changes.

### 4c. Reduce per-task pool size

With RDS Proxy multiplexing, the per-task pool can be smaller because the proxy handles connection reuse across tasks:

```
Before proxy: pool max = 15 (each task holds real RDS connections)
After proxy:  pool max = 10 (proxy consolidates; fewer real connections needed)
```

### 4d. Enable Lambda → DB access

Once the proxy exists, Lambda workers that currently use DynamoDB for DB-like operations can connect directly to PostgreSQL through the proxy. The proxy handles the connection churn that makes Lambda + RDS problematic.

### Rollback plan

If the proxy causes issues, revert `DATABASE_URL` to the direct RDS endpoint. The proxy is purely a network hop — no schema or application changes to undo.

---

## Phase 5: Read Replicas (500K+ DAU)

**Trigger:** Any of:
- RDS writer CPU sustained >70% and most load is reads
- Write latency increasing due to read contention
- Need for analytics queries that shouldn't impact production

**Capacity after:** 2-3x read throughput
**Cost impact:** +$25-100/month per replica (same instance class as primary)
**Effort:** 3-5 days

### 5a. Add read replica in CDK

```typescript
const readReplica = new rds.DatabaseInstanceReadReplica(this, 'ReadReplica', {
  sourceDatabaseInstance: database,
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
});
```

### 5b. Implement read/write splitting in the application

Two approaches:

**Option A — Prisma-level (recommended):**
```typescript
// Two Prisma clients: one for writes, one for reads
const writePool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const readPool = new Pool({ connectionString: process.env.DATABASE_READ_URL, max: 15 });

const writePrisma = new PrismaClient({ adapter: new PrismaPg(writePool) });
const readPrisma = new PrismaClient({ adapter: new PrismaPg(readPool) });
```

**Option B — RDS Proxy reader endpoint:**
RDS Proxy provides a read-only endpoint that automatically routes to replicas. Simpler but less control.

### 5c. Route queries

- All `SELECT` queries for feeds, profiles, search → read replica
- All writes (`INSERT`, `UPDATE`, `DELETE`) → primary
- Queries that must read-your-own-writes (e.g., "create post then redirect to it") → primary

**Replication lag:** Typically <100ms for RDS PostgreSQL. For most social features, this is invisible. For actions where the user expects to see their own write immediately, route to primary.

---

## Phase 6: CDN + Edge Caching for API (1M+ DAU)

**Trigger:** Any of:
- API response times dominated by geography (users far from eu-central-1)
- Feed endpoints generating >50% redundant responses across users
- Need to reduce origin load without adding more ECS tasks

**Capacity after:** 10x reduction in origin requests for cacheable endpoints
**Cost impact:** ~$0 incremental (CloudFront already deployed; just enabling caching)
**Effort:** 2-3 days

### 6a. Cache public/semi-public API responses at CloudFront

Endpoints suitable for edge caching:

| Endpoint | Cache TTL | Vary By | Invalidation |
|---|---|---|---|
| `GET /api/entities/:id` (public) | 60s | None | On entity update |
| `GET /api/feeds/discover` | 300s | Region | Time-based |
| `GET /api/users/:id/profile` (public) | 60s | None | On profile update |
| Media URLs (`/media/*`) | 365 days | None | Already cached |

**NOT cacheable:** Authenticated feeds, session-dependent responses, write endpoints.

### 6b. Add Cache-Control headers from the API

```typescript
// For public endpoints
response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

// For private endpoints
response.headers.set('Cache-Control', 'private, no-store');
```

### 6c. Implement cache invalidation

On entity update, invalidate the CloudFront path:
```typescript
await cloudfront.createInvalidation({
  DistributionId: process.env.CF_DISTRIBUTION_ID,
  InvalidationBatch: {
    Paths: { Quantity: 1, Items: [`/api/entities/${entityId}`] },
    CallerReference: Date.now().toString(),
  },
});
```

Use sparingly — CloudFront charges for invalidations beyond 1,000/month.

---

## Phase 7: Multi-Region (5M+ DAU)

**Trigger:** Any of:
- Regulatory requirement for data residency (GDPR, etc.)
- User base concentrated in multiple continents
- Need for disaster recovery with <1 minute failover

**Capacity after:** Effectively unlimited horizontal scale
**Cost impact:** 2x infrastructure cost (full stack per region)
**Effort:** 2-4 weeks

This is a major architectural change. High-level approach:

### 7a. Active-passive (simpler)

- Primary region: eu-central-1 (all writes)
- Secondary region: us-east-1 (read replica, standby ECS)
- CloudFront routes to nearest healthy origin
- RDS cross-region read replica for fast failover
- DynamoDB Global Tables for session/KV replication

### 7b. Active-active (complex, only if needed)

- Both regions accept writes
- Conflict resolution strategy required (last-write-wins or CRDT)
- DynamoDB Global Tables handle multi-region KV natively
- PostgreSQL requires logical replication or a multi-master solution

**Recommendation:** Defer until regulatory or latency requirements demand it. Active-passive is sufficient for most social apps up to 10M+ users.

---

## Scaling Decision Tree

```
START
  │
  ├─ Can't handle concurrent requests?
  │  └─ Phase 0: Fix connection pool (Plan 002)
  │
  ├─ CPU/memory at ceiling on current instance?
  │  └─ Phase 1: Vertical scaling (bigger tasks/RDS)
  │
  ├─ Single task at ceiling even after upsizing?
  │  └─ Phase 2: Horizontal scaling (more tasks)
  │
  ├─ Read queries dominating DB load?
  │  └─ Phase 3: Redis cache
  │
  ├─ >8 tasks or Lambda needs DB?
  │  └─ Phase 4: RDS Proxy
  │
  ├─ Write contention or analytics load?
  │  └─ Phase 5: Read replicas
  │
  ├─ Origin overloaded by cacheable requests?
  │  └─ Phase 6: CDN API caching
  │
  └─ Global presence or data residency?
     └─ Phase 7: Multi-region
```

## Estimated Capacity at Each Phase

| Phase | Max req/s | Est. DAU | Est. Registered | Monthly Cost (Prod) |
|---|---|---|---|---|
| Current (broken) | ~20 | ~200 | ~600 | ~$120 |
| 0: Pool fix | ~2,000-6,000 | ~50K-600K | ~200K-1.8M | ~$120 |
| 1: Vertical | ~5,000-15,000 | ~100K-1M | ~300K-3M | ~$170 |
| 2: Horizontal | ~15,000-40,000 | ~500K-3M | ~1.5M-9M | ~$300 |
| 3: + Redis | ~30,000-80,000 | ~1M-5M | ~3M-15M | ~$330 |
| 4: + RDS Proxy | ~50,000-100,000 | ~2M-8M | ~6M-24M | ~$360 |
| 5: + Read replicas | ~100,000-200,000 | ~5M-15M | ~15M-45M | ~$460 |
| 6: + CDN caching | ~500,000+ | ~10M+ | ~30M+ | ~$500 |

These are rough estimates. Real capacity depends on query complexity, payload sizes, and traffic patterns. The cost column assumes prod-like sizing; dev stays minimal.

## Key Principles

1. **Measure, don't guess.** Every phase is triggered by observable metrics, not user counts.
2. **Vertical before horizontal.** Upsizing is cheaper and simpler than adding complexity.
3. **Cache before replicate.** Redis eliminates reads that never needed to hit the DB.
4. **Proxy is a drop-in.** RDS Proxy requires zero application code changes.
5. **Each phase is independent.** Skip phases that aren't needed. The order is a recommendation, not a requirement.
6. **Cost grows sub-linearly.** Going from 1K to 1M users roughly triples cost, not multiplies it 1000x.

## Files Modified Per Phase

| Phase | Files | Type |
|---|---|---|
| 0 | 5 app + 2 infra | Code + config |
| 1 | 2-3 config files | Config only |
| 2 | 1-2 config + 1 infra | Config + CDK |
| 3 | 1 CDK stack + 2-3 app files + 1 config | New service + code |
| 4 | 1 CDK stack + 1 env var | CDK + config |
| 5 | 1 CDK stack + 2-3 app files | CDK + code |
| 6 | 1 CDN config + 2-3 route files | CDK + code |
| 7 | Full stack duplication | Major project |
