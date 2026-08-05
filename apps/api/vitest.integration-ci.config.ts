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
  // T4 — text-moderation fail-closed: flagged/unverifiable post text is not
  // persisted (and therefore never served). Postgres-only, setup-free.
  "test/integration/text-moderation-fail-closed.integration.test.ts",
  // P0 — post create/edit must write the real `radius` column (no phantom
  // `visibility` column); pins the legacy visibility→radius mapping and the
  // public-posting gate on radius=SHOUT.
  "test/integration/post-create-radius.integration.test.ts",
  // R1 — Events primitive: RSVP capacity/waitlist under real Postgres, incl.
  // the N-parallel-RSVP concurrency proof of no-over-capacity (§4.3, §7).
  "test/integration/events.integration.test.ts",
  // R1 — Events primitive: CRUD lifecycle, visibility matrix, notifications,
  // cancellation, quota, authorization, and shift/RSVP status semantics
  // complement to events.integration.test.ts's concurrency proofs.
  "test/integration/events-lifecycle.integration.test.ts",
  // P0 — post READ isolation: tenant boundary (V2), the audience predicate on
  // the single-post path (V3), and mutual-consent friend resolution (V1), as
  // outcome assertions. The unit lane mocks post.findMany and returns canned
  // rows regardless of the `where`, so it can only assert predicate shape —
  // only a real Postgres decides whether a row actually comes back.
  "test/integration/post-read-isolation.integration.test.ts",
  // P1.1a — the audience_class DB invariant: the denormalised class is a
  // faithful function of audience_scopes, enforced by trigger. A stale class
  // is a disclosure (the feed index selects on it), and the write path cannot
  // be trusted to maintain it, so the assertion belongs against the database.
  "test/integration/audience-class-invariant.integration.test.ts",
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
