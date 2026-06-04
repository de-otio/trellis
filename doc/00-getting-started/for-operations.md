# Operations Guide

## Quick commands

```bash
STAGE=dev ./scripts/ops/status.sh                        # service health + DLQ depths
STAGE=dev ./scripts/ops/logs.sh api 30                   # API logs (last 30 min)
STAGE=dev ./scripts/ops/errors.sh 2                      # errors in last 2 hours
STAGE=dev ./scripts/ops/db.sh status                     # RDS status
STAGE=dev ./scripts/ops/feature-flags.sh dev list        # list feature flags
```

## Deploying

```bash
# Recommended: full automated deploy
./scripts/deploy.sh dev

# Manual CDK deploy — stateful stacks first, then stateless
cd infra
npx cdk deploy "Trellis-dev-Network" "Trellis-dev-Data" "Trellis-dev-Storage" "Trellis-dev-Auth"
npx cdk deploy "Trellis-dev-Api" "Trellis-dev-Workers" "Trellis-dev-Cdn" "Trellis-dev-Monitoring"
```

## Rolling back

```bash
STAGE=dev ./scripts/ops/incident/rollback.sh             # interactive (lists recent tags)
STAGE=dev ./scripts/ops/incident/rollback.sh <git-sha>   # non-interactive
```

## Monitoring

- **CloudWatch dashboard**: AWS Console → CloudWatch → Dashboards → `trellis-{stage}`
- **Alarms**: CloudWatch → Alarms → filter `trellis-{stage}`
- **Traces**: CloudWatch → X-Ray → Service Map
- **DLQ alerts**: SNS topic `trellis-{stage}-alerts` sends email on DLQ activity

## SSM parameters

All infrastructure IDs live in SSM under `/trellis/{stage}/`:

```bash
aws ssm get-parameters-by-path \
  --path /trellis/dev/ \
  --query "Parameters[*].{Name:Name,Value:Value}" \
  --output table
```

Key parameters:
- `/trellis/{stage}/alb-dns-name` — ALB endpoint
- `/trellis/{stage}/cloudfront-domain` — public CDN domain
- `/trellis/{stage}/db-secret-arn` — RDS password in Secrets Manager
- `/trellis/{stage}/dynamodb-table-name` — DynamoDB table name

## Incident runbooks

- [High error rate](../02-technical/operations/runbooks/high-error-rate.md)
- [Rollback](../02-technical/operations/runbooks/rollback.md)
- [Database issues](../02-technical/operations/runbooks/database-issues.md)
