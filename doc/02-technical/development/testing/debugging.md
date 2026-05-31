# Debugging Guide

This guide establishes debugging practices for Trellis. The goal: **find root causes in seconds or minutes, not hours**.

> **Background**: The AWS Well-Architected Framework's [Operational Excellence pillar](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/) emphasizes "make frequent, small, reversible changes" and "improve through game days." Martin Fowler's [Testing Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) and the DORA metrics (from *Accelerate* by Forsgren, Humble, Kim) both show that shifting testing left — catching bugs earlier, closer to the developer — is the single highest-leverage improvement for software delivery.

## The #1 Rule

**Never debug through the deploy pipeline.** A deploy cycle (build + push + CDK + ECS rolling update + Fargate cold start) takes 8-12 minutes. If you're iterating through that loop, you've already lost.

This is consistent with AWS's own guidance in the [ECS Best Practices Guide](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/): test locally, validate with `cdk diff`, and only deploy once you've verified your fix.

## Debugging Tiers

Work through these tiers in order. Only escalate to the next tier when the current one cannot reproduce or explain the problem. This follows the [Testing Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html): many fast local checks, few slow remote checks.

### Tier 1: Local Unit Test (~2 seconds)

Write or run a unit test that isolates the failing code path. This catches the vast majority of bugs.

```bash
# Run a single test file
npx vitest run test/unit/routes/health.test.ts

# Run a single test by name
npx vitest run -t "should generate CSRF token"
```

**Example**: If `/api/roles/metadata` returns 500, don't curl the deployed API. Instead:
1. Read the route handler to find what it does (Prisma query, env vars, etc.)
2. Check the unit test for that route
3. If the test passes, the handler logic is fine — the bug is in environment/infra

**When this tier is sufficient**: Logic bugs, missing validation, incorrect response codes, broken route matching.

### Tier 2: Local Integration Script (~5-15 seconds)

For bugs that involve runtime behavior (crypto, database connections, SDK calls), write a throwaway Node script that exercises the exact code path. AWS [recommends testing containerized apps locally](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/test-containerized-applications-locally.html) before deploying to ECS.

```bash
# Build first — test against compiled output, not TypeScript source
npm run build -w @de-otio/trellis

# Test session encrypt/decrypt round-trip
node -e "
const {SessionManager} = require('./apps/api/dist/lib/session-manager.js');
const sm = new SessionManager();
const data = JSON.stringify({userId:'test', expiresAt:Date.now()+3600000});
sm.encryptSession(data, 'secret-32-chars-minimum-length!!', 'salt-value')
  .then(token => sm.decryptSession(token, 'secret-32-chars-minimum-length!!', 'salt-value'))
  .then(result => console.log('OK:', JSON.parse(result).userId))
  .catch(e => console.error('FAIL:', e.message));
"
```

```bash
# Test Prisma query locally (requires DATABASE_URL)
node -e "
const {PrismaClient} = require('@prisma/client');
const db = new PrismaClient();
db.roleMetadata.findMany({where:{isActive:true}})
  .then(r => console.log('Roles:', r.length))
  .catch(e => console.error('Error:', e.message))
  .finally(() => db.\$disconnect());
"
```

**Key principle**: Always test against the compiled `dist/` output — this is exactly what the deployed container runs.

**When this tier is sufficient**: Crypto mismatches, missing env vars, database schema issues, SDK configuration.

### Tier 3: Static Analysis (~30 seconds)

Before deploying anything, trace the data flow through the code. This is a form of [shift-left testing](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/shift-left-testing.html) — catching wiring bugs by reading rather than running.

**Checklist for "env var not working" bugs**:
1. Is the env var in the CDK stack's `environment` or `secrets`? → `infra/lib/stacks/api-stack.ts`
2. Is it in the `Env` interface? → `apps/api/src/env.ts`
3. Is it copied in `buildEnv()`? → `apps/api/src/env.ts`
4. Is it passed to the function that needs it? → trace the call chain

**Checklist for "CloudFront routing" bugs**:
1. Does the path match a CloudFront behavior? → `infra/lib/stacks/cdn-stack.ts`
2. Does the behavior allow the HTTP method? → check `allowedMethods`
3. Is there a global `errorResponses` rule intercepting the status code?
4. Is the response from S3 (`server: AmazonS3`) or the API? → `curl -sv` headers

**Checklist for "migration not applied" bugs**:
1. Does the table exist? → API logs for "does not exist" errors
2. Is the migration in `_prisma_migrations`? → may be marked as applied without running
3. Does `prisma migrate deploy` have `DATABASE_URL` AND `DIRECT_DATABASE_URL`?

**When this tier is sufficient**: Configuration/wiring bugs, infrastructure mismatches, missing connections between layers.

### Tier 4: Targeted Remote Probe (~30 seconds)

When you need to verify behavior on the deployed environment, use the smallest possible probe. Use [CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html) for log-based debugging and `curl` for endpoint verification.

```bash
# Determine if request hits ALB or S3 (the server header is definitive)
curl -sv https://api.dev.example.com/api/some-endpoint 2>&1 | grep "server:"
# "server: AmazonS3" = CloudFront routing bug (request went to S3 bucket)
# No server header + JSON body = request reached the API

# Tail recent errors (no deploy required)
AWS_PROFILE=dot-dev aws logs tail /trellis/dev/api --since 5m --filter-pattern "ERROR"

# CloudWatch Logs Insights query for structured debugging
aws logs start-query \
  --log-group-name '/trellis/dev/api' \
  --start-time $(date -v-15M +%s) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message
    | filter @message like /SessionManager|getSession|deriveKey/
    | sort @timestamp desc | limit 20'
```

For interactive debugging on a running container, use [ECS Exec](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html):

