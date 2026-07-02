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
  "test/integration/interaction-events.integration.test.ts",
  // P4 — report model adoption
  "test/integration/report-migration.integration.test.ts",
  // Encrypted-settings CAS + If-None-Match/304 — needs a real DATABASE_URL,
  // which vitest.config.ts's test/setup.ts overrides to a fake hyperdrive URL.
  "test/integration/encrypted-settings.integration.test.ts",
];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: PHASE0_INTEGRATION,
    passWithNoTests: true,
    // NO test/setup.ts: it force-overrides DATABASE_URL to a fake hyperdrive
    // URL (for the mocked unit suite). These Phase-0 integration tests connect
    // to a REAL Postgres via the explicit DATABASE_URL — same approach as the
    // schema lane (vitest.schema.config.ts), which also runs setup-free.
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Single thread — integration tests share the local Postgres container.
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
