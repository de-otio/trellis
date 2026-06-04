import { defineConfig } from "vitest/config";

/**
 * Postdeployment shard: Followers tests (follow, unfollow, count, status, lists, auth, index)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/integration/postdeployment/followers/**/*.test.ts",
    ],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
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
