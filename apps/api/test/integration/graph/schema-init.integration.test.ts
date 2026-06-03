/**
 * Graph Schema Initialization — Integration Test
 *
 * On Neptune Serverless schema-init is a no-op beyond a connectivity probe
 * (Neptune auto-indexes all properties and supports no CREATE CONSTRAINT /
 * CREATE INDEX / SHOW — audit F6/F7/F8). This suite asserts that contract
 * against a real graph session:
 *   - init succeeds against a reachable database (connectivity probe)
 *   - init is idempotent (safe to run on every connect)
 *   - verify reports nothing missing (there is no DB-level schema to verify)
 *   - it issues no DDL — uniqueness is upstream (Postgres PKs) + MERGE-keyed,
 *     not a DB constraint
 *
 * Prerequisites (same as the rest of the graph lane): a running Neo4j and
 * NEO4J_TEST_* env vars. Run: npm run test:graph -w @de-otio/trellis
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "neo4j-driver";
import { getTestDatabase, getTestDriver, closeTestDriver } from "./setup.js";
import { initGraphSchema, verifyGraphSchema } from "../../../src/lib/graph/graph-schema-init.js";

function session(): Session {
  return getTestDriver().session({ database: getTestDatabase() });
}

describe("graph schema initialization", () => {
  beforeAll(async () => {
    const s = session();
    try {
      await initGraphSchema(s);
    } finally {
      await s.close();
    }
  });

  afterAll(async () => {
    await closeTestDriver();
  });

  it("init succeeds against a reachable database (connectivity probe)", async () => {
    const s = session();
    try {
      await expect(initGraphSchema(s)).resolves.toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("is idempotent — running init repeatedly does not throw", async () => {
    const s = session();
    try {
      await initGraphSchema(s);
      await expect(initGraphSchema(s)).resolves.toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("verify reports nothing missing (no DB-level schema to verify on Neptune)", async () => {
    const s = session();
    try {
      expect(await verifyGraphSchema(s)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("creates no constraints or indexes (Neptune auto-indexes; uniqueness is upstream)", async () => {
    // Drop anything a prior, pre-C3 build may have left, then prove init does
    // not re-create it: schema-init must issue no DDL.
    const s = session();
    try {
      for (const name of ["user_id_unique", "entity_id_unique", "post_id_unique"]) {
        await s.run(`DROP CONSTRAINT ${name} IF EXISTS`);
      }
      await initGraphSchema(s);

      const constraints = await s.run("SHOW CONSTRAINTS");
      const names = new Set(constraints.records.map((r) => r.get("name") as string));
      expect(names.has("user_id_unique")).toBe(false);
      expect(names.has("entity_id_unique")).toBe(false);
      expect(names.has("post_id_unique")).toBe(false);
    } finally {
      await s.close();
    }
  });
});
