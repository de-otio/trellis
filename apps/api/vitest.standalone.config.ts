import { defineConfig } from "vitest/config";

/**
 * Standalone test lane.
 *
 * Boots the real Trellis server in-process (globalSetup) with the dummy-target
 * extensions, against the local docker-compose stack — no AWS, no consuming
 * vertical. Test files drive the full HTTP request path over localhost.
 *
 * Run: docker compose up -d && npm run test:standalone -w @de-otio/trellis
 * See doc/02-technical/development/testing/standalone.md.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/standalone/**/*.test.ts"],
    globalSetup: ["test/standalone/global-setup.ts"],
    setupFiles: ["test/standalone/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Single-threaded: one local server + small DB pool. Mirrors the e2e lane;
    // parallelism belongs at the CI-shard level, not inside one vitest process.
    pool: "threads",
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 1 },
    },
    fileParallelism: false,
  },
});
