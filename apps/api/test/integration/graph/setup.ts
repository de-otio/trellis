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
 * Required environment variables (default Neo4j basic-auth mode):
 *   NEO4J_TEST_URI       e.g. bolt://localhost:7687
 *   NEO4J_TEST_USER      e.g. neo4j
 *   NEO4J_TEST_PASSWORD  e.g. testpassword
 *
 * Optional environment variables:
 *   NEO4J_TEST_DATABASE  defaults to "test" (never "neo4j")
 *
 * Amazon Neptune IAM mode (the Track-D D2/D3 CodeBuild runner only):
 *   GRAPH_TEST_AUTH_MODE=iam   opt in to SigV4 auth via the ambient AWS role
 *   GRAPH_DB_URI               Neptune Bolt endpoint (bolt://host:8182)
 *   AWS_REGION                 cluster region (defaults to eu-central-1)
 * In this mode the driver authenticates the same way the runtime does
 * (createNeptuneAuthTokenManager in src/lib/graph/neptune-auth.ts) — no stored
 * credential — and the localhost guard is relaxed because the remote Neptune
 * host is the explicit, intended target. The default Docker-Neo4j path is
 * untouched. See doc/02-technical/development/testing/neptune-d2-d3-codebuild.md
 * (in skybber).
 */

import neo4j, { type Driver } from "neo4j-driver";
import {
  createNeptuneAuthTokenManager,
  parseBoltEndpoint,
} from "../../../src/lib/graph/neptune-auth.js";
import type { GraphServiceEnvConfig } from "../../../src/lib/graph/graph-factory.js";

/**
 * True when the suite is opted into Amazon Neptune SigV4 auth. Only the
 * D2/D3 CodeBuild runner sets this; local/CI default to Docker-Neo4j basic auth.
 */
export function isIamTestMode(): boolean {
  return process.env.GRAPH_TEST_AUTH_MODE === "iam";
}

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

  // SAFETY: never run against prod (applies to both auth modes)
  if (process.env.STAGE === "prod") {
    throw new Error(
      "Refusing to run graph integration tests with STAGE=prod. " +
        "These tests wipe the database — they must never run against production.",
    );
  }

  // Amazon Neptune IAM mode — the D2/D3 CodeBuild runner. Build the raw harness
  // driver the same way the runtime does: a SigV4 AuthTokenManager that re-signs
  // before the ~5-minute signature expiry, TLS on with system-CA trust. The
  // remote Neptune host is the explicit, intended target, so the localhost guard
  // does not apply here.
  if (isIamTestMode()) {
    const iamUri = process.env.GRAPH_DB_URI ?? process.env.NEO4J_TEST_URI;
    if (!iamUri) {
      throw new Error(
        "GRAPH_TEST_AUTH_MODE=iam requires GRAPH_DB_URI (the Neptune Bolt endpoint).",
      );
    }
    const region = process.env.AWS_REGION ?? "eu-central-1";
    const { host, port } = parseBoltEndpoint(iamUri);
    _driver = neo4j.driver(
      iamUri,
      createNeptuneAuthTokenManager({ host, port, region }),
      {
        disableLosslessIntegers: true, // Return native JS numbers
        maxConnectionPoolSize: 5, // Tests don't need a large pool
        connectionAcquisitionTimeout: 10_000,
        // Neptune speaks bolt:// (no +s scheme); TLS is enabled via config and
        // trusts the Amazon-issued system CA — mirrors Neo4jGraphService.connect.
        encrypted: "ENCRYPTION_ON",
        trust: "TRUST_SYSTEM_CA_SIGNED_CERTIFICATES",
      },
    );
    return _driver;
  }

  // Default path — Docker Neo4j / AuraDB basic auth.
  const uri = process.env.NEO4J_TEST_URI;
  if (!uri) {
    throw new Error(
      "NEO4J_TEST_URI is not set. " +
        "Copy test/integration/graph/.env.test.example and set the required variables.",
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
 * The {@link GraphServiceEnvConfig} the suite should hand to `createGraphService`
 * for the service-under-test. Centralizes the per-test config so the Neptune IAM
 * seam lives in one place instead of being duplicated across every integration
 * file.
 *
 * - Default (Docker Neo4j): basic auth from NEO4J_TEST_URI/USER/PASSWORD.
 * - IAM mode (Neptune runner): SigV4 via the ambient role; no stored credential.
 */
export function getTestGraphServiceConfig(): GraphServiceEnvConfig {
  if (isIamTestMode()) {
    const uri = process.env.GRAPH_DB_URI ?? process.env.NEO4J_TEST_URI;
    if (!uri) {
      throw new Error(
        "GRAPH_TEST_AUTH_MODE=iam requires GRAPH_DB_URI (the Neptune Bolt endpoint).",
      );
    }
    return {
      uri,
      authMode: "iam",
      region: process.env.AWS_REGION ?? "eu-central-1",
    };
  }

  return {
    uri: process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687",
    user: process.env.NEO4J_TEST_USER,
    password: process.env.NEO4J_TEST_PASSWORD,
  };
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
