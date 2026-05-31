/**
 * Graph Service Factory
 *
 * Creates and configures the GraphService implementation (Neo4j over Bolt)
 * against either AuraDB (dev/prod) or a local Docker Neo4j (local/integration
 * tests). Both targets speak the same Cypher dialect, so the factory only
 * varies authentication and connection string.
 *
 * @example
 * ```typescript
 * const graphService = await createGraphService({
 *   uri: "bolt://localhost:7687",
 *   user: "neo4j",
 *   password: "test-password",
 * });
 *
 * const health = await graphService.healthCheck();
 * ```
 */

import type { GraphService, GraphConnection } from "./graph-service.js";
import type { GraphConnectionConfig } from "./types.js";
import { Neo4jGraphService } from "./neo4j-graph-service.js";

// ---------------------------------------------------------------------------
// Factory Configuration (from environment variables)
// ---------------------------------------------------------------------------

export interface GraphServiceEnvConfig {
  /** Graph database Bolt endpoint (bolt:// for local Neo4j, bolt+s:// for AuraDB) */
  uri: string;
  /** Username for basic auth. */
  user?: string;
  /** Password for basic auth. */
  password?: string;
  /** AWS region used by SSM credential lookup in createGraphServiceFromEnv. */
  region?: string;
  maxConnectionPoolSize?: number;
  connectionAcquisitionTimeout?: number;
  maxConnectionLifetime?: number;
  connectionLivenessCheckTimeout?: number;
  /** Per-query timeout in milliseconds. */
  queryTimeoutMs?: number;
}

/**
 * Build a GraphConnectionConfig from environment-style config.
 */
function buildConnectionConfig(
  env: GraphServiceEnvConfig,
): GraphConnectionConfig {
  const auth: GraphConnectionConfig["auth"] =
    env.user && env.password
      ? { type: "basic", username: env.user, password: env.password }
      : { type: "none" };

  return {
    endpoint: env.uri,
    auth,
    pool: {
      maxConnectionPoolSize: env.maxConnectionPoolSize,
      connectionAcquisitionTimeout: env.connectionAcquisitionTimeout,
      maxConnectionLifetime: env.maxConnectionLifetime,
      connectionLivenessCheckTimeout: env.connectionLivenessCheckTimeout,
    },
    queryTimeoutMs: env.queryTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Environment Variable Helpers
// ---------------------------------------------------------------------------

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    // Throwing at startup fails the ECS health check, triggering a
    // rollback via ECS circuitBreaker instead of running with bad config.
    throw new Error(`${name} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create a connected GraphService instance.
 *
 * Reads connection config, creates the appropriate implementation,
 * and establishes the connection (including schema initialization).
 *
 * @param envConfig - Connection configuration (typically from process.env)
 * @returns A connected GraphService instance that also implements GraphConnection
 * @throws GraphConnectionError if the database is unreachable
 */
export async function createGraphService(
  envConfig: GraphServiceEnvConfig,
): Promise<GraphService & GraphConnection> {
  const config = buildConnectionConfig(envConfig);

  const service = new Neo4jGraphService();
  await service.connect(config);
  return service;
}

/**
 * Fetch AuraDB credentials from an SSM SecureString without touching process.env.
 * The returned values live only on the returned object and are passed directly
 * into the neo4j driver; `process.env` is never mutated.
 */
async function fetchGraphCredentialsFromSsm(
  paramName: string,
  region: string,
): Promise<{ uri: string; user: string; password: string }> {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const client = new SSMClient({ region });
  const response = await client.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
  );
  const raw = response.Parameter?.Value;
  if (!raw) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SSM parameter ${paramName} is not valid JSON`);
  }

  const uri = parsed.NEO4J_URI;
  const user = parsed.NEO4J_USERNAME;
  const password = parsed.NEO4J_PASSWORD;

  if (typeof uri !== "string" || typeof user !== "string" || typeof password !== "string") {
    throw new Error(
      `SSM parameter ${paramName} missing required fields NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD`,
    );
  }

  return { uri, user, password };
}

/**
 * Create a GraphService from standard environment variables or SSM.
 *
 * Resolution order:
 *   1. If GRAPH_DB_URI is set, use direct env vars (local dev, integration tests).
 *   2. Else if GRAPH_DB_CREDENTIALS_SSM_PARAM is set, fetch and decrypt from SSM.
 *
 * Credentials fetched from SSM are kept in function-local scope and passed
 * directly to the neo4j driver. They never enter process.env, so child
 * processes, core dumps, and `env` in a shell exec don't leak them.
 *
 * @returns A connected GraphService instance
 * @throws GraphConnectionError if the database is unreachable
 * @throws Error if neither GRAPH_DB_URI nor GRAPH_DB_CREDENTIALS_SSM_PARAM is set
 */
export async function createGraphServiceFromEnv(_env?: unknown): Promise<
  GraphService & GraphConnection
> {
  const region = process.env.AWS_REGION ?? "eu-central-1";
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  const poolMax = isLambda ? 1 : intEnv("GRAPH_DB_POOL_MAX_SIZE");

  // Direct env-var path — local dev, docker-compose, integration tests.
  if (process.env.GRAPH_DB_URI) {
    return createGraphService({
      uri: process.env.GRAPH_DB_URI,
      user: process.env.GRAPH_DB_USER,
      password: process.env.GRAPH_DB_PASSWORD,
      region,
      maxConnectionPoolSize: poolMax,
      connectionAcquisitionTimeout: intEnv("GRAPH_DB_POOL_ACQUIRE_TIMEOUT_MS"),
      maxConnectionLifetime: intEnv("GRAPH_DB_POOL_MAX_LIFETIME_MS"),
      connectionLivenessCheckTimeout: intEnv("GRAPH_DB_POOL_LIVENESS_CHECK_MS"),
      queryTimeoutMs: intEnv("GRAPH_DB_QUERY_TIMEOUT_MS"),
    });
  }

  // Runtime SSM fetch — prod / dev AWS. Credentials stay in-memory only.
  const paramName = process.env.GRAPH_DB_CREDENTIALS_SSM_PARAM;
  if (!paramName) {
    throw new Error(
      "Graph DB config missing: set either GRAPH_DB_URI (local) or GRAPH_DB_CREDENTIALS_SSM_PARAM (AWS)",
    );
  }

  const creds = await fetchGraphCredentialsFromSsm(paramName, region);
  return createGraphService({
    uri: creds.uri,
    user: creds.user,
    password: creds.password,
    region,
    maxConnectionPoolSize: poolMax,
    connectionAcquisitionTimeout: intEnv("GRAPH_DB_POOL_ACQUIRE_TIMEOUT_MS"),
    maxConnectionLifetime: intEnv("GRAPH_DB_POOL_MAX_LIFETIME_MS"),
    connectionLivenessCheckTimeout: intEnv("GRAPH_DB_POOL_LIVENESS_CHECK_MS"),
    queryTimeoutMs: intEnv("GRAPH_DB_QUERY_TIMEOUT_MS"),
  });
}
