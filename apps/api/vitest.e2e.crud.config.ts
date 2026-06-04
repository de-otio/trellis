import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/e2e/entity-crud.test.ts",
      "test/e2e/post-crud.test.ts",
      "test/e2e/comments-crud.test.ts",
      "test/e2e/reactions.test.ts",
      "test/e2e/post-moderation.test.ts",
      "test/e2e/comment-management.test.ts",
      "test/e2e/sentiments-read.test.ts",
    ],
    globalSetup: ["test/e2e/utils/global-setup.ts"],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 1 } },
    fileParallelism: false,
  },
});
