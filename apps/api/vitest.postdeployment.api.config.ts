import { defineConfig } from "vitest/config";

/**
 * Postdeployment shard: API tests (entities, feed, reactions, posts, media, toggles, etc.)
 * Excludes followers/ subdirectory — those run in the followers shard.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/integration/postdeployment/*.test.ts",
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
