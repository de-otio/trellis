# Testing Strategy

## Guiding Principles

1. **Test at the earliest possible layer** — a unit test that catches a bug in 2 seconds is worth more than an e2e test that catches it in 90 seconds, which is worth more than a deploy failure that catches it in 15 minutes
2. **Every security-sensitive path must have tests** — auth, MFA, encryption, session management, data deletion
3. **CI must block deploys** — no code reaches production without passing tests
4. **Post-deployment verification is automated** — never "run this manually after deploy"
5. **Tests are the second pair of eyes** — for a solo developer, if it's not tested, it's not safe to ship
6. **Trellis must be testable independently** — Trellis is a generic core consumed by a vertical that owns the live AWS environment. As much as possible must be verifiable *in this repo*, against local infrastructure, with no consuming vertical and no AWS account. The most realistic tests should not depend on someone else's deploy cadence.

## Testing Trellis Independently

Trellis is published to npm and consumed by a vertical via `registerExtension()` + `startServer()`; that vertical owns the deployed AWS environment. To keep verification cheap and self-contained, the layers split as follows:

- **Run independently in this repo (CI + local):** type-check / lint, unit, integration (Postgres + DynamoDB-local + LocalStack via `docker-compose`), schema, graph (Postgres — edge tables + recursive CTEs), and the consumer-install smoke (`scripts/smoke-pack.sh`). This is the bulk of the suite and the default expectation for every change.
- **Replace the real consumer with a generic dummy target:** a minimal reference extension fixture (neutral terminology — *not* any real product) that registers through the published API and boots the server against local infrastructure. This exercises the extension contract and the full HTTP request path here, before publish — closing the gap where E2E / post-deployment currently require the consumer's deployed Cognito / SSM / RDS.

The complete design, local-infrastructure map, dummy-target specification, and a phased P0/P1/P2 implementation plan live in **[standalone.md](standalone.md)**. The independence gaps tracked there are distinct from the coverage gaps below.

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
| Encryption services | `src/lib/encryption-key-service.ts`, voting crypto (`test/unit/crypto/`) | Roundtrip, key rotation, wrong-key rejection |
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
| Relationships (follows/connections) | `src/lib/*relationship*`, `src/lib/*circle*` — Postgres graph-backed (edge tables + recursive CTEs) relationship handlers |

### Tier 3: Infrastructure and Utilities (must meet 80% threshold)

| Module | Location |
|--------|----------|
| Database utilities | `src/lib/database-*.ts` |
| KV/Storage/Queue adapters | `src/lib/kv/`, `src/lib/storage/`, `src/lib/queue/` |
| Feature flags | `src/lib/feature-flags.ts`, `src/lib/feature-toggle-service.ts` |

> **CDK stacks are not in this repo.** Trellis ships as an npm package; the
> CDK infrastructure (and its template/policy tests) lives in the consuming
> vertical. The closest infra-shaped surface Trellis owns is the Lambda
> handlers in `src/lambda/` (Tier 1, above) and the published-package contract
> verified by the consumer-install smoke (`scripts/smoke-pack.sh`).
>
> Reusable **CDK construct** unit tests (e.g. `QueueWithDlq`, `SingleTable`,
> `NodejsLambda`, magic-link auth) belong in the house construct packages —
> `@de-otio/saas-foundation-cdk` / `@de-otio/vestibulum-cdk` — not here and not
> hand-rolled per vertical. The full cross-repo test-placement map (core vs
> construct packages vs consuming vertical) lives in the consuming vertical at
> `doc/02-technical/development/testing/test-ownership.md`.

### Tier 4: ActivityPub (test when feature is enabled)

ActivityPub is behind a feature flag. Tests exist but only matter when `features.activityPub` is enabled.

## Known Coverage Gaps

These are areas identified as needing test coverage. When addressing them, follow
the priority order below.

> **Status note (reconciled with the repo).** Several gaps from earlier
> revisions are now closed: Lambda triggers have tests (`test/unit/lambda/`,
> `test/lambda/`), the MFA module has tests (`test/unit/mfa/`), and the
> `integration` / `postdeployment` vitest configs exist. The "CI disconnected
> from deploy pipeline" gap does not apply to this repo — Trellis core has no
> deploy pipeline (it publishes to npm); deploy gating is the consuming
> vertical's concern. The remaining gaps are about **independence** — see
> [standalone.md](standalone.md).

### P0 — Blocks confident release

| Gap | Impact |
|-----|--------|
| No in-repo full-path test (nothing boots a registered extension via HTTP) | Extension-API breakage only surfaces downstream, after publish |
| E2E / post-deployment cannot run without the consumer's deployed AWS | The most realistic tests depend on someone else's environment |

(Both are addressed by the dummy-target plan in [standalone.md](standalone.md).)

### P1 — Significant risk

| Gap | Impact |
|-----|--------|
| Route files without tests | Endpoints could silently break |
| Excluded / inactive E2E files | Some E2E coverage is not exercised |
| Post-deploy validation depth | Smoke coverage should grow with surface area |

### P2 — Moderate risk

Verify current coverage before treating any of these as open (the suite has
grown — `test/unit/metadata/`, `test/unit/crypto/voting/`, and
`test/unit/scheduled/` all exist). Use `npm run test:coverage` to find the
real per-file gaps rather than trusting a fixed list.

| Area | Watch for |
|------|-----------|
| Metadata services (`test/unit/metadata/`) | Extraction paths that fail silently |
| Voting crypto (`test/unit/crypto/voting/`) | Untested encryption schemes |
| Scheduled tasks (`test/unit/scheduled/`, e.g. `media-stale-cleanup`) | Cleanup that could silently stop |
| Media extractor / metrics | Missing dedicated unit tests |

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
