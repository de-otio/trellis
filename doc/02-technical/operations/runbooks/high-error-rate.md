# Runbook: High Error Rate

> **Status — target model, not runnable from this repo.** Trellis is not deployed
> standalone; the `scripts/ops/*` helpers referenced here are **not part of this
> repository** — they belong to the consuming application. The raw AWS CLI
> commands are the target operational shape (`{app}-{stage}` is the consuming
> application's resource prefix).

## Symptoms

- CloudWatch alarm `{app}-{stage}-api-error-rate` firing
- ALB 5xx rate > 5% in the last 5 minutes
- Users reporting failures

## Investigation

The consuming application's ops helpers cover this — a status overview
(`scripts/ops/status.sh`), a failing-route breakdown
(`scripts/ops/incident/high-error-rate.sh`), and live log tailing
(`scripts/ops/logs.sh`). None ship in this repo; use CloudWatch Logs Insights
and the ECS/ALB consoles directly.

## Common causes

**Bad deploy** — new code introduced a bug: roll back to the previous image
(see [rollback.md](./rollback.md)).

**Database connection pool exhausted** — check RDS connections alarm, restart Fargate:
```bash
aws ecs update-service --cluster {app}-{stage} --service {app}-{stage}-api --force-new-deployment
aws ecs wait services-stable --cluster {app}-{stage} --services {app}-{stage}-api
```

**DLQ growing** — a Lambda worker is failing. Check DLQ depths (CloudWatch /
`scripts/ops/status.sh` in the consuming app) and the worker logs.

**External API down** (OpenAI, Google Safe Browsing) — OpenAI budget and circuit breaker handle this gracefully (fail-open). Check logs for the specific error.

## Resolution checklist

- [ ] Identify the failing route / component from logs
- [ ] Determine if it's a new deploy issue (roll back) or infrastructure (restart/scale)
- [ ] Check DLQ depths — redrive if messages accumulated
- [ ] Verify health check passes after fix: `curl http://<ALB_DNS>/health`
- [ ] Write a post-incident note
