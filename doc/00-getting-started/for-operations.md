# Operations Guide

> **Status — target operational model, not runnable from this repo.**
> Trellis ships as an npm library and is **not deployed standalone** (see
> `README.md` / `CLAUDE.md`, "Deployment Status"). The standalone deployment
> and operations tooling this guide refers to — an `infra/` CDK app,
> `scripts/deploy.sh`, and `scripts/ops/*` helpers — is **not part of this
> repository**; deployment and live operations are owned by the consuming
> application that embeds Trellis. The conventions below describe the **target**
> model so a consuming application can implement them consistently.

## Deploying (target model)

This repo has no `infra/` workspace. A consuming application deploys its own CDK
app — conventionally stateful stacks first, then stateless:

```bash
# In the consuming application's infrastructure project:
npx cdk deploy "<app>-<stage>-Network" "<app>-<stage>-Data" "<app>-<stage>-Storage" "<app>-<stage>-Auth"
npx cdk deploy "<app>-<stage>-Api" "<app>-<stage>-Workers" "<app>-<stage>-Cdn" "<app>-<stage>-Monitoring"
```

## Monitoring (target conventions)

- **CloudWatch dashboard**: `{app}-{stage}`
- **Alarms**: filter `{app}-{stage}`
- **Traces**: CloudWatch → X-Ray → Service Map
- **DLQ alerts**: SNS topic `{app}-{stage}-alerts` sends email on DLQ activity

## SSM parameters (target layout)

Trellis resolves infrastructure IDs from SSM under `/{app}/{stage}/` (see
`apps/api/src/env.ts`):

```bash
aws ssm get-parameters-by-path \
  --path /{app}/{stage}/ \
  --query "Parameters[*].{Name:Name,Value:Value}" \
  --output table
```

Key parameters:
- `/{app}/{stage}/alb-dns-name` — ALB endpoint
- `/{app}/{stage}/cloudfront-domain` — public CDN domain
- `/{app}/{stage}/db-secret-arn` — RDS password in Secrets Manager
- `/{app}/{stage}/dynamodb-table-name` — DynamoDB table name

## Incident runbooks

Target-model troubleshooting references (same not-runnable-from-this-repo caveat
applies):

- [High error rate](../02-technical/operations/runbooks/high-error-rate.md)
- [Rollback](../02-technical/operations/runbooks/rollback.md)
- [Database issues](../02-technical/operations/runbooks/database-issues.md)
