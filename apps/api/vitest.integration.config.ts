import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/integration/*.test.ts",
      "test/integration/*.integration.test.ts",
      "test/integration/predeployment/**/*.test.ts",
    ],
    exclude: [
      "test/integration/postdeployment/**/*.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    globalTeardown: "test/teardown.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Single thread — integration tests share local infrastructure (Postgres + DynamoDB)
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