```bash
# Get a shell on the running API container
TASK_ID=$(aws ecs list-tasks --cluster trellis-dev --service-name trellis-dev-api \
  --query "taskArns[0]" --output text | awk -F/ '{print $NF}')
aws ecs execute-command \
  --cluster trellis-dev \
  --task $TASK_ID \
  --container api \
  --interactive \
  --command /bin/sh
```

Inside the container, you can:
- Check env vars: `echo $SESSION_SALT`
- Test Prisma: `npx prisma migrate status`
- Run a quick query: `node -e "require('./dist/...').someFunction()"`

**When this tier is sufficient**: Verifying a specific hypothesis about the deployed environment.

### Tier 5: Deploy (~10-12 minutes)

Only deploy when:
- You have a specific fix validated by Tiers 1-4
- You have **batched all known fixes** into a single deploy
- You are not guessing

## Anti-Patterns

### 1. The "deploy and pray" loop

```
make change → deploy (10 min) → test → fails → make another change → deploy (10 min) → ...
```

**Why it's fatal**: 6 iterations = 1 hour of dead time. Each iteration teaches you almost nothing because the feedback is too slow and too coarse.

**Fix**: Validate locally first. A 2-second unit test or a 5-second Node script answers the same question. Deploy once with all fixes batched.

### 2. Ad-hoc SQL through ECS task overrides

Running SQL by constructing JSON command overrides with nested shell/JSON escaping is fragile (quoting breaks), slow (60s Fargate cold start), and unauditable.

**Fix**:
- **For schema changes**: Create a Prisma migration — proper, auditable, idempotent
- **For one-off queries**: Use ECS Exec to get a shell, then run `node -e` or install `psql`
- **For seed data**: Include it in the migration SQL with `INSERT ... ON CONFLICT`

### 3. Debugging crypto through CloudWatch

Session encrypt/decrypt involves `crypto.subtle`, PBKDF2 key derivation, and base64 encoding. Debugging this through deploy → curl → CloudWatch is a 15-minute loop per hypothesis.

**Fix**: Test the round-trip locally with real secrets from SSM:
```bash
export SESSION_SECRET=$(AWS_PROFILE=dot-dev aws ssm get-parameter \
  --name /trellis/dev/session/secret --with-decryption --query Parameter.Value --output text)
export SESSION_SALT=$(AWS_PROFILE=dot-dev aws ssm get-parameter \
  --name /trellis/dev/session/salt --with-decryption --query Parameter.Value --output text)

npm run build -w @de-otio/trellis  # Always test compiled output!

node -e "
const {SessionManager} = require('./apps/api/dist/lib/session-manager.js');
const sm = new SessionManager();
const data = JSON.stringify({userId:'test',expiresAt:Date.now()+3600000,dataRegion:'EU',sessionType:'user',lastActivityAt:Date.now(),profileContext:'primary'});
sm.encryptSession(data, process.env.SESSION_SECRET, process.env.SESSION_SALT)
  .then(token => sm.decryptSession(token, process.env.SESSION_SECRET, process.env.SESSION_SALT))
  .then(r => console.log('Round-trip OK'))
  .catch(e => console.error('FAILED:', e.message));
"
```

### 4. Ignoring the `Env` interface

If a route handler reads `env.SOME_VAR` and `SOME_VAR` isn't in the `Env` interface or `buildEnv()`, it will always be `undefined` — even if `process.env.SOME_VAR` is set. This is by design: the `Env` object is the application's configuration boundary.

**Checklist when adding a new env var**:
1. Add to SSM (SecureString) or CDK stack `environment`/`secrets`
2. Add to `Env` interface in `apps/api/src/env.ts`
3. Add to `buildEnv()` in `apps/api/src/env.ts`
4. Add to unit test mocks (`mockEnv`)

Missing any step means the var silently doesn't work.

## Quick Reference

| Symptom | First check | NOT this |
|---------|------------|----------|
| API returns S3 XML | CloudFront behavior routing (`cdn-stack.ts`) | Deploy a fix and re-test |
| API returns 500 | `aws logs tail` + unit test for the handler | Curl in a loop |
| API returns 401 | Trace `getSession` call — is `env` passed? Is salt in `buildEnv()`? | Deploy with debug logging |
| Migration fails | Check `DIRECT_DATABASE_URL` is set; check Prisma schema validation | Re-run and hope |
| Env var undefined | Check `Env` interface + `buildEnv()` + CDK stack | Add it to CDK and redeploy |
| e2e test times out | Check API_URL — internal ALB or public CloudFront domain? | Increase timeout |
| Session cookie rejected | Local encrypt/decrypt round-trip with real SSM secrets | Deploy and check logs |

## Post-Deploy Test Configuration

The post-deploy test script (`scripts/post-deploy-test.sh`) exports session secrets so authenticated e2e tests can create valid session cookies:

```bash
# These are exported by the script automatically
export SESSION_SECRET=$(aws ssm get-parameter --name "/trellis/${STAGE}/session/secret" ...)
export SESSION_SALT=$(aws ssm get-parameter --name "/trellis/${STAGE}/session/salt" ...)
```

If e2e tests fail with `SESSION_SALT environment variable is required`, check that the script exports these before running tests.

## Further Reading

- [AWS Well-Architected: Operational Excellence](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/) — especially OPS 6 (deployment risk) and OPS 8 (workload health)
- [AWS ECS Best Practices Guide](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/)
- [ECS Exec documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html)
- [CloudWatch Logs Insights syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)
- [Testing Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) — Martin Fowler
- [Shift-left testing](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/shift-left-testing.html) — AWS DevOps Guidance
- *Accelerate* (Forsgren, Humble, Kim) — DORA metrics linking testing practices to delivery performance
