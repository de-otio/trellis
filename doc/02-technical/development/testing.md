# Testing

## Philosophy

This project is maintained by a single developer. The test suite is the second pair of eyes
on every change. It must be comprehensive enough to deploy confidently at any time.

**Core principle: test at the earliest layer that can detect the bug.**

```
Layer 0: tsc --noEmit           (~5s)   compile-time type errors
Layer 1: vitest unit            (~30s)  logic, handlers, services, mocks
Layer 2: vitest integration     (~60s)  real DB, DynamoDB, S3 (Docker Compose)
Layer 3: vitest e2e             (~90s)  deployed API, CloudFront → ALB → ECS → RDS
Layer 4: post-deployment        (~120s) live AWS resources, data integrity
```

Every PR runs layers 0-2. Layers 3-4 run automatically after every deploy. No deployment
proceeds if any layer fails.

## Quick Reference

| Type | Config | Command | When |
|------|--------|---------|------|
| Unit | `apps/api/vitest.config.ts` | `npm test` | Every change |
| Integration | `apps/api/vitest.integration.config.ts` | `npm run test:integration` | Pre-deploy (needs Docker Compose) |
| E2E | `apps/api/vitest.e2e.config.ts` | `npm run test:e2e` | Post-deploy |
| Post-deployment | `apps/api/vitest.postdeployment.config.ts` | `npm run test:postdeployment` | Post-deploy |
| Infrastructure | `infra/vitest.config.ts` | `npm test -w @de-otio/trellis-infra` | Every infra change |
| Crypto | `packages/crypto/vitest.config.ts` | `npm test -w` | Every crypto change |
| Flutter | `apps/flutter/` | `cd apps/flutter && flutter test` | Every Flutter change |

## Detailed Guides

- [Unit & Integration Tests](testing/unit.md) — writing tests, mocking, test factories
- [E2E Tests](testing/e2e.md) — running against deployed environments, auth, prod safety
- [Coverage](testing/coverage.md) — thresholds, reports, improving coverage
- [Magic Link Tests (Maildummy)](testing/maildummy.md) — email capture system for auth testing
- [Strategy](testing/strategy.md) — what to test, coverage gaps, security-sensitive paths
- [CI/CD Integration](testing/ci-cd.md) — how tests gate deployments

## What Must Be Tested

### Non-negotiable (security-sensitive paths)

Every module in these categories must have unit tests covering the happy path, error path,
and at least one edge case:

- **Authentication** — Cognito triggers, JWT validation, session management, CSRF
- **MFA** — TOTP enrollment, verification, recovery codes
- **Encryption** — key management, encrypt/decrypt roundtrips, voting crypto
- **Authorization** — role checks, ownership validation, feature flag gating
- **Data deletion** — GDPR export, account deletion, media cleanup

### Required for all handlers

| Test case | Why |
|-----------|-----|
| Happy path (valid input, authenticated) | Confirms the feature works |
| Auth rejection (no session, wrong role) | Prevents unauthorized access |
| Validation errors (missing fields, bad types) | Prevents data corruption |
| Database error | Verifies error handling, not silent failures |
| Rate limit enforcement | Prevents abuse |
| Feature toggle gating | Ensures disabled features stay disabled |

### Required for all Lambda functions

| Test case | Why |
|-----------|-----|
| Happy path — returns expected output | Confirms the function works |
| Missing/malformed input — throws | Prevents silent failures |
| AWS SDK failure — throws (allows retry) | Network errors must propagate |
| Idempotency — duplicate invocation is safe | Lambda can invoke twice |

### Required for all routes

| Test case | Why |
|-----------|-----|
| Route is registered with correct path/method | Prevents silent 404s |
| Unauthenticated request returns 401 | Prevents auth bypass |
| Security headers are present | Prevents header stripping |
| CORS and CSRF middleware attached | Prevents cross-origin attacks |

## Test Architecture

```
apps/api/test/
  ├── unit/                         # Mocked dependencies, fast (<10s per suite)
  │   ├── lambda/                   # Lambda function tests
  │   ├── routes/                   # Route registration tests
  │   ├── mfa/                      # MFA handler + TOTP service
  │   ├── metadata/                 # Metadata extraction + validation
  │   ├── crypto/voting/            # Encryption scheme tests
  │   ├── activitypub/              # Federation protocol tests
  │   └── ...                       # Handler + service tests
  ├── integration/                  # Real DB/DynamoDB/S3 (Docker Compose)
  │   ├── predeployment/            # Run before deploy
  │   └── postdeployment/           # Run after deploy (live infra)
  ├── e2e/                          # Full request path (deployed API)
  ├── utils/                        # Shared test utilities
  └── factories/                    # Test data factories
```

## Memory and Performance

- Max 2 vitest worker threads — each can consume 4GB+ RAM with Prisma
- Single thread for E2E — prevents Cognito rate limiting
- **Never run tests in the background** — RAM will spike and OOM
- Test timeout: 10s (unit), 30s (integration/e2e/hooks)

## Coverage Thresholds

All metrics enforced at **80%** across all workspaces:

```
lines: 80, functions: 80, branches: 80, statements: 80
```

Coverage must never decrease. See [Coverage](testing/coverage.md) for details.
