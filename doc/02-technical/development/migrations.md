# Database Migrations

## Creating a migration

1. Edit `prisma/schema.prisma`
2. `npm run prisma:migrate:dev -- --name describe-your-change`
3. `npm run prisma:generate` to regenerate the Prisma client
4. Commit both the `prisma/migrations/` file and `schema.prisma`

## Deploying migrations to AWS

Migrations run as a one-off ECS task, not at app startup (avoids race conditions when scaling):

```bash
# Via the full deploy script (runs automatically)
./scripts/deploy.sh dev

# Manual trigger
CLUSTER=trellis-dev
SUBNETS=$(aws ssm get-parameter --name /trellis/dev/private-subnet-ids --query Parameter.Value --output text)
SG=$(aws ssm get-parameter --name /trellis/dev/fargate-sg-id --query Parameter.Value --output text)

aws ecs run-task \
  --cluster $CLUSTER \
  --task-definition trellis-dev-api \
  --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"api","command":["npx","prisma","migrate","deploy"]}]}' \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG]}"
```

## Zero-downtime: expand-contract pattern

For changes that could break a running API instance:

| Step | Action | Deploy? |
|------|--------|---------|
| 1. Expand | Add new nullable column / table | Deploy |
| 2. Write dual | Code writes to old + new column | Deploy |
| 3. Backfill | Script populates new column from old | Deploy |
| 4. Switch reads | Code reads new column only | Deploy |
| 5. Contract | Remove old column in new migration | Deploy |

**Never in a single migration:**
- Rename a column
- Drop a column that code still reads
- Change a column from nullable to non-null without a backfill

## RDS snapshots

Before any destructive migration on prod, take a manual snapshot:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier trellis-prod \
  --db-snapshot-identifier trellis-prod-pre-migration-$(date +%Y%m%d)
```
