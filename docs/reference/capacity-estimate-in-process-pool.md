---
title: Capacity estimate — in-process connection pool
description: Throughput and user-scale estimates for Trellis using a per-task pg.Pool, with analysis of real bottlenecks.
sidebar: Capacity estimate (connection pool)
order: 20
---

# Capacity estimate: in-process connection pool

This page estimates the maximum traffic and registered-user scale Trellis can handle with a properly configured in-process `pg.Pool` (one pool per ECS task, no external connection pooler).

## Throughput model

```
requests/sec = (pool_connections × tasks) / (avg_query_duration_sec × queries_per_request)
```

### Assumptions

| Parameter | Conservative | Realistic |
|-----------|-------------|-----------|
| Avg query duration | 10 ms | 5 ms |
| Queries per request | 3 | 2 |
| Effective query time per request | 30 ms | 10 ms |

### Dev (small DB instance, 2 tasks, pool size = 10)

```
Conservative: (10 × 2) / 0.030 ≈ 667 req/s
Realistic:    (10 × 2) / 0.010 ≈ 2,000 req/s
```

### Prod (medium DB instance, 4 tasks, pool size = 15)

```
Conservative: (15 × 4) / 0.030 ≈ 2,000 req/s
Realistic:    (15 × 4) / 0.010 ≈ 6,000 req/s
```

---

## Translating to users

Typical social-app traffic patterns:

- ~0.1 req/s per concurrent active user (scrolling, tapping)
- ~10:1 ratio of DAU to peak concurrent users
- ~3:1 ratio of registered users to DAU (for an engaged social app)

| Metric | Dev (conservative) | Prod (realistic) |
|--------|--------------------|-----------------|
| Sustained req/s | ~667 | ~6,000 |
| Peak concurrent users | ~6,670 | ~60,000 |
| DAU | ~66,700 | ~600,000 |
| Registered users | ~200 K | ~1.8 M |

---

## Real bottlenecks

The connection pool is unlikely to be the ceiling. Other limits are reached first:

| Bottleneck | Limit | When it hits |
|-----------|-------|-------------|
| Small DB CPU (burstable 2 vCPU) | ~200–500 req/s sustained | Burst credits deplete |
| Medium DB CPU (burstable 2 vCPU) | ~500–1,000 req/s sustained | Burst credits deplete |
| ECS task CPU (0.25–1 vCPU) | ~500–2,000 req/s | Depends on task size |
| RDS IOPS (3,000 baseline gp3) | — | Write-heavy workloads |
| Connection pool (20–60 total) | ~2,000–6,000 req/s | High concurrency |

**Bottom line:** The in-process pool comfortably handles tens of thousands of DAU. Burstable CPU on the database instance will be the actual bottleneck well before connection limits matter.

---

## When to revisit

Consider adding RDS Proxy or PgBouncer if any of the following apply:

- Scaling beyond 8 ECS tasks.
- Adding Lambda functions that need direct database access.
- Sustained (non-burst) traffic exceeds the database instance's CPU capacity.
- `pool.waitingCount > 0` appears regularly in metrics.
