import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/integration/postdeployment/**/*.test.ts",
    ],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Sequential execution — the API's connection pool cannot handle concurrent test files.
    // Parallelism should happen at the CI level (separate GitHub Actions jobs per shard),
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
