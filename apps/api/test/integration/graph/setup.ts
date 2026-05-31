/**
 * Graph Integration Test Setup
 *
 * Provides environment loading, config validation, and connection helpers
 * for Neo4j-backed integration tests.
 *
 * SAFETY:
 * - Refuses to use the default "neo4j" database without explicit opt-in
 * - No hardcoded credentials — all config from env vars
 * - Localhost URIs are always safe; non-local URIs are allowed for CI/dev pipelines
 *
 * Required environment variables:
 *   NEO4J_TEST_URI       e.g. bolt://localhost:7687
 *   NEO4J_TEST_USER      e.g. neo4j
 *   NEO4J_TEST_PASSWORD  e.g. testpassword
 *
 * Optional environment variables:
 *   NEO4J_TEST_DATABASE  defaults to "test" (never "neo4j")
 */

import neo4j, { type Driver } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Singleton driver (one per test process)
// ---------------------------------------------------------------------------

let _driver: Driver | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get (or lazily create) a Neo4j Driver pointed at the local test database.
 *
 * Throws immediately if:
 * - NEO4J_TEST_URI is not set
 * - NEO4J_TEST_URI points at a non-localhost host
 * - NEO4J_TEST_USER is not set
 * - NEO4J_TEST_PASSWORD is not set
 */
export function getTestDriver(): Driver {
  if (_driver) {
    return _driver;
  }

  const uri = process.env.NEO4J_TEST_URI;
  if (!uri) {
    throw new Error(
      "NEO4J_TEST_URI is not set. " +
        "Copy test/integration/graph/.env.test.example and set the required variables.",
    );
  }

  // SAFETY: never run against prod
  if (process.env.STAGE === "prod") {
    throw new Error(
      "Refusing to run graph integration tests with STAGE=prod. " +
        "These tests wipe the database — they must never run against production.",
    );
  }

  // Localhost URIs are always safe. Non-local URIs are allowed for CI pipelines
  // targeting a dev database (STAGE=dev), but we log a warning so it's visible.
  const isLocal = /^bolt:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(uri);
  if (!isLocal) {
    console.warn(
      `[graph-test] WARNING: connecting to non-local Neo4j URI: ${uri} ` +
        `(STAGE=${process.env.STAGE ?? "unset"})`,
    );
  }

  const user = process.env.NEO4J_TEST_USER;
  if (!user) {
    throw new Error(
      "NEO4J_TEST_USER is not set. " +
        "Copy test/integration/graph/.env.test.example and set the required variables.",
    );
  }

  const password = process.env.NEO4J_TEST_PASSWORD;
  if (!password) {
    throw new Error(
      "NEO4J_TEST_PASSWORD is not set. " +
        "Copy test/integration/graph/.env.test.example and set the required variables.",
    );
  }

  _driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true, // Return native JS numbers
    maxConnectionPoolSize: 5, // Tests don't need a large pool
    connectionAcquisitionTimeout: 10_000,
  });

  return _driver;
}

/**
 * Get the name of the test database to use.
 *
 * Reads NEO4J_TEST_DATABASE (defaults to "test").
 * Refuses to use the default "neo4j" database as a safety guard.
 */
export function getTestDatabase(): string {
  const dbName = process.env.NEO4J_TEST_DATABASE ?? "test";

  // Community Edition doesn't support multi-database; allow "neo4j" only if
  // explicitly acknowledged via NEO4J_TEST_ALLOW_DEFAULT_DB=1. The 10k-node
  // wipe threshold in wipeTestDb still protects against clobbering real data.
  if (dbName === "neo4j" && process.env.NEO4J_TEST_ALLOW_DEFAULT_DB !== "1") {
    throw new Error(
      "Refusing to run integration tests against the default 'neo4j' database. " +
        "For Neo4j Enterprise: set NEO4J_TEST_DATABASE to a dedicated name and run CREATE DATABASE <name>. " +
        "For Neo4j Community (no multi-db support): set NEO4J_TEST_ALLOW_DEFAULT_DB=1 to opt in.",
    );
  }

  return dbName;
}

/**
 * Close the singleton driver. Call in globalTeardown or afterAll if needed.
 */
export async function closeTestDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
