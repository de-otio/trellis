/**
 * Vitest config for the D3 Neptune writer-failover test.
 *
 * Separate from vitest.graph.config.ts because this lane forces a *real*
 * Amazon Neptune failover and runs only inside the D2/D3 CodeBuild runner,
 * against a writer+reader cluster, with:
 *   GRAPH_TEST_AUTH_MODE=iam
 *   RUN_FAILOVER=1
 *   GRAPH_DB_URI=bolt://<cluster-endpoint>:8182
 *   NEPTUNE_CLUSTER_ID=<db-cluster-identifier>
 *   AWS_REGION=eu-central-1
 *
 * Run:
 *   npm run test:graph:failover -w @de-otio/trellis
 *
 * The suite self-skips unless RUN_FAILOVER=1, so this config is inert
 * elsewhere. See doc/02-technical/development/testing/neptune-d2-d3-codebuild.md
 * (in skybber).
 */

import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { readFileSync } from "fs";

// Load env from .env.test.local if it exists (local dev convenience).
// Shell env always takes precedence.
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
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // File doesn't exist — env vars must be set externally (the runner does this).
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only the failover suite.
    include: ["test/integration/graph/**/*.failover.test.ts"],
    setupFiles: [],
    // Failover + DNS flip + reconnect can take a couple of minutes.
    testTimeout: 200_000,
    hookTimeout: 60_000,
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
