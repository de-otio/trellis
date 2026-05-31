# CI/CD Test Integration

## Pipeline Architecture

Tests gate every path to production. No code reaches AWS without passing.

```
Push to dev / PR ──► CI Workflow ──► Unit + Integration + Infra tests
                                          │
                                          ▼ (must pass)
                     Deploy Workflow ──► API tests ──► Infra tests
                                          │               │
                                          ▼ (both pass)   │
                                        Deploy ◄──────────┘
                                          │
                                          ▼
                                   E2E smoke tests
                                          │
                                          ▼
                                 Post-deployment tests
                                          │
                                          ▼ (fail = alert + rollback guidance)
                                        Done
```

## CI Workflow (`.github/workflows/ci.yml`)

Triggers on push to `dev` and PRs targeting `dev`.

### Jobs

**test-infra** — CDK infrastructure tests:
- `tsc --noEmit` (infra workspace)
- `npm test -w @de-otio/trellis-infra` (template assertions, Cedar policy tests)

**lint-and-test** — API and crypto tests:
- Services: PostgreSQL 16 + DynamoDB Local
- Prisma generate + migrate
- `npm run lint -w @de-otio/trellis`
- `npm test -w @de-otio/trellis` (unit + integration)
- `npm test -w`

**build-docker** — Docker image build (only on `dev`/`main` push):
- Build ARM64 image
- Push to ECR
- ECR vulnerability scan (fails on CRITICAL findings)

## Deploy Workflow (`.github/workflows/deploy.yml`)

Triggers on `workflow_dispatch` with stage selection.

### Pre-deploy gates

Both must pass before deploy begins:

| Gate | What runs |
|------|-----------|
| `test-infra` | CDK TypeScript check + infrastructure tests |
| `test-api` | Unit tests, integration tests, crypto tests |

### Post-deploy verification

Runs after ECS service stabilizes:

| Phase | Config | What it verifies |
|-------|--------|-----------------|
| Smoke (E2E) | `vitest.e2e.config.ts` | Health, security headers, CORS, auth gating, basic CRUD |
| Post-deployment | `vitest.postdeployment.config.ts` | Database schema, feature toggles, data integrity, followers, media |

### On post-deploy failure

Post-deployment test failure:
1. Logs the failure details
2. Prints the rollback command (`aws ecs update-service --force-new-deployment`)
3. Fails the workflow

## Convenience Scripts

```bash
# Run post-deploy tests locally against a deployed environment
bash scripts/post-deploy-test.sh dev

# Runs in two phases:
# 1. E2E smoke tests (read-only, safe for any environment)
# 2. Post-deployment validation (may write test data, dev only)
```

## Test Configs by Runner

| npm script | Vitest config | What it includes |
|------------|---------------|-----------------|
| `test` | `vitest.config.ts` | Unit + pre-deploy integration (excludes e2e, postdeployment) |
| `test:integration` | `vitest.integration.config.ts` | Pre-deployment integration only (needs Docker Compose) |
| `test:e2e` | `vitest.e2e.config.ts` | E2E tests against deployed API |
| `test:postdeployment` | `vitest.postdeployment.config.ts` | Post-deployment tests against deployed infra |
| `test:agents` | `vitest.agents.config.ts` | Bedrock AgentCore smoke tests |
| `test:coverage` | `vitest.config.ts` + coverage | Unit + integration with coverage report |

## Environment Variables for Test Runners

### Unit / Integration (CI or local)

| Variable | Source | Required |
|----------|--------|----------|
| `DATABASE_URL` | Docker Compose or CI service | Yes |
| `DYNAMODB_ENDPOINT` | Docker Compose or CI service | Yes |
| `DYNAMODB_TABLE` | Hardcoded (`test-trellis`) | Yes |
| `SESSION_SECRET` | Test constant or CI secret | Yes |
| `STAGE` | `test` | Yes |
| `NODE_ENV` | `test` | Yes |

### E2E / Post-deployment (against deployed environment)

| Variable | Source | Required |
|----------|--------|----------|
| `API_URL` | SSM (`/trellis/{stage}/alb-dns-name`) or manual | Yes |
| `STAGE` | `dev` or `prod` | Yes |
| `AWS_REGION` | AWS config | Yes |
| `TEST_USER_EMAIL` | SSM (`/trellis/{stage}/test/user-email`) or manual | For auth tests |
| `TEST_USER_PASSWORD` | SSM (`/trellis/{stage}/test/user-password`) or manual | For auth tests |

## Production Safety

E2E tests that modify data are gated:

- `isProduction()` — returns true if `API_URL` contains `api.example.com` (no `dev.` prefix)
- `requireDevEnvironment()` — throws if running against prod
- Tests use `describe.skipIf(isProduction())` for write operations
- Read-only tests (smoke, health) run in all environments
