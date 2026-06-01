import { defineConfig } from "vitest/config";

/**
 * E2E suites run against the in-process standalone server (no deployed API,
 * no Cognito, no AWS account). See:
 *   - test/e2e/utils/standalone-e2e-global-setup.ts (boot + cookie user pool)
 *   - doc/02-technical/development/testing/implementation-plan.md (Stage 3)
 *
 * PILOT SUBSET: a handful of non-graph, read-mostly Tier-A suites to prove the
 * cookie-auth architecture. Expand to the full Tier-A/B set once green
 * (CRUD/social shards, then media once LocalStack S3/SQS is wired here).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      // Read suites.
      "test/e2e/badges.test.ts",
      "test/e2e/taxonomy.test.ts",
      "test/e2e/role-metadata.test.ts",
      "test/e2e/user-profile.test.ts",
      // Write suites — green via the CSRF-aware authFetch (cookie mode).
      "test/e2e/comments-crud.test.ts",
      "test/e2e/reactions.test.ts",
    ],
    // Deferred pending per-suite work (see Stage 3 findings in
    // implementation-plan.md):
    //   - post-crud.test.ts / link-reports.test.ts: POST /api/posts and
    //     GET /api/feeds/home return 401 with a VALID cookie session — these
    //     paths require an activeTenantId the local cookie can't supply yet.
    //     Blocked on the identity-federation tenancy work (same root cause as
    //     the skipped entity-create test), NOT on auth/CSRF plumbing.
    //   - admin-access.test.ts: /api/admin/users is unmounted in the dummy
    //     standalone server (404 vs deployed 403).
    globalSetup: ["test/e2e/utils/standalone-e2e-global-setup.ts"],
    setupFiles: ["test/standalone/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 90_000,
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 1 } },
    fileParallelism: false,
  },
});
