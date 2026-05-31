import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/e2e/magic-link-auth.test.ts",
      "test/e2e/auth-flow.test.ts",
      "test/e2e/mfa.test.ts",
      "test/e2e/account-deletion.test.ts",
      "test/e2e/gdpr.test.ts",
      "test/e2e/access-control.test.ts",
    ],
    globalSetup: ["test/e2e/utils/global-setup.ts"],
    setupFiles: ["test/e2e/setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 1 } },
    fileParallelism: false,
  },
});
