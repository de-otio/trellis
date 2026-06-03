/**
 * Graph Schema Initialization
 *
 * On Neptune Serverless there is **no DDL to run**:
 *
 *   - Neptune auto-indexes every property — there is no `CREATE INDEX`
 *     (and no `CREATE POINT INDEX`; spatial lives in Postgres/PostGIS now,
 *     see ../entity-location-subsystem.md).
 *   - Neptune has no property-level uniqueness constraint — only the internal
 *     `~id` is unique — so `CREATE CONSTRAINT … IS UNIQUE` is unsupported.
 *   - `SHOW CONSTRAINTS` / `SHOW INDEXES` do not exist.
 *
 * (Audit findings F6/F7/F8 — see
 * plans/redesign/graph-db-neptune-serverless/10-opencypher-audit.md.)
 *
 * So schema-init reduces to a **connectivity probe**. This still runs on both
 * the Neptune target and the local Docker Neo4j test loop (`RETURN 1` is
 * portable), keeping the two engines in parity.
 *
 * ## Where uniqueness comes from
 *
 * Business `id`s (User/Entity/Post) are minted in Postgres as unique primary
 * keys; the graph only ever *mirrors* them via `MERGE (n:Label {id: $id})` in
 * the sync path — it never generates an id. The MERGE is an idempotent upsert
 * keyed on that already-unique id, so duplicate nodes cannot arise from the
 * graph layer. Uniqueness is therefore enforced upstream + app-layer, not by a
 * DB constraint. (DEC2 names the business id as the conceptual `~id`; we keep
 * it as a regular, auto-indexed property rather than rewriting every MATCH/
 * RETURN to Neptune's non-portable `~id` accessor — same guarantee, and the
 * queries stay runnable on Docker Neo4j.)
 */

import type { Session } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the graph schema.
 *
 * Neptune needs no constraints or indexes (it auto-indexes all properties and
 * supports no `CREATE CONSTRAINT`/`CREATE INDEX`), so this is a connectivity
 * probe rather than DDL. Trivially idempotent — safe to run on every connect.
 *
 * @param session - An open graph session (Neptune Bolt or Docker Neo4j)
 * @throws If the database is unreachable
 */
export async function initGraphSchema(session: Session): Promise<void> {
  // Connectivity probe — no schema objects to create on Neptune.
  await session.run("RETURN 1");
}

/**
 * Verify the graph schema for health checks / diagnostics.
 *
 * There are no DB-enforced schema objects on Neptune to verify, so this
 * confirms connectivity and reports nothing missing. Kept (returning an empty
 * list) so callers and the public `index.ts` surface are unchanged.
 *
 * @param session - An open graph session
 * @returns Always `[]` — there is no DB-level schema to be missing
 */
export async function verifyGraphSchema(session: Session): Promise<string[]> {
  await session.run("RETURN 1");
  return [];
}
