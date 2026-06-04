/**
 * Standalone-lane environment.
 *
 * Single source of truth for the env the standalone server + tests run with.
 * Applied in BOTH processes:
 *   - global-setup.ts (main process) before booting the server
 *   - setup.ts (per-worker setupFile) so getApiUrl()/test-auth resolve the
 *     same target the server is listening on
 *
 * Every value is a default: an already-set process.env wins, so CI service
 * containers or a developer's shell can override (e.g. DATABASE_URL).
 */

export const STANDALONE_PORT = process.env.PORT || "3100";
export const STANDALONE_API_URL =
  process.env.API_URL || `http://localhost:${STANDALONE_PORT}`;

/** Default DB for the local stack (docker-compose.yml). */
const DEFAULT_DATABASE_URL =
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

const DEFAULTS: Record<string, string> = {
  // --- Database (docker-compose postgres) ---
  DATABASE_URL: DEFAULT_DATABASE_URL,
  DIRECT_DATABASE_URL: DEFAULT_DATABASE_URL,

  // --- DynamoDB-local single table ---
  DYNAMODB_TABLE: "test-trellis",
  DYNAMODB_ENDPOINT: "http://localhost:8000",
  AWS_ENDPOINT_URL_DYNAMODB: "http://localhost:8000",

  // --- LocalStack (S3 / SQS) ---
  AWS_ENDPOINT_URL_S3: "http://localhost:4566",
  AWS_ENDPOINT_URL_SQS: "http://localhost:4566",
  SQS_ENDPOINT: "http://localhost:4566",

  // --- AWS SDK basics (dummy creds — never hit real AWS) ---
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_ACCOUNT_ID: "000000000000",

  // --- Auth. SESSION_SECRET matches test-auth's local default so locally
  //     minted cookies and the server agree. Cognito IDs are dummy: the
  //     standalone lane authenticates by cookie, never by Cognito JWT, but
  //     validateEnv() requires these to be present. ---
  SESSION_SECRET: "test-secret-key-32-characters-long!!",
  SESSION_SALT: "standalone-test-salt-32-characters-minimum-len",
  COGNITO_USER_POOL_ID: "local_test_pool",
  COGNITO_APP_CLIENT_ID: "localtestclient0000000000",

  // --- Neo4j graph (docker-compose neo4j). The factory reads GRAPH_DB_*;
  //     NEO4J_* are the SSM-secret field names, not the env-var names. ---
  GRAPH_DB_URI: "bolt://localhost:7687",
  GRAPH_DB_USER: "neo4j",
  GRAPH_DB_PASSWORD: "trellis_dev_password",

  // --- App / deployment ---
  STAGE: "test",
  NODE_ENV: "test",
  ENVIRONMENT: "dev",
  DEFAULT_REGION: "US",
  APP_DOMAIN: STANDALONE_API_URL,
  APP_URL: STANDALONE_API_URL,
  PORT: STANDALONE_PORT,

  // Test target for getApiUrl() (highest-priority override).
  API_URL: STANDALONE_API_URL,

  // --- Example extension config (configSchema requires this) ---
  EXAMPLE_GREETING: "hello from the standalone lane",
};

/** Apply standalone env defaults (only where unset). Idempotent. */
export function applyStandaloneEnv(): void {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}
