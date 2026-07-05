/**
 * Vitest config for the Postgres GRAPH LANE — the graph-adapter integration
 * suites (test/integration/graph/**) that prove the CircleOps / DiscoveryOps /
 * RelationshipOps / ScoringOps SQL against a live Postgres carrying the
 * trellis schema.
 *
 * Deliberately separate from vitest.config.ts (unit tests) and
 * vitest.integration.config.ts (broader Postgres/DynamoDB integration tests)
 * so that graph tests only run when explicitly requested.
 *
 * Prerequisites:
 *   - Postgres migrated to the current schema (e.g. the local docker dev DB)
 *   - DATABASE_URL (or TEST_DB_URL) pointing at it — via the shell or
 *     test/integration/graph/.env.test.local
 *
 * The suites keep their env guard (describe.skip without a DB) so the
 * default `npm test` run needs no database.
 *
 * Run:
 *   DATABASE_URL=postgresql://… npm run test:graph -w @de-otio/trellis
 */

import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { readFileSync } from "fs";

// Load env from .env.test.local if it exists (local dev convenience)
// Environment variables set in the shell always take precedence
const envLocalPath = resolve(
  __dirname,
  "test/integration/graph/.env.test.local",
);
try {
  const lines = readFileSync(envLocalPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Only set if not already in env (shell env takes precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // File doesn't exist — that's fine; env vars must be set externally
}

// Lane alias: allow TEST_DB_URL as the canonical graph-lane variable; the
// suites read DATABASE_URL first, so map it through when only the alias is
// set. (Shell-set DATABASE_URL always wins.)
if (!process.env.DATABASE_URL && process.env.TEST_DB_URL) {
  process.env.DATABASE_URL = process.env.TEST_DB_URL;
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only graph integration tests
    include: ["test/integration/graph/**/*.test.ts"],
    // The D3 failover suite (*.failover.test.ts) forces a real Neptune writer
    // failover and runs only in the D2/D3 CodeBuild runner — never in the
    // default Docker-Neo4j lane. It has its own config
    // (vitest.graph.failover.config.ts).
    exclude: ["test/integration/graph/**/*.failover.test.ts"],
    // No shared setupFiles — graph suites manage their own Prisma client
    // (the global test/setup.ts overrides DATABASE_URL and other env vars,
    //  which would clobber the lane's DB selection)
    setupFiles: [],
    testTimeout: 30_000, // 30 seconds — connection + wipe can be slow on cold start
    hookTimeout: 30_000,
    // Single thread: each test file wipes the same database
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 1,
      },
    },
    fileParallelism: false,
  },
});
