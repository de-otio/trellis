/**
 * Vitest config for Neo4j graph integration tests.
 *
 * Deliberately separate from vitest.config.ts (unit tests) and
 * vitest.integration.config.ts (Postgres/DynamoDB integration tests)
 * so that graph tests only run when explicitly requested.
 *
 * Prerequisites:
 *   - Neo4j running locally on bolt://localhost:7687
 *   - A dedicated "test" database created (CREATE DATABASE test)
 *   - NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD set in env
 *
 * Run:
 *   npm run test:graph -w @de-otio/trellis
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
    // No shared setupFiles — graph tests manage their own Neo4j connection
    // (the global test/setup.ts sets DATABASE_URL and other Postgres env vars
    //  which are irrelevant here and would pollute the env)
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
