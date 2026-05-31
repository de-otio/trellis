# AWS Best Practices: Database Connections in ECS Fargate

This document covers how to manage PostgreSQL connections from ECS Fargate tasks to RDS, based on AWS documentation and the constraints of this project.

## The Core Problem

A Node.js process on ECS is long-lived (hours to days). A database connection is expensive to establish (~10-50ms for TCP + TLS + PostgreSQL handshake). The goal is to reuse connections across requests without exhausting the RDS connection limit.

Cloudflare Workers solved this with Hyperdrive (a managed proxy that pools connections at the edge). ECS has no such proxy by default — the application must manage its own pool.

## Connection Pooling Options

### Option 1: In-Process Pool (Recommended for Trellis)

Create a single `pg.Pool` at process startup. Every request checks out a connection, runs queries, and returns it to the pool. The pool handles:

- Connection creation (lazy, on first checkout)
- Connection reuse (same TCP connection serves multiple requests)
- Idle connection cleanup (configurable timeout)
- Connection health checks (automatic reconnect on broken connections)
- Queue management (requests wait if all connections are busy)

```
ECS Task (Node.js process)
┌─────────────────────────────────────────┐
│  pg.Pool (max: 10)                      │
│  ┌─────┐ ┌─────┐ ┌─────┐     ┌─────┐  │
│  │conn1│ │conn2│ │conn3│ ... │conn10│  │
│  └──┬──┘ └──┬──┘ └──┬──┘     └──┬──┘  │
│     └───────┴───────┴───────────┘      │
│                    │                    │
└────────────────────┼────────────────────┘
                     │ 10 persistent TCP connections
                     ▼
              ┌─────────────┐
              │   RDS        │
              │  PostgreSQL  │
              │  (112 slots) │
              └─────────────┘
```

**When to use:** Always, for ECS. This is the baseline pattern.

