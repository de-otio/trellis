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

## Test Factories (`apps/api/test/factories/`)

- `createUser(overrides?)` — inserts a User with a `cognitoSub`
- `createPost(userId, overrides?)` — inserts a Post
- `createMediaFile(userId, overrides?)` — inserts a MediaFile record

## Writing Tests

- Mock all external dependencies (AWS SDK, Prisma, etc.)
- Each test file should be self-contained with its own mocks
- Follow existing patterns — check `test/unit/` for examples
- Test error paths, not just happy paths
