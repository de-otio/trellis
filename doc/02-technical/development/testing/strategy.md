# Testing Strategy

## Guiding Principles

1. **Test at the earliest possible layer** — a unit test that catches a bug in 2 seconds is worth more than an e2e test that catches it in 90 seconds, which is worth more than a deploy failure that catches it in 15 minutes
2. **Every security-sensitive path must have tests** — auth, MFA, encryption, session management, data deletion
3. **CI must block deploys** — no code reaches production without passing tests
4. **Post-deployment verification is automated** — never "run this manually after deploy"
5. **Tests are the second pair of eyes** — for a solo developer, if it's not tested, it's not safe to ship

## Coverage Requirements by Module Type

### Tier 1: Security-Critical (must exceed 90% branch coverage)

These modules handle authentication, authorization, encryption, or data deletion.
A bug here can compromise user data or break the auth flow entirely.

| Module | Location | What to test |
|--------|----------|--------------|
| Cognito Lambda triggers | `src/lambda/create-auth-challenge.ts`, `verify-auth-challenge.ts`, etc. | Event shape, DynamoDB storage, TTL, idempotency |
| Session management | `src/lib/session-manager.ts` | Creation, validation, expiry, tampering |
| CSRF protection | `src/lib/csrf.ts` | Token generation, validation, rejection |
| MFA (TOTP) | `src/lib/mfa/` | Secret generation, verification window, replay rejection, recovery codes |
| Encryption services | `src/lib/encryption-key-service.ts`, `packages/crypto/` | Roundtrip, key rotation, wrong-key rejection |
| User deletion | `src/lib/user-deletion-handler*.ts` | Full deletion flow, partial failure, GDPR compliance |
| Security headers | `src/lib/security-headers.ts` | All headers present, no header stripping |

### Tier 2: Core Business Logic (must meet 80% threshold)

These modules implement the primary user-facing features.

| Module | Location |
|--------|----------|
| All handler classes | `src/lib/*-handler.ts` |
| All route files | `src/lib/routes/*.ts` |
| Feed personalization | `src/lib/feed-personalization.ts` |
| Media processing | `src/lib/services/`, `src/lib/media-*` |
| Relationships (follows/connections) | `src/lib/*relationship*`, `src/lib/*circle*` — graph-backed (Neo4j) relationship handlers |

### Tier 3: Infrastructure and Utilities (must meet 80% threshold)

| Module | Location |
|--------|----------|
| CDK stacks | `infra/lib/stacks/*.ts` |
| Database utilities | `src/lib/database-*.ts` |
| KV/Storage/Queue adapters | `src/lib/kv/`, `src/lib/storage/`, `src/lib/queue/` |
| Feature flags | `src/lib/feature-flags.ts`, `src/lib/feature-toggle-service.ts` |

### Tier 4: ActivityPub (test when feature is enabled)

ActivityPub is behind a feature flag. Tests exist but only matter when `features.activityPub` is enabled.

## Known Coverage Gaps

These are areas identified as needing test coverage. When addressing them, follow
the priority order below.

### P0 — Blocks safe deployment

| Gap | Impact |
|-----|--------|
| Lambda Cognito triggers (7 functions, 0 tests) | Auth flow can break silently |
| MFA module (2 files, 0 tests) | Security feature with no safety net |
| Missing vitest configs (`integration`, `postdeployment`) | Test scripts are broken |
| CI disconnected from deploy pipeline | Code can deploy without tests passing |

### P1 — Significant risk

| Gap | Impact |
|-----|--------|
| Lambda workers (3 functions, 0 tests) | Data cleanup and media processing untested |
| 4 route files with no tests | Endpoints could silently break |
| 18 of 29 E2E test files excluded | Only 38% of E2E coverage is active |
| Deploy smoke test is a single `curl` | Post-deploy validation is minimal |

### P2 — Moderate risk

| Gap | Impact |
|-----|--------|
| Metadata services (5 of 6 untested) | Metadata extraction could silently fail |
| Crypto voting (3 of 6 untested) | Encryption schemes untested |
| Scheduled tasks (`media-stale-cleanup`) | Cleanup could silently stop working |
| `MediaMetadataExtractor`, `MediaMetrics` | No dedicated unit tests |

## Mock Strategy

### AWS SDK

All Lambda and service tests mock AWS SDK clients at module level using `vi.hoisted()`:

```typescript
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockSend })),
  PutItemCommand: vi.fn(),
  GetItemCommand: vi.fn(),
}));
```

### Prisma

Mock `createPrisma` with a mock object containing the models under test:

```typescript
const mockPrisma = {
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  post: { findMany: vi.fn(), create: vi.fn() },
};
vi.mock("../../src/db", () => ({ createPrisma: vi.fn(() => mockPrisma) }));
```

### Environment

Use the shared `mock-env.ts` utility for environment variable mocking. Always set
`DATABASE_URL`, `SESSION_SECRET`, and `STAGE` at minimum.

## Infinite Loop Prevention

Per CLAUDE.md, any code that involves pagination, polling, retries, or recurring operations
must include tests for the degenerate case:

1. Test with a maximum iteration count
2. Test with a circuit breaker
3. Test the case where the API returns success but no data
4. Never call async methods from `build()` without a guard

This applies to: `media-stale-cleanup.ts`, `cleanup-cron.ts`, any reconciliation or
polling service.
