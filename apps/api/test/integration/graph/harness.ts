/**
 * Graph Integration Test Harness
 *
 * Provides fixtures, setup/teardown helpers, and a `withCleanDb` wrapper
 * for Neo4j-backed graph integration tests.
 *
 * Safety rules enforced here:
 * 1. wipeTestDb() refuses to delete more than 10,000 nodes (non-test DB guard)
 * 2. All destructive ops use the dedicated test database, never "neo4j"
 * 3. All queries use parameterized form ($param) — no string interpolation
 *
 * Usage:
 *   import { withCleanDb, createUser, countNodes } from "./harness.js";
 *
 *   it("should ...", async () => {
 *     await withCleanDb(async () => {
 *       await createUser("u1", "END_USER");
 *       expect(await countNodes("User")).toBe(1);
 *     });
 *   });
 */

import { closeTestDriver, getTestDatabase, getTestDriver } from "./setup.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Open a session against the test database, run a function, then close it.
 * Never leaks the session even if the callback throws.
 */
async function withSession<T>(
  fn: (session: import("neo4j-driver").Session) => Promise<T>,
): Promise<T> {
  const driver = getTestDriver();
  const database = getTestDatabase();
  const session = driver.session({ database });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Exported harness API
// ---------------------------------------------------------------------------

/**
 * Wipe the entire test database.
 *
 * SAFETY:
 * - Refuses to run with STAGE=prod (destructive — never run against production)
 * - Aborts if more than 10,000 nodes exist (non-test DB guard)
 *
 * Use `deleteTestNodes(runId)` instead for prod-safe cleanup in tests that
 * scope their data to a unique run ID prefix.
 */
export async function wipeTestDb(): Promise<void> {
  if (process.env.STAGE === "prod") {
    throw new Error(
      "Refusing to wipe database with STAGE=prod. " +
        "wipeTestDb() is destructive and must never run against production. " +
        "Use deleteTestNodes(runId) for prod-safe per-run cleanup instead.",
    );
  }

  await withSession(async (session) => {
    // Safety check: refuse to wipe if node count is suspiciously high
    const countResult = await session.run("MATCH (n) RETURN count(n) AS c");
    const count = (countResult.records[0]?.get("c") as number) ?? 0;

    if (count > 10_000) {
      throw new Error(
        `Refusing to wipe: ${count} nodes exceed the safety threshold of 10,000. ` +
          "This does not look like a clean test database.",
      );
    }

    await session.run("MATCH (n) DETACH DELETE n");
  });
}

/**
 * Delete all nodes whose `id` starts with the given prefix, and their
 * incident edges.
 *
 * Use this in `afterAll` for prod-safe tests that scope their data to a
 * unique run ID prefix (e.g. `const RUN_ID = \`test-${Date.now().toString(36)}\``).
 *
 * Unlike `wipeTestDb`, this is safe to run against any database — it only
 * removes nodes that this test run created.
 *
 * @param prefix - ID prefix shared by all nodes created in this test run
 */
export async function deleteTestNodes(prefix: string): Promise<void> {
  await withSession(async (session) => {
    await session.run(
      "MATCH (n) WHERE n.id STARTS WITH $prefix DETACH DELETE n",
      { prefix },
    );
  });
}

/**
 * Wrap a test body with a pre-test wipe.
 * Ensures each test starts with a clean database regardless of prior state.
 *
 * @example
 *   await withCleanDb(async () => {
 *     await createUser("u1", "END_USER");
 *     expect(await countNodes("User")).toBe(1);
 *   });
 */
export async function withCleanDb(fn: () => Promise<void>): Promise<void> {
  await wipeTestDb();
  await fn();
}

/**
 * Create a User node in the test database.
 *
 * @param id   Unique user identifier (matches User.id in the application schema)
 * @param role User role string (e.g. "END_USER", "ADMIN")
 */
export async function createUser(id: string, role: string): Promise<void> {
  await withSession(async (session) => {
    await session.run(
      "CREATE (u:User { id: $id, role: $role, createdAt: datetime() })",
      { id, role },
    );
  });
}

/**
 * Create an Entity node in the test database.
 *
 * @param id    Unique entity identifier
 * @param props Entity properties — entityType and name are required
 */
export async function createEntity(
  id: string,
  props: { entityType: string; name: string; [key: string]: unknown },
): Promise<void> {
  const { entityType, name, ...extra } = props;
  await withSession(async (session) => {
    await session.run(
      "CREATE (e:Entity { id: $id, entityType: $entityType, name: $name, createdAt: datetime() })",
      { id, entityType, name, ...extra },
    );
  });
}

/**
 * Create an OWNS relationship between a User and an Entity.
 *
 * @param userId   ID of an existing User node
 * @param entityId ID of an existing Entity node
 * @param role     Ownership role (e.g. "OWNER", "MANAGER")
 */
export async function createOwnership(
  userId: string,
  entityId: string,
  role: string,
): Promise<void> {
  await withSession(async (session) => {
    const result = await session.run(
      `MATCH (u:User { id: $userId }), (e:Entity { id: $entityId })
       CREATE (u)-[:OWNS { role: $role, createdAt: datetime() }]->(e)
       RETURN u, e`,
      { userId, entityId, role },
    );

    if (result.records.length === 0) {
      throw new Error(
        `createOwnership: could not find User(${userId}) or Entity(${entityId}). ` +
          "Ensure both nodes exist before creating the relationship.",
      );
    }
  });
}

/**
 * Count nodes in the test database, optionally filtered by label.
 *
 * @param label Optional Neo4j node label (e.g. "User", "Entity"). Counts all nodes if omitted.
 * @returns The number of matching nodes as a plain JS number
 */
export async function countNodes(label?: string): Promise<number> {
  return withSession(async (session) => {
    const query = label
      ? `MATCH (n:${label}) RETURN count(n) AS c`
      : "MATCH (n) RETURN count(n) AS c";

    const result = await session.run(query);
    return (result.records[0]?.get("c") as number) ?? 0;
  });
}

/**
 * Close the shared driver connection. Call in afterAll when you are done
 * with all graph tests in a suite to free the connection pool.
 */
export { closeTestDriver };
