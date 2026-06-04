import { defineConfig } from "vitest/config";

/**
 * CI integration lane — Surveillance-hardening Phase 0.
 *
 * The broad `test:integration` config pulls in pre-existing integration tests
 * that need live infrastructure beyond a Postgres container (media pipeline, a
 * running API, Entra). Turning that whole suite on in CI would be flaky. This
 * config instead runs ONLY the curated, Postgres-only integration tests this
 * plan adds — so P2/P4's DB integration tests actually gate merges without
 * dragging in the infra-heavy legacy suites.
 *
 * Each stage appends its integration test file(s) to PHASE0_INTEGRATION below.
 * `passWithNoTests` keeps the lane green until the first stage populates it.
 */

const PHASE0_INTEGRATION = [
  // P2 — interaction event capture
  //   "test/integration/interaction-events.integration.test.ts",
  // P4 — report model adoption
  //   "test/integration/report-migration.integration.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: PHASE0_INTEGRATION,
    passWithNoTests: true,
    setupFiles: ["test/setup.ts"],
    globalTeardown: "test/teardown.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Single thread — integration tests share the local Postgres container.
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
