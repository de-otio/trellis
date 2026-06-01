# Unit & Integration Tests

## Running

```bash
npm test                                    # all tests
npm test -- apps/api/test/foo.test.ts      # single file
npm run test:watch                          # watch mode
```

**Never run tests in the background.** Each Vitest worker can consume 4GB+ RAM.

## Configuration (`apps/api/vitest.config.ts`)

- Max 2 worker threads (memory control)
- Test timeout: 10s per test, 30s for hooks
- Setup: `test/setup.ts` + `test/teardown.ts`
- Excludes: e2e tests, postdeployment tests, live-infra integration tests

## Test Structure

```
apps/api/test/
  ├── unit/                        # Pure unit tests (mocked deps)
  ├── integration/                 # Integration tests (Docker Compose services)
  │   ├── predeployment/          # Run before deploy (local infra)
  │   └── postdeployment/         # Run after deploy (live infra, excluded from npm test)
  └── e2e/                        # End-to-end tests (separate config)
```

## Integration Tests

Integration tests hit real PostgreSQL (Docker Compose) and DynamoDB Local. They run as part of `npm test` when services are available.

Postdeployment tests (`test/integration/postdeployment/`) require deployed infrastructure and are excluded from `npm test`. Run them separately after deploying.

## Shared Test Utilities

There is no `test/factories/` directory. Shared helpers and fixtures live in:

- `apps/api/test/utils/` — request/response and env helpers, e.g.
  `mock-env.ts` (`createMockEnv()`, `MockKV`), `test-helpers.ts`
  (`createMockRequest()`, `createAuthenticatedRequest()`,
  `assertSecurityHeaders()`, `sleep()`), `test-auth.ts`, plus
  `mock-oauth.ts`, `mock-atproto.ts`, `fedify-test-fixtures.ts`.
- `apps/api/test/_helpers/multi-tenant-fixture.ts` — multi-tenant setup.
- `apps/api/test/fixtures/` — seed data (e.g. `graph-seed.ts`).

Prefer these over hand-rolling mocks. Use `createMockEnv()` for the `Env`
object and the assertion helpers for security/CORS header checks.

## Writing Tests

- Mock all external dependencies (AWS SDK, Prisma, etc.)
- Each test file should be self-contained with its own mocks
- Follow existing patterns — check `test/unit/` for examples
- Test error paths, not just happy paths
