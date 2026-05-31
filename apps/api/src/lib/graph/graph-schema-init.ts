/**
 * Graph Schema Initialization
 *
 * Creates constraints and indexes in the graph database on first connect.
 * Idempotent — safe to run multiple times. Uses "CREATE ... IF NOT EXISTS"
 * syntax supported by Neo4j 5+ (AuraDB and Community).
 *
 * @see /analysis/redesign/07-graph-database/04-graph-schema.md
 */

import type { Session } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Constraints (uniqueness + implicit index on id properties)
// ---------------------------------------------------------------------------

const CONSTRAINTS = [
  {
    name: "user_id_unique",
    query: "CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
  },
  {
    name: "entity_id_unique",
    query:
      "CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
  },
  {
    name: "post_id_unique",
    query: "CREATE CONSTRAINT post_id_unique IF NOT EXISTS FOR (p:Post) REQUIRE p.id IS UNIQUE",
  },
];

// ---------------------------------------------------------------------------
// Indexes (for discovery filtering and temporal ordering)
// ---------------------------------------------------------------------------

const INDEXES = [
  {
    name: "entity_type_breed",
    query:
      "CREATE INDEX entity_type_breed IF NOT EXISTS FOR (e:Entity) ON (e.entityType, e.breed)",
  },
  {
    name: "entity_type_lifestage",
    query:
      "CREATE INDEX entity_type_lifestage IF NOT EXISTS FOR (e:Entity) ON (e.entityType, e.lifeStage)",
  },
  {
    name: "entity_location",
    query: "CREATE POINT INDEX entity_location IF NOT EXISTS FOR (e:Entity) ON (e.location)",
  },
  {
    name: "post_created",
    query: "CREATE INDEX post_created IF NOT EXISTS FOR (p:Post) ON (p.createdAt)",
  },
  {
    name: "post_author",
    query: "CREATE INDEX post_author IF NOT EXISTS FOR (p:Post) ON (p.authorId)",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize all graph schema constraints and indexes.
 *
 * Each statement runs in its own implicit transaction (Neo4j requires
 * schema operations to be the only statement in a transaction).
 *
 * @param session - An open Neo4j session
 * @throws If any constraint or index creation fails (non-idempotent errors)
 */
export async function initGraphSchema(session: Session): Promise<void> {
  // Create constraints first (they create implicit indexes on the constrained property)
  for (const constraint of CONSTRAINTS) {
    await session.run(constraint.query);
  }

  // Create additional indexes for query performance
  for (const index of INDEXES) {
    await session.run(index.query);
  }
}

/**
 * Verify that all expected constraints and indexes exist.
 *
 * Useful for health checks and diagnostics. Returns the names of
 * any missing constraints or indexes.
 *
 * @param session - An open Neo4j session
 * @returns List of missing constraint/index names (empty if all present)
 */
export async function verifyGraphSchema(session: Session): Promise<string[]> {
  const missing: string[] = [];

  const constraintResult = await session.run("SHOW CONSTRAINTS");
  const existingConstraints = new Set(
    constraintResult.records.map((r) => r.get("name") as string),
  );

  for (const constraint of CONSTRAINTS) {
    if (!existingConstraints.has(constraint.name)) {
      missing.push(constraint.name);
    }
  }

  const indexResult = await session.run("SHOW INDEXES");
  const existingIndexes = new Set(
    indexResult.records.map((r) => r.get("name") as string),
  );

  for (const index of INDEXES) {
    if (!existingIndexes.has(index.name)) {
      missing.push(index.name);
    }
  }

  return missing;
}
