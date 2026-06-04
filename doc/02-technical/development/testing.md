# Testing

## Philosophy

This project is maintained by a single developer. The test suite is the second pair of eyes
on every change. It must be comprehensive enough to deploy confidently at any time.

**Core principle: test at the earliest layer that can detect the bug.**

```
Layer 0: tsc --noEmit           (~5s)   compile-time type errors
Layer 1: vitest unit            (~30s)  logic, handlers, services, mocks
Layer 2: vitest integration     (~60s)  real DB, DynamoDB, S3 (Docker Compose)
Layer 3: vitest e2e             (~90s)  full request path against a running API
Layer 4: post-deployment        (~120s) live AWS resources, data integrity
```

**Trellis core gates layers 0–2** in [CI](testing/ci-cd.md) (plus a
consumer-install smoke). Trellis is published to npm and does not deploy
itself, so layers 3–4 either run against the **consuming vertical's** deployed
environment (in its pipeline) or against a **local dummy target** so they can
run here without AWS — see [Standalone Testing](testing/standalone.md). Aim to
catch bugs at the lowest layer that can see them.

## Quick Reference

All configs live in `apps/api/`. (This repo has two workspaces — `apps/api`
and `packages/extension-api` — and no `infra/`, `packages/crypto`, or
`apps/flutter`; CDK, crypto-as-a-package, and any mobile client belong to the
consuming vertical, not Trellis core.)

| Type | Config | Command | When |
|------|--------|---------|------|
| Unit + pre-deploy integration | `vitest.config.ts` | `npm test` | Every change (CI gate) |
| Integration only | `vitest.integration.config.ts` | `npm run test:integration` | Needs Docker Compose |
| Graph (Neo4j) | `vitest.graph.config.ts` | `npm run test:graph` | Needs local Neo4j |
| Schema shape | `vitest.schema.config.ts` | `npm run test:schema` | Needs local Postgres |
| E2E (+ shards) | `vitest.e2e*.config.ts` | `npm run test:e2e[:shard]` | Against a running API (deployed or dummy target) |
| Post-deployment (+ shards) | `vitest.postdeployment*.config.ts` | `npm run test:postdeployment[:shard]` | Against deployed infra |
| Agents | `vitest.agents.config.ts` | `npm run test:agents` | Bedrock AgentCore smoke (needs AWS) |

Crypto, MFA, ActivityPub, graph, tenant, and compliance code are unit-tested
in place under `apps/api/test/unit/` (e.g. `test/unit/crypto/`,
`test/unit/mfa/`), not in separate workspaces.

## Detailed Guides

- [Unit & Integration Tests](testing/unit.md) — writing tests, mocking, test factories
- [E2E Tests](testing/e2e.md) — running against deployed environments, auth, prod safety
- [Coverage](testing/coverage.md) — thresholds, reports, improving coverage
- [Magic Link Tests (Maildummy)](testing/maildummy.md) — email capture system for auth testing
- [Strategy](testing/strategy.md) — what to test, coverage gaps, security-sensitive paths
- [Standalone Testing & the Dummy Target](testing/standalone.md) — testing Trellis independently of any consuming vertical, and the generic reference-extension harness
- [Implementation Plan](testing/implementation-plan.md) — sequenced work breakdown to realize this strategy
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

All metrics enforced at **80%** in `apps/api/vitest.config.ts` (the workspace
that holds the testable code):

```
lines: 80, functions: 80, branches: 80, statements: 80
```

Coverage must never decrease. See [Coverage](testing/coverage.md) for details.
