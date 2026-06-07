# E2E Tests

E2E tests run against a **running API** and verify the full request path. In
the consuming vertical's deployed environment that path is
CloudFront → ALB → ECS → RDS; the suites authenticate via Cognito and read
secrets from SSM, so they need that deployed environment and AWS credentials.

To run the same request path **without any deployed environment or AWS
account** — against a locally-booted server with a generic dummy extension —
use the standalone lane in [standalone.md](standalone.md). This page describes
the **deployed-target** mode.

## Running

```bash
# Against dev
eval "$(AWS_PROFILE=dot-dev aws configure export-credentials --format env)"
API_URL=https://api.dev.example.com npm run test:e2e

# Single file
API_URL=https://api.dev.example.com npx vitest run --config vitest.e2e.config.ts test/e2e/smoke.test.ts
```

## Configuration (`apps/api/vitest.e2e.config.ts`)

- Single thread (`fileParallelism: false`) — prevents Cognito rate limiting and DB connection-pool exhaustion against a single Fargate task
- Target resolved by `TestConfig` (`test/utils/test-config.ts`) from a `config.yaml` keyed on `TEST_ENV` (override with `API_URL`)
- Setup (`test/e2e/setup.ts`): health check on `GET /health` at startup, aborts if the API is unreachable
- The API listens on port `3000`

## Test User

The e2e tests authenticate via Cognito. Credentials are in SSM:

| SSM Parameter | Description |
|---------------|-------------|
| `/trellis/dev/test/user-email` | Test user email |
| `/trellis/dev/test/user-password` | Test user password |

Override with env vars: `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`

The test user is `e2e_test_user` in the Cognito User Pool.

## Prod Safety

Tests that modify data are gated with `describe.skipIf(isProduction())`. Tests that only read (smoke, health) run in all environments.

- `isProduction()` — returns true if API_URL contains `api.example.com` (no `dev.` prefix)
- `requireDevEnvironment()` — throws if running against prod

## Test Files

| File | Prod-safe? | What it tests |
|------|------------|---------------|
| `smoke.test.ts` | Yes | Health, 404, CORS, security headers, auth gating |
| `auth-flow.test.ts` | Partial | Token validation (safe), session endpoints (dev-only) |
| `entity-crud.test.ts` | No | Create/read/update entities |
| `post-crud.test.ts` | No | Create/read posts |
| `comments-crud.test.ts` | No | Create comments on posts |
| `reactions.test.ts` | No | Add/remove reactions |
| `media-upload.test.ts` | No | Upload images |
| `access-control.test.ts` | Partial | Unauthenticated access (safe), authenticated (dev-only) |
| `gdpr.test.ts` | No | Data export request |
| `magic-link-auth.test.ts` | No | Full magic link flow with maildummy |
