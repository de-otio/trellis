# Capacity Estimate: In-Process Connection Pool (Option 1)

Estimates for max traffic/users Trellis can handle with a properly configured in-process `pg.Pool`, based on the architecture in [aws-ecs-database-connections.md](aws-ecs-database-connections.md) and [Plan 002](../../../plans/002-database-connections-and-cloudflare-cleanup.md).

## Throughput Model

```
requests/sec = (pool_connections × tasks) / (avg_query_duration_sec × queries_per_request)
```

### Assumptions

| Parameter | Conservative | Realistic |
|---|---|---|
| Avg query duration | 10ms | 5ms |
| Queries per request | 3 | 2 |
| Effective query time per request | 30ms | 10ms |

### Dev (db.t4g.micro, 2 tasks, pool=10)

```
Conservative: (10 × 2) / 0.030 = ~667 req/s
Realistic:    (10 × 2) / 0.010 = ~2,000 req/s
```

### Prod (db.t4g.small, 4 tasks, pool=15)

```
Conservative: (15 × 4) / 0.030 = ~2,000 req/s
Realistic:    (15 × 4) / 0.010 = ~6,000 req/s
```

## Translating to Users

Typical social app traffic patterns:
- ~0.1 req/s per concurrent active user (scrolling, tapping)
- ~10:1 ratio of DAU to peak concurrent users
- ~3:1 ratio of registered users to DAU (for an engaged social app)

| Metric | Dev (conservative) | Prod (realistic) |
|---|---|---|
| Sustained req/s | ~667 | ~6,000 |
| Peak concurrent users | ~6,670 | ~60,000 |
| DAU | ~66,700 | ~600,000 |
| Registered users | ~200K | ~1.8M |

## The Real Bottleneck

The connection pool is unlikely to be the ceiling. Other limits hit first:

| Bottleneck | Limit | When it hits |
|---|---|---|
| **db.t4g.micro CPU** | 2 vCPUs (burstable) | ~200-500 req/s sustained (burst credits deplete) |
| **db.t4g.small CPU** | 2 vCPUs (burstable) | ~500-1,000 req/s sustained |
| **ECS task CPU** | 0.25-1 vCPU per task | ~500-2,000 req/s depending on task size |
| **RDS IOPS** | 3,000 baseline (gp3) | Write-heavy workloads |
| **Connection pool** | 20-60 total connections | ~2,000-6,000 req/s |

**Bottom line:** With the pool fix (Plan 002), the in-process pool comfortably handles tens of thousands of DAU before needing RDS Proxy or a bigger instance. The burstable CPU on t4g.micro/small will be the actual bottleneck well before connection limits matter.

## When to Revisit

Revisit RDS Proxy or PgBouncer if:
- Scaling beyond 8 ECS tasks
- Adding Lambda functions that need direct database access
- Sustained (non-burst) traffic exceeds db.t4g.small CPU capacity
- `pool.waitingCount > 0` appears regularly in metrics