**Configuration:**

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,       // Close idle connections after 30s
  connectionTimeoutMillis: 5000,   // Fail if can't get connection in 5s
  allowExitOnIdle: false,          // Keep pool alive even when idle
});
```

**Graceful shutdown** (required for ECS rolling deploys):

```typescript
process.on('SIGTERM', async () => {
  await pool.end();  // Closes all connections cleanly
  process.exit(0);
});
```

### Option 2: RDS Proxy

A fully managed connection pooler that sits between ECS and RDS. Application connects to the proxy endpoint; the proxy maintains a warm pool to the database and multiplexes application connections onto fewer database connections.

```
ECS Task 1 ──┐
ECS Task 2 ──┼── RDS Proxy (manages pool) ── RDS PostgreSQL
ECS Task 3 ──┘
```

**When to use:**
- Lambda functions (short-lived, can't maintain persistent pools)
- Large ECS fleets (20+ tasks) where total connections would exceed RDS limits
- When you need IAM database authentication (Proxy handles token refresh)
- When you want automatic Multi-AZ failover handling

**When NOT to use:**
- Small ECS fleets (1-4 tasks) with proper in-process pooling
- When the proxy cost is disproportionate to RDS cost

**Pricing (eu-central-1, 2025):**

| RDS Instance | vCPUs | Proxy cost/month | RDS cost/month | Proxy as % of RDS |
|---|---|---|---|---|
| db.t4g.micro | 2 | ~$21.60 | ~$12.41 | 174% |
| db.t4g.small | 2 | ~$21.60 | ~$24.82 | 87% |
| db.t4g.medium | 2 | ~$21.60 | ~$49.64 | 44% |
| db.r6g.large | 2 | ~$21.60 | ~$186 | 12% |

For Trellis's dev environment (db.t4g.micro), RDS Proxy nearly triples the database cost. Not justified at current scale.

**Latency:** Adds 1-3ms per query due to the extra network hop. Negligible for most applications, but noticeable if you make 50+ queries per request.

### Option 3: PgBouncer Sidecar

Run PgBouncer as a sidecar container in the same ECS task definition. The application connects to `localhost:6432`; PgBouncer pools connections to RDS.

**When to use:**
- Multiple processes per task that need to share a connection pool
- Transaction-mode pooling (allows connection sharing between transactions, not just between requests)
- When you need PgBouncer-specific features (connection limits per user/database, query logging)

**When NOT to use:**
- Single Node.js process per task (in-process pooling is simpler and has no sidecar overhead)
- When you don't need transaction-mode pooling

**For Trellis:** Not needed. One Node.js process per Fargate task. In-process pooling is sufficient.

### Option 4: Prisma Accelerate

Prisma's managed global connection pooler + edge cache. The equivalent of Hyperdrive for the Prisma ecosystem.

**When to use:**
- Serverless/edge deployments (Vercel Edge, Cloudflare Workers)
- When you want built-in query caching

**When NOT to use:**
- ECS in the same VPC as RDS — a managed proxy adds cost ($0.10/1000 queries on Pro) and latency for no benefit

**For Trellis:** Not needed. Direct VPC connections with in-process pooling are cheaper and lower latency.

## RDS max_connections by Instance Class

PostgreSQL on RDS calculates `max_connections` from instance memory:

```
max_connections = LEAST(DBInstanceClassMemory / 9531392, 5000)
```

| Instance | Memory | max_connections | Usable* |
|---|---|---|---|
| db.t4g.micro | 1 GiB | ~112 | ~99 |
| db.t4g.small | 2 GiB | ~225 | ~212 |
| db.t4g.medium | 4 GiB | ~450 | ~437 |
| db.t3.medium | 4 GiB | ~450 | ~437 |
| db.r6g.large | 16 GiB | ~1710 | ~1697 |

*Usable = max_connections minus ~13 reserved (3 for rdsadmin + ~10 for migrations, monitoring, manual access).

Verify on your instance: `SELECT setting FROM pg_settings WHERE name = 'max_connections';`

## Pool Sizing Formula

```
pool_per_task = floor(usable_connections / max_concurrent_tasks)
```

Where `max_concurrent_tasks` accounts for rolling deploys (ECS temporarily doubles task count):

```
max_concurrent_tasks = max_desired_count * 2
```

### Applied to Trellis

**Dev (db.t4g.micro, max 2 tasks):**
```
usable = 112 - 13 = 99
max_concurrent_tasks = 2 * 2 = 4  (rolling deploy)
pool_per_task = floor(99 / 4) = 24
recommended = 10  (conservative, leaves headroom)
```

**Prod (db.t4g.small, max 4 tasks):**
```
usable = 225 - 13 = 212
max_concurrent_tasks = 4 * 2 = 8  (rolling deploy)
pool_per_task = floor(212 / 8) = 26
recommended = 15  (conservative, leaves headroom)
```

**Rule of thumb:** Start at 10. Increase to 15-20 only if you see pool wait times in metrics. Going above `floor(usable / max_concurrent_tasks)` risks connection exhaustion during deploys.

## What Happens When ECS Scales

### Scale-up (2 → 4 tasks)

1. ECS launches 2 new tasks
2. Each new task's pool creates connections lazily (on first query, not at startup)
3. Over ~5 seconds, each pool ramps up to its steady-state connection count
4. Total connections: 4 tasks × 10 connections = 40 (well under 112 for dev, 225 for prod)

### Rolling deploy (old 2 + new 2 = 4 tasks temporarily)

1. ECS launches 2 new tasks alongside 2 existing tasks
2. Briefly, 4 tasks are running: 4 × 10 = 40 connections
3. Old tasks receive SIGTERM, call `pool.end()`, connections close
4. Settles back to 2 × 10 = 20 connections

If `pool.end()` is not called (crash, kill -9), RDS detects idle TCP connections via `tcp_keepalives_idle` (default 300s on RDS) and reclaims the slots.

### Scale-down (4 → 2 tasks)

1. ECS deregisters 2 tasks from the target group (stops routing traffic)
2. Tasks receive SIGTERM after deregistration delay
3. `pool.end()` closes connections gracefully
4. Total connections: 2 × 10 = 20

## Monitoring

### CloudWatch Alarms

| Metric | Alarm threshold | Why |
|---|---|---|
| RDS `DatabaseConnections` | 80% of max_connections | Approaching limit; investigate before exhaustion |
| RDS `CPUUtilization` | 80% | Instance undersized for query load |
| RDS `FreeableMemory` | < 100 MB | Instance running out of memory for caches |
| ECS task health check failures | > 0 for 5 min | May indicate connection exhaustion |

### pg.Pool Metrics

The `pg` library emits events you can monitor:

```typescript
pool.on('connect', () => { /* new connection established */ });
pool.on('acquire', () => { /* connection checked out */ });
pool.on('release', () => { /* connection returned */ });
pool.on('remove', () => { /* connection removed (idle timeout, error) */ });
pool.on('error', (err) => { /* connection error */ });
```

Useful metrics to emit to CloudWatch:
- `pool.totalCount` — total connections (active + idle)
- `pool.idleCount` — idle connections available
- `pool.waitingCount` — requests waiting for a connection (> 0 means pool is saturated)

## Anti-Patterns

### Per-request pool creation (current Trellis pattern)

```typescript
// WRONG — creates a new pool (and TCP connection) for every request
async function handleRequest(req) {
  const pool = new Pool({ max: 1, connectionString: DB_URL });
  const result = await pool.query('SELECT ...');
  await pool.end();
  return result;
}
```

Cost: ~10-50ms handshake overhead per request. Under concurrent load, each request holds a separate RDS connection slot.

### Pool max too high

```typescript
// WRONG — 50 connections × 4 tasks = 200 > 112 (db.t4g.micro limit)
const pool = new Pool({ max: 50 });
```

During a rolling deploy (8 tasks briefly), this tries to open 400 connections. RDS rejects new connections, health checks fail, cascade failure.

### No idle timeout

```typescript
// WRONG — connections never close, even when traffic drops to zero
const pool = new Pool({ max: 10, idleTimeoutMillis: 0 });
```

A process that handled a traffic spike keeps 10 connections open permanently, wasting RDS slots. Use `idleTimeoutMillis: 30000` (30s) to release connections after a quiet period.

### No graceful shutdown

```typescript
// WRONG — process exits without closing connections
process.on('SIGTERM', () => process.exit(0));
```

RDS doesn't know the connections are dead until `tcp_keepalives_idle` expires (300s). During that window, those slots are wasted. Always call `pool.end()` before exiting.

## Prisma-Specific Guidance

When using Prisma with the `@prisma/adapter-pg` driver adapter (as Trellis does), Prisma delegates connection management to the `pg.Pool` you provide. Prisma's own `connection_limit` URL parameter does NOT apply.

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// The pool controls everything — Prisma just uses it
const pool = new Pool({ max: 10, connectionString: DB_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
```

The `?connection_limit=N` query parameter in `DATABASE_URL` only applies when using Prisma's built-in connection engine (without the pg adapter). Since Trellis uses the pg adapter, this parameter is ignored.

## Decision Record

For Trellis at current scale (1-4 Fargate tasks, db.t4g.micro/small):

| Option | Decision | Reason |
|---|---|---|
| In-process pg.Pool | **Use** | Simple, zero cost, sufficient for 1-4 tasks |
| RDS Proxy | Skip | Costs more than the RDS instance itself |
| PgBouncer sidecar | Skip | Unnecessary for single-process-per-task |
| Prisma Accelerate | Skip | Same VPC, no benefit over direct connection |

Revisit RDS Proxy if scaling beyond 8 tasks or adding Lambda functions that need database access.
