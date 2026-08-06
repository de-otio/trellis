import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [
      "test/e2e/**/*.test.ts", // Exclude E2E tests - they should only run post-deployment
      // Exclude the standalone lane — it boots a real server via its own
      // globalSetup (vitest.standalone.config.ts). Under this default config
      // there is no server, so the suites would fetch and fail.
      // Run separately: npm run test:standalone -w @de-otio/trellis
      "test/standalone/**/*.test.ts",
      "test/integration/postdeployment/**/*.test.ts", // Exclude postdeployment tests - they require deployed infrastructure
      // Exclude integration tests that require live infrastructure (DB + running API)
      "test/integration/encryption-key-service.integration.test.ts",
      // encrypted-settings needs a real DATABASE_URL (this config's test/setup.ts
      // overrides it to a fake hyperdrive URL) — runs in the Phase0 integration
      // lane instead (vitest.integration-ci.config.ts / test:integration:ci).
      "test/integration/encrypted-settings.integration.test.ts",
      // T4 text-moderation fail-closed needs a real DATABASE_URL (same reason
      // as encrypted-settings) — runs in the Phase0 integration lane instead.
      "test/integration/text-moderation-fail-closed.integration.test.ts",
      "test/integration/example-authenticated.test.ts",
      "test/integration/feed-media-e2e.integration.test.ts",
      "test/integration/media-handler.integration.test.ts",
      "test/integration/media-id-mapping.test.ts",
      // Exclude graph integration tests — require a live local Postgres instance
      // (the graph runs in the primary Postgres via edge tables + recursive
      // CTEs; there is no separate graph DB).
      // Run separately: npm run test:graph -w @de-otio/trellis
      "test/integration/graph/**/*.test.ts",
      // Exclude schema-shape integration tests — require a live local Postgres with migrations applied.
      // Run separately: npm test -w @de-otio/trellis -- run test/integration/schema (with DATABASE_URL set)
      "test/integration/schema/**/*.test.ts",
      // Surveillance-hardening Phase 0 integration tests — live Postgres only.
      // Run separately: npm run test:integration:ci (CI lane added in P1).
      "test/integration/interaction-events.integration.test.ts",
      "test/integration/report-migration.integration.test.ts",
      // Events primitive integration tests — live Postgres only.
      // Run separately: npm run test:integration:ci (registered in PHASE0_INTEGRATION).
      "test/integration/events.integration.test.ts",
      "test/integration/events-lifecycle.integration.test.ts",
      // O-1 L2 replay-baseline integration test — needs a live local Postgres
      // (ephemeral shadow DBs). Self-skips without the env vars, but excluded
      // here too so the default suite never spawns the prisma CLI.
      "test/integration/extension-schema-baseline.integration.test.ts",
      // P0 radius test needs a real DATABASE_URL (this config's test/setup.ts
      // overrides it to a fake hyperdrive URL, so it falls back to the
      // docker-compose credentials, which don't exist in the CI lint lane) —
      // runs in the Phase0 integration lane instead (registered there).
      "test/integration/post-create-radius.integration.test.ts",
      // GDPR-erasure worker e2e needs the full docker-compose stack (Postgres
      // admin URL + localstack S3 + dynamodb-local) — no CI lane provides
      // localstack, so this is a LOCAL-ONLY suite. Run it with
      // `docker compose up` and the default suite's test:integration script.
      "test/integration/gdpr-erasure-worker.integration.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    globalTeardown: "test/teardown.ts",
    testTimeout: 10000, // 10 seconds for integration tests
    hookTimeout: 30000, // 30 seconds for hooks (beforeEach, afterEach)
    // Limit workers to reduce memory usage (each worker can use 4GB+ with Prisma).
    // poolOptions.threads.{min,max}Threads moved to top-level in vitest 4.
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 78,
        statements: 80,
        autoUpdate: false,
      },
      reportOnFailure: true,
    },
  },
});
