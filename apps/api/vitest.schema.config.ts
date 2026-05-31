import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/schema/**/*.test.ts"],
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 1,
  },
});
