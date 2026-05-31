import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/e2e/feed.test.ts",
      "test/e2e/friends-followers.test.ts",
      "test/e2e/user-profile.test.ts",
      "test/e2e/privacy.test.ts",
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
