/**
 * The environment a standalone Trellis boot needs.
 *
 * Core's `validateEnv()` refuses to boot on a missing key, and several modules
 * read `process.env` at import time — so this has to be applied *before* core
 * is imported, not before it is called. That ordering is the single reason
 * {@link standaloneEnv} is a separate exported step rather than something
 * `startStandaloneServer` does internally and privately.
 *
 * Every value is a default: an already-set `process.env` entry wins, so CI
 * service containers and a developer's shell keep control of `DATABASE_URL`,
 * `PORT`, and anything else they care about.
 *
 * This file is the packaged form of what both core and the first downstream
 * vertical had hand-written, ~95% identically. The 5% that differed was the
 * port and the DynamoDB table name — which is exactly what {@link StandaloneEnvOptions}
 * parameterises, so two lanes can share one docker stack without colliding.
 */

/** Knobs that genuinely differ between two lanes sharing one docker stack. */
export interface StandaloneEnvOptions {
  /** Port the server listens on. Default `3100`. */
  port?: number | string;
  /** DynamoDB-local table name. Default `trellis-testkit`. */
  dynamoTable?: string;
  /** Postgres connection string. Default: the shipped compose stack's. */
  databaseUrl?: string;
  /** DynamoDB-local endpoint. Default `http://localhost:8000`. */
  dynamoEndpoint?: string;
  /**
   * Extra env the extension under test requires — typically the keys its
   * `configSchema` declares. Applied with the same "already-set wins" rule.
   */
  extra?: Record<string, string>;
}

/** The connection string the shipped `fixtures/docker-compose.yml` serves. */
export const DEFAULT_DATABASE_URL =
  "postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev";

/** The resolved values, returned so a caller can build URLs without guessing. */
export interface ResolvedStandaloneEnv {
  readonly port: string;
  readonly apiUrl: string;
  readonly databaseUrl: string;
  readonly dynamoTable: string;
  readonly dynamoEndpoint: string;
}

function defaults(opts: StandaloneEnvOptions): Record<string, string> {
  const port = String(opts.port ?? process.env.PORT ?? 3100);
  const apiUrl = process.env.API_URL || `http://localhost:${port}`;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const dynamoTable = opts.dynamoTable ?? "trellis-testkit";
  const dynamoEndpoint = opts.dynamoEndpoint ?? "http://localhost:8000";

  return {
    // --- Database ---
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: databaseUrl,

    // --- DynamoDB-local single table (pk/sk) ---
    DYNAMODB_TABLE: dynamoTable,
    DYNAMODB_ENDPOINT: dynamoEndpoint,
    AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,

    // --- LocalStack (S3 / SQS). The stack need not be running: core builds
    //     these clients lazily and a standalone lane uploads no media. ---
    AWS_ENDPOINT_URL_S3: "http://localhost:4566",
    AWS_ENDPOINT_URL_SQS: "http://localhost:4566",
    SQS_ENDPOINT: "http://localhost:4566",

    // --- AWS SDK basics. Dummy credentials, and deliberately so: a
    //     standalone lane that could reach a real account is a lane that can
    //     bill you for a typo. ---
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_ACCOUNT_ID: "000000000000",

    // --- Auth. The lane authenticates by cookie and never presents a
    //     Cognito JWT, but `validateEnv()` requires the pool IDs to exist,
    //     so they are present and fake. ---
    SESSION_SECRET: "test-secret-key-32-characters-long!!",
    SESSION_SALT: "standalone-test-salt-32-characters-minimum-len",
    COGNITO_USER_POOL_ID: "local_test_pool",
    COGNITO_APP_CLIENT_ID: "localtestclient0000000000",

    // --- App / deployment. STAGE=test enables core's test-only helper
    //     endpoints, which are blocked in prod. ---
    STAGE: "test",
    NODE_ENV: "test",
    ENVIRONMENT: "dev",
    DEFAULT_REGION: "US",
    APP_DOMAIN: apiUrl,
    APP_URL: apiUrl,
    PORT: port,
    API_URL: apiUrl,

    ...opts.extra,
  };
}

/**
 * Apply the standalone env defaults to `process.env`. Idempotent, and
 * non-destructive: a key that is already set to a non-empty value is left
 * alone.
 *
 * Call this **before importing `@de-otio/trellis`**. `startStandaloneServer`
 * calls it for you and imports core afterwards; call it directly only if you
 * need the resolved values before then.
 */
export function standaloneEnv(opts: StandaloneEnvOptions = {}): ResolvedStandaloneEnv {
  for (const [key, value] of Object.entries(defaults(opts))) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  // Read the resolved values back OUT of process.env rather than returning
  // what we intended to set. "already-set wins" means an option can lose to a
  // pre-existing variable, and a return value that reported the option would
  // then be describing a server that isn't there — the caller would poll the
  // wrong port and blame the boot.
  return {
    port: process.env.PORT!,
    apiUrl: process.env.API_URL!,
    databaseUrl: process.env.DATABASE_URL!,
    dynamoTable: process.env.DYNAMODB_TABLE!,
    dynamoEndpoint: process.env.DYNAMODB_ENDPOINT!,
  };
}
