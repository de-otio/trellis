/**
 * Graph Integration Harness — Smoke Test
 *
 * Verifies that the test harness is wired up correctly end-to-end:
 *   - Connects to local Neo4j
 *   - Wipes the test database safely
 *   - Creates a User node
 *   - Counts nodes correctly
 *
 * This is a scaffolding smoke test only. Feature-specific tests live
 * alongside their respective service modules.
 *
 * Prerequisites:
 *   1. Neo4j running locally (bolt://localhost:7687)
 *   2. A "test" database created: CREATE DATABASE test (in Neo4j Browser)
 *   3. Environment variables set (copy .env.test.example → .env.test.local)
 *
 * Run:
 *   npm run test:graph -w @de-otio/trellis
 */

import { afterAll, describe, expect, it } from "vitest";
import { closeTestDriver, countNodes, createUser, withCleanDb } from "./harness.js";

afterAll(async () => {
  await closeTestDriver();
});

describe("Graph harness smoke test", () => {
  it("connects, wipes, creates a User, and counts it", async () => {
    await withCleanDb(async () => {
      // Database should be empty after wipe
      expect(await countNodes()).toBe(0);

      // Create a single User node
      await createUser("u1", "END_USER");

      // Should now have exactly one User node
      expect(await countNodes("User")).toBe(1);

      // Total node count should also be 1
      expect(await countNodes()).toBe(1);
    });
  });
});
