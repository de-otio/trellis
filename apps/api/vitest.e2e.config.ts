import { defineConfig } from "vitest/config";

// When running all tests via `npm run test:e2e`, create 2 users (enough for
// cross-user tests). Shard-specific configs override this via env vars.
process.env.E2E_SHARD = process.env.E2E_SHARD || "all";
process.env.E2E_USER_COUNT = process.env.E2E_USER_COUNT || "2";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    globalSetup: ["test/e2e/utils/global-setup.ts"],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // Sequential execution — the API runs on a single Fargate task with a small
    // connection pool. Even 2 parallel test files cause 500s from pool exhaustion.
    // Parallelism should happen at the CI level (separate GitHub Actions jobs),
    // not within a single vitest process. See doc/02-technical/development/testing/post-deploy-speed.md.
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 1,
      },
    },
    fileParallelism: false,
  },
});
