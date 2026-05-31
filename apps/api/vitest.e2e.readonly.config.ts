import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/e2e/taxonomy.test.ts",
      "test/e2e/content-discovery.test.ts",
      "test/e2e/taxonomy-tagging.test.ts",
      "test/e2e/badges.test.ts",
      "test/e2e/admin-access.test.ts",
      "test/e2e/role-metadata.test.ts",
      "test/e2e/invitations.test.ts",
      "test/e2e/link-reports.test.ts",
      "test/e2e/agents.test.ts",
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
