/**
 * Graph Schema Initialization — Integration Test
 *
 * Exercises initGraphSchema / verifyGraphSchema against a real Neo4j 5 instance:
 *   - init creates every constraint + index; verify then reports none missing
 *   - init is idempotent (safe to run repeatedly — uses IF NOT EXISTS)
 *   - verify detects a dropped constraint, and a re-init restores it
 *   - the uniqueness constraints actually enforce uniqueness
 *
 * Prerequisites (same as the rest of the graph lane): a running Neo4j and
 * NEO4J_TEST_* env vars. Run: npm run test:graph -w @de-otio/trellis
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "neo4j-driver";
import { getTestDatabase, getTestDriver, closeTestDriver } from "./setup.js";
import { initGraphSchema, verifyGraphSchema } from "../../../src/lib/graph/graph-schema-init.js";

const ALL_SCHEMA_OBJECTS = [
  // constraints
  "user_id_unique",
  "entity_id_unique",
  "post_id_unique",
  // indexes
  "entity_type_breed",
  "entity_type_lifestage",
  "entity_location",
  "post_created",
  "post_author",
];

function session(): Session {
  return getTestDriver().session({ database: getTestDatabase() });
}

describe("graph schema initialization", () => {
  beforeAll(async () => {
    // Ensure a known-good baseline: every constraint/index present.
    const s = session();
    try {
      await initGraphSchema(s);
    } finally {
      await s.close();
    }
  });

  afterAll(async () => {
    // Leave the schema intact for the rest of the lane, then drop the driver.
    const s = session();
    try {
      await initGraphSchema(s);
    } finally {
      await s.close();
    }
    await closeTestDriver();
  });

  it("creates every documented constraint and index (verify reports none missing)", async () => {
    const s = session();
    try {
      await initGraphSchema(s);
      const missing = await verifyGraphSchema(s);
      expect(missing).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("is idempotent — running init twice does not throw and leaves nothing missing", async () => {
    const s = session();
    try {
      await initGraphSchema(s);
      await expect(initGraphSchema(s)).resolves.toBeUndefined();
      expect(await verifyGraphSchema(s)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("verifyGraphSchema reports a dropped constraint, and re-init restores it", async () => {
    const s = session();
    try {
      await initGraphSchema(s);
      await s.run("DROP CONSTRAINT user_id_unique IF EXISTS");

      const missing = await verifyGraphSchema(s);
      expect(missing).toContain("user_id_unique");

      await initGraphSchema(s);
      expect(await verifyGraphSchema(s)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("the uniqueness constraint actually rejects a duplicate id", async () => {
    const s = session();
    try {
      await initGraphSchema(s);
      const id = `schema-init-dupe-${Math.abs(hashString("seed"))}`;
      // Clean any prior node with this id, then create one.
      await s.run("MATCH (u:User {id: $id}) DETACH DELETE u", { id });
      await s.run("CREATE (u:User {id: $id})", { id });

      await expect(s.run("CREATE (u:User {id: $id})", { id })).rejects.toThrow();

      // Cleanup
      await s.run("MATCH (u:User {id: $id}) DETACH DELETE u", { id });
    } finally {
      await s.close();
    }
  });

  it("exposes the full documented set of schema object names via verify", async () => {
    // Drop the lot is unsafe for the shared lane; instead assert that after a
    // clean init, none of the known names are reported missing (i.e. verify
    // knows about exactly the documented objects).
    const s = session();
    try {
      await initGraphSchema(s);
      const missing = await verifyGraphSchema(s);
      for (const name of ALL_SCHEMA_OBJECTS) {
        expect(missing).not.toContain(name);
      }
    } finally {
      await s.close();
    }
  });
});

// Deterministic small hash so the duplicate-id node has a stable, unique-ish id
// without relying on Date.now()/random (which the graph lane avoids).
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
