/**
 * Vitest config for Agents stack post-deploy smoke tests.
 * Unlike vitest.e2e.config.ts, this config does NOT include the global e2e setup
 * (which requires a reachable API). Agents tests only call AWS APIs directly.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/agents.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
