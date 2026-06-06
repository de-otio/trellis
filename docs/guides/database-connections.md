---
title: Database Connections
description: How to manage PostgreSQL connections from the Trellis API to RDS, including pooling options, sizing, and anti-patterns.
sidebar: Database Connections
order: 70
---

# Database Connections

## Overview

The Trellis API is a long-lived Node.js process. A database connection is expensive to establish (~10–50 ms for TCP + TLS + PostgreSQL handshake). The goal is to reuse connections across requests without exhausting the RDS connection limit.

## Connection pooling options

### In-process pool (recommended)

Create a single `pg.Pool` at process startup. Every request checks out a connection, runs queries, and returns it to the pool. The pool handles connection creation, reuse, idle cleanup, health checks, and queue management.

```
API process (Node.js)
┌─────────────────────────────────────────┐
│  pg.Pool (max: 10)                      │
│  ┌─────┐ ┌─────┐ ┌─────┐     ┌─────┐  │
│  │conn1│ │conn2│ │conn3│ ... │conn10│  │
│  └──┬──┘ └──┬──┘ └──┬──┘     └──┬──┘  │
│     └───────┴───────┴───────────┘      │
│                    │                    │
└────────────────────┼────────────────────┘
                     │ persistent TCP connections
                     ▼
              ┌─────────────┐
              │   RDS        │
              │  PostgreSQL  │
              └─────────────┘
```

**Configuration:**

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,      // Close idle connections after 30 s
  connectionTimeoutMillis: 5000, // Fail if a connection cannot be obtained in 5 s
  allowExitOnIdle: false,        // Keep pool alive when idle
});
```

**Graceful shutdown** (required for rolling deploys):

```typescript
process.on('SIGTERM', async () => {
  await pool.end(); // Closes all connections cleanly
  process.exit(0);
});
```

### RDS Proxy

A fully managed connection pooler that sits between the application and RDS. The application connects to the proxy endpoint; the proxy maintains a warm pool to the database and multiplexes application connections onto fewer database connections.

**Use RDS Proxy when:**
- Running Lambda functions that cannot maintain persistent pools
- Operating large fleets where total connections would exceed RDS limits
- IAM database authentication is required (the proxy handles token refresh)

**Skip RDS Proxy when:**
- Running a small number of tasks with proper in-process pooling (the proxy adds cost that may exceed the RDS instance cost itself)

### PgBouncer sidecar

Run PgBouncer as a sidecar in the same task definition. The application connects to `localhost:6432`.

**Use PgBouncer when:**
- Multiple processes per task need to share a connection pool
- Transaction-mode pooling is required

**Skip PgBouncer when:**
- There is a single Node.js process per task — in-process pooling is simpler and has no sidecar overhead.

### Prisma Accelerate

Prisma's managed global connection pooler and edge cache.

**Use Prisma Accelerate for** serverless or edge deployments (Vercel Edge, Cloudflare Workers) where a persistent pool cannot be maintained.

**Skip Prisma Accelerate for** ECS deployments in the same VPC as RDS — direct connections with in-process pooling are cheaper and lower latency.

---

## RDS `max_connections` by instance class

PostgreSQL on RDS derives `max_connections` from instance memory:

```
max_connections = LEAST(DBInstanceClassMemory / 9531392, 5000)
```

| Instance | Memory | max_connections | Usable* |
|----------|--------|-----------------|---------|
| db.t4g.micro | 1 GiB | ~112 | ~99 |
| db.t4g.small | 2 GiB | ~225 | ~212 |
| db.t4g.medium | 4 GiB | ~450 | ~437 |
| db.t3.medium | 4 GiB | ~450 | ~437 |
| db.r6g.large | 16 GiB | ~1710 | ~1697 |

*Usable = `max_connections` minus ~13 reserved slots (for the RDS admin user, migrations, monitoring, and manual access).

Verify on your instance:

```sql
SELECT setting FROM pg_settings WHERE name = 'max_connections';
```

---

## Pool sizing formula

```
pool_per_task = floor(usable_connections / max_concurrent_tasks)
```

Account for rolling deploys, which temporarily double the task count:

```
max_concurrent_tasks = max_desired_count * 2
```

**Rule of thumb:** start at `10`. Increase to `15–20` only if you observe pool wait times in metrics. Exceeding `floor(usable / max_concurrent_tasks)` risks connection exhaustion during deploys.

---

## Behaviour during ECS scaling events

### Scale-up

New tasks create pool connections lazily (on first query, not at startup). Total connections ramp up gradually.

### Rolling deploy

Old and new tasks run briefly in parallel. Old tasks receive `SIGTERM`, call `pool.end()`, and release their connections before the new tasks reach steady state.

If `pool.end()` is not called (crash or `kill -9`), RDS reclaims idle TCP connections via `tcp_keepalives_idle` (default 300 s on RDS).

### Scale-down

Tasks are deregistered from the load balancer, receive `SIGTERM`, and call `pool.end()` to release connections gracefully.

---

## Monitoring

### CloudWatch alarms

| Metric | Threshold | Purpose |
|--------|-----------|---------|
| RDS `DatabaseConnections` | > 80% of `max_connections` | Approaching limit |
| RDS `CPUUtilization` | > 80% | Instance undersized for query load |
| RDS `FreeableMemory` | < 100 MB | Instance running low on memory |
| ECS task health check failures | > 0 for 5 min | Possible connection exhaustion |

### pg.Pool events

```typescript
pool.on('connect', () => { /* new connection established */ });
pool.on('acquire', () => { /* connection checked out */ });
pool.on('release', () => { /* connection returned */ });
pool.on('remove', () => { /* connection removed (idle timeout or error) */ });
pool.on('error', (err) => { /* connection error */ });
```

Useful metrics to emit to CloudWatch:
- `pool.totalCount` — total connections (active + idle)
- `pool.idleCount` — idle connections available
- `pool.waitingCount` — requests waiting for a connection (> 0 means pool is saturated)

---

## Anti-patterns

### Per-request pool creation

```typescript
// WRONG — creates a new pool and TCP connection for every request
async function handleRequest(req) {
  const pool = new Pool({ max: 1, connectionString: DB_URL });
  const result = await pool.query('SELECT ...');
  await pool.end();
  return result;
}
```

Cost: ~10–50 ms handshake overhead per request; each request holds a separate RDS connection slot.

### Pool max too high

```typescript
// WRONG — may exhaust RDS connection slots during a rolling deploy
const pool = new Pool({ max: 50 });
```

During a rolling deploy the task count temporarily doubles. Multiply `pool.max` by the maximum task count to verify you stay within `usable_connections`.

### No idle timeout

```typescript
// WRONG — connections never close, even when traffic drops to zero
const pool = new Pool({ max: 10, idleTimeoutMillis: 0 });
```

Use `idleTimeoutMillis: 30000` to release connections after a quiet period and avoid wasting RDS slots.

### No graceful shutdown

```typescript
// WRONG — connections stay open until tcp_keepalives_idle expires (300 s)
process.on('SIGTERM', () => process.exit(0));
```

Always call `pool.end()` before exiting.

---

## Prisma with the pg adapter

When Trellis uses `@prisma/adapter-pg`, Prisma delegates connection management to the `pg.Pool` you supply. The `?connection_limit=N` query parameter in `DATABASE_URL` has **no effect** in this configuration — it only applies when using Prisma's built-in connection engine (without the pg adapter).

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ max: 10, connectionString: DB_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
```

The pool controls everything; Prisma simply uses it.
