# Runbook: High Error Rate

## Symptoms

- CloudWatch alarm `trellis-{stage}-api-error-rate` firing
- ALB 5xx rate > 5% in the last 5 minutes
- Users reporting failures

## Investigation

```bash
# 1. Get a quick picture
STAGE=dev ./scripts/ops/status.sh

# 2. Find which routes are failing
STAGE=dev ./scripts/ops/incident/high-error-rate.sh 30

# 3. Tail live logs
STAGE=dev ./scripts/ops/logs.sh api 10
```

## Common causes

**Bad deploy** — new code introduced a bug:
```bash
STAGE=dev ./scripts/ops/incident/rollback.sh
```

**Database connection pool exhausted** — check RDS connections alarm, restart Fargate:
```bash
aws ecs update-service --cluster trellis-dev --service trellis-dev-api --force-new-deployment
aws ecs wait services-stable --cluster trellis-dev --services trellis-dev-api
```

**DLQ growing** — a Lambda worker is failing. Check which queue:
```bash
STAGE=dev ./scripts/ops/status.sh   # shows DLQ depths
STAGE=dev ./scripts/ops/logs.sh workers 30
```

**External API down** (OpenAI, Google Safe Browsing) — OpenAI budget and circuit breaker handle this gracefully (fail-open). Check logs for the specific error.

## Resolution checklist

- [ ] Identify the failing route / component from logs
- [ ] Determine if it's a new deploy issue (roll back) or infrastructure (restart/scale)
- [ ] Check DLQ depths — redrive if messages accumulated
- [ ] Verify health check passes after fix: `curl http://<ALB_DNS>/health`
- [ ] Write a post-incident note
