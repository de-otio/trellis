import { defineConfig } from "vitest/config";

/**
 * The testkit's own lane.
 *
 * Boots a real Trellis server through `startStandaloneServer()` — the packaged
 * path, resolving `@de-otio/trellis` from node_modules exactly as a consumer
 * does. Core's in-repo standalone lane boots from `src` instead, on purpose;
 * between them the two cover both halves.
 *
 * NO `globalSetup`, deliberately: core's extension registry is in-process
 * state, and a globalSetup boot lands in the main vitest process while tests
 * run in a worker. Each file boots in `beforeAll` instead, which is also what
 * makes the registration checks mean anything. See test/harness.ts.
 *
 * Run: docker compose -f fixtures/docker-compose.yml up -d
 *      npm test -w @de-otio/trellis-extension-testkit
 *
 * Requires `apps/api` to have been BUILT (the consumer path is `dist/`) with a
 * generated Prisma client.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One local server, one small pool. Parallelism belongs at the CI-job
    // level, not inside a lane that owns a port. (Vitest 4 removed
    // `poolOptions` — these are top-level now.)
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
