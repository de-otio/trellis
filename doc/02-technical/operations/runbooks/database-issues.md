# Runbook: Database Issues

> **Status — target model, not runnable from this repo.** Trellis is not deployed
> standalone; the `scripts/ops/*` helpers referenced here are **not part of this
> repository** — they belong to the consuming application. The raw AWS CLI
> commands below are the target operational shape (`{app}-{stage}` is the
> consuming application's resource prefix).

## Check status

The consuming application's `scripts/ops/db.sh` wraps RDS instance status,
Performance Insights top queries, and current connection count. No such script
ships in this repo; use the AWS console / CLI (RDS + Performance Insights)
directly.

## High CPU

Query Performance Insights for slow queries (the consuming app's `db.sh`
wraps this).

Common causes: missing index, N+1 queries, unvacuumed table bloat.

## Too many connections

The t4g.micro supports ~87 connections. At max 4 Fargate tasks × 20 Prisma connections = 80 connections peak.

If exhausted:
1. Check if Lambda workers are unexpectedly using VPC connections at high concurrency
2. Restart Fargate to reset connection pools: `aws ecs update-service --cluster trellis-dev --service trellis-dev-api --force-new-deployment`
3. If persistent, check for connection leaks in handler code (missing `client.release()`)

## Low storage

RDS auto-expands up to 50 GB (dev) / 200 GB (prod). If approaching the max:

```bash
# Find largest tables (run via ECS Exec)
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size
FROM pg_tables WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
```

To increase the max, update `dbMaxAllocatedStorageGb` in `infra/lib/config.ts` and redeploy `DataStack`.

## Emergency: psql via ECS Exec

```bash
# Get a running task ARN
TASK_ARN=$(aws ecs list-tasks \
  --cluster trellis-dev \
  --service-name trellis-dev-api \
  --query "taskArns[0]" --output text)

# Open a shell inside the running container
aws ecs execute-command \
  --cluster trellis-dev \
  --task $TASK_ARN \
  --container api \
  --interactive \
  --command "/bin/sh"
```

## Pre-migration snapshot

Before any destructive migration on prod:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier trellis-prod \
  --db-snapshot-identifier "trellis-prod-pre-migration-$(date +%Y%m%d)"
```
