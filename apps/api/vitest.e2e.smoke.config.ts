import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/e2e/smoke.test.ts",
      "test/e2e/auth.test.ts",
      "test/e2e/safe-redirect.test.ts",
      "test/e2e/deployment.test.ts",
    ],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 1 } },
    fileParallelism: false,
  },
});
