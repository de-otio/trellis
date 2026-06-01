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
      "test/integration/example-authenticated.test.ts",
      "test/integration/feed-media-e2e.integration.test.ts",
      "test/integration/media-handler.integration.test.ts",
      "test/integration/media-id-mapping.test.ts",
      // Exclude Neo4j graph integration tests — require a live local Neo4j instance
      // Run separately: npm run test:graph -w @de-otio/trellis
      "test/integration/graph/**/*.test.ts",
      // Exclude schema-shape integration tests — require a live local Postgres with migrations applied.
      // Run separately: npm test -w @de-otio/trellis -- run test/integration/schema (with DATABASE_URL set)
      "test/integration/schema/**/*.test.ts",
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
        branches: 80,
        statements: 80,
        autoUpdate: false,
      },
      reportOnFailure: true,
    },
  },
});
