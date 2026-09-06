import { resolveSecret, secretRef, SecretCache } from "@de-otio/saas-foundation/secrets";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { DatabaseCircuitBreaker } from "./database-circuit-breaker.js";
import { buildDbSslOptions } from "./db-ssl.js";
import { getLogger } from "./logger.js";

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: string | number;
  dbname: string;
}

/**
 * Operational knobs — env-configurable with safe defaults (threshold-secrecy
 * rule: never compile operational limits into the public tarball).
 *
 * Why the pool MUST be capped here: each warm Lambda execution environment holds
 * its OWN pg pool, and every concurrent environment shares the RDS
 * `max_connections` budget (~107 usable on a t4g.micro). Under a signup burst —
 * or a `pre-token` cache-miss storm — an unbounded pool lets a single function
 * exhaust the instance, and Postgres then rejects connections from EVERY client
 * (a global outage, not just failed signups). `?connection_limit=1` in the
 * connection URL is a **no-op** under `@prisma/adapter-pg` (it is a Prisma-engine
 * parameter the `pg` driver ignores), so the cap is set on the pool object — the
 * only place it takes effect. See
 * trellis-internal `analysis/db-connection-management/signup-burst-connection-exhaustion.md`.
 */
const DEFAULT_POOL_MAX = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
/**
 * DB-credential cache TTL (WS-2 §5.3, finding 8a): SECONDS, not the
 * foundation SecretCache default of 300s. On Lambda this is invisible (the
 * client is module-scoped and the environment recycles), but the
 * long-running worker container would otherwise hold a rotated-away
 * password for up to the TTL. The 28P01 handler below (finding 8b) is the
 * primary self-heal; the short TTL is the backstop.
 */
const DEFAULT_DB_SECRET_CACHE_TTL_SECONDS = 30;

let prisma: PrismaClient | null = null;
let pool: Pool | null = null;
let dbSecretCache: SecretCache | null = null;

function getDbSecretCache(): SecretCache {
  if (dbSecretCache === null) {
    dbSecretCache = new SecretCache({
      ttlSeconds: Number(
        process.env.LAMBDA_DB_SECRET_CACHE_TTL_SECONDS ??
          DEFAULT_DB_SECRET_CACHE_TTL_SECONDS,
      ),
    });
  }
  return dbSecretCache;
}

/** Resolve the DB secret JSON from AWS Secrets Manager via the ONE foundation
 *  secrets port (§5.3 — the powertools secrets path is gone; three secrets paths
 *  collapsed to one). ARN path only; see `resolveDbConnectionString` for the
 *  cross-profile precedence. */
async function resolveDbSecretFromArn(fresh: boolean): Promise<DbSecret> {
  const bytes = await resolveSecret(
    secretRef(process.env.DB_SECRET_ARN!),
    { cache: getDbSecretCache() },
    { fresh },
  );
  return JSON.parse(bytes.toString("utf-8")) as DbSecret;
}

/**
 * Resolve the DB connection string for the standalone Lambda / long-running
 * worker path, portable across deployment profiles.
 *
 * Precedence MIRRORS the request-path resolver (`env.ts` `resolveDatabaseUrl`)
 * so the container consumes the SAME env the API already does — no divergent DB
 * contract between the two:
 *   1. `DATABASE_URL` — explicit (Scaleway / local); used verbatim.
 *   2. `DB_SECRET_ARN` — AWS Secrets Manager, resolved through the foundation
 *      `SecretCache` so the 28P01 rotation self-heal
 *      (`invalidateDbCredentialsOnAuthError`) re-resolves a fresh credential;
 *      honours the optional `LAMBDA_DATABASE_PROXY_HOST` (RDS Proxy) endpoint.
 *   3. Decomposed `DB_SECRET_USERNAME`/`DB_SECRET_PASSWORD`/`DB_SECRET_HOST`
 *      [`/DB_SECRET_PORT`] + `DB_NAME` — the Scaleway shape (external-secrets
 *      injects `DB_SECRET_PASSWORD`; the rest ride the app ConfigMap). This is
 *      the branch that unblocks the worker on Kapsule, where there is no AWS
 *      Secrets Manager ARN.
 * Fail-closed (throws) when none is configured — the worker's startup gate
 * turns that into a `process.exit(1)` rather than booting credential-less.
 *
 * Only the ARN branch flows through the SecretCache; the DATABASE_URL and
 * decomposed branches read process.env directly (a credential rotation on those
 * arrives via a pod restart, since env_from is snapshot at pod start).
 */
export async function resolveDbConnectionString(fresh: boolean): Promise<string> {
  // 1. Explicit URL (Scaleway / local). Used verbatim — no proxy rewrite.
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // 2. AWS Secrets Manager ARN — retains the SecretCache + rotation self-heal.
  if (process.env.DB_SECRET_ARN) {
    const { username, password, host, port, dbname } =
      await resolveDbSecretFromArn(fresh);
    // RDS Proxy endpoint override (AWS only); falls back to the direct host.
    const dbHost = process.env.LAMBDA_DATABASE_PROXY_HOST || host;
    return `postgresql://${username}:${encodeURIComponent(password)}@${dbHost}:${port}/${dbname}`;
  }

  // 3. Decomposed env (Scaleway). Validated to fail closed on partial config.
  const user = process.env.DB_SECRET_USERNAME;
  const pass = process.env.DB_SECRET_PASSWORD;
  const host = process.env.DB_SECRET_HOST;
  const port = process.env.DB_SECRET_PORT || "5432";
  const dbname = process.env.DB_NAME || "trellis";
  if (!user || !pass || !host) {
    throw new Error(
      "Database config missing: set DATABASE_URL, DB_SECRET_ARN (AWS), or DB_SECRET_USERNAME/PASSWORD/HOST (Scaleway)",
    );
  }
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error(`Invalid DB_SECRET_HOST: must match /^[\\w.-]+$/, got "${host}"`);
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid DB_SECRET_PORT: must be numeric, got "${port}"`);
  }
  if (!/^[\w-]+$/.test(dbname)) {
    throw new Error(`Invalid DB_NAME: must match /^[\\w-]+$/, got "${dbname}"`);
  }
  return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${dbname}`;
}

/** True for a Postgres invalid_password auth failure (SQLSTATE 28P01). */
export function isPgAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "28P01"
  );
}

/**
 * WS-2 finding 8b: on a Postgres auth failure, invalidate the cached secret
 * and drop the cached client, so the NEXT connection attempt re-resolves a
 * fresh credential and rebuilds the pool — a rotation self-heals in one
 * failed connection rather than one cache TTL. Safe to call with any error;
 * only 28P01 triggers the invalidation. Returns true when it invalidated.
 */
export function invalidateDbCredentialsOnAuthError(err: unknown): boolean {
  if (!isPgAuthError(err)) return false;
  getLogger().warn(
    "lambda_db.auth_failure — invalidating cached DB secret and rebuilding on next use",
  );
  getDbSecretCache().clear();
  const oldPool = pool;
  prisma = null;
  pool = null;
  if (oldPool) {
    void oldPool.end().catch(() => {
      /* best-effort teardown of the stale pool */
    });
  }
  return true;
}

/**
 * Per-execution-environment circuit breaker for the Lambda DB path.
 *
 * The request path (`DatabaseConnectionManager`) has a breaker; Lambda handlers
 * did not — so under DB saturation they would keep retrying into a saturated
 * instance and amplify the incident. Opening the breaker makes a saturated
 * environment fail fast (no connect-timeout wait, no slot held) until a cooldown
 * probe succeeds. Module scope = one warm Lambda environment, the right blast
 * radius. Wrap every RDS access in a handler with `withLambdaDbBreaker`.
 */
export const lambdaDbBreaker = new DatabaseCircuitBreaker({
  failureThreshold: Number(
    process.env.LAMBDA_DATABASE_BREAKER_THRESHOLD ?? DEFAULT_BREAKER_THRESHOLD,
  ),
  cooldownMs: Number(
    process.env.LAMBDA_DATABASE_BREAKER_COOLDOWN_MS ?? DEFAULT_BREAKER_COOLDOWN_MS,
  ),
});

/**
 * Run a unit of DB work under the Lambda circuit breaker. Use around every RDS
 * access in a Lambda handler so connection-exhaustion failures trip the breaker
 * instead of being retried into a saturated instance. When the breaker is OPEN
 * the call throws immediately (message begins "Circuit breaker is OPEN").
 * Also routes 28P01 auth failures into the credential invalidation (finding 8b).
 */
export async function withLambdaDbBreaker<T>(
  fn: () => Promise<T>,
  operation?: string,
): Promise<T> {
  try {
    return await lambdaDbBreaker.execute(fn, { operation });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("Circuit breaker is OPEN")
    ) {
      getLogger().warn("lambda_db.breaker_open", { operation });
    }
    invalidateDbCredentialsOnAuthError(err);
    throw err;
  }
}

/**
 * Build (and cache) a PrismaClient for standalone Lambda handlers (and the
 * WS-2 worker container).
 *
 * RDS enforces `force_ssl`, so the connection MUST negotiate TLS — otherwise
 * Postgres rejects it with `28000 / no pg_hba.conf entry … no encryption`
 * (surfaced by Prisma as P1010). The request-path client gets this via
 * `DatabaseConnectionManager`; Lambda handlers must do the same. Both go
 * through `buildDbSslOptions` (`db-ssl.ts`), so a configured `DB_SSL_CA`
 * turns certificate verification on for every pool at once (DP-7). Prisma 7 supplies the connection through a pg
 * driver adapter (the old `datasources` constructor option is gone), so the
 * `ssl` option and the size cap go on the pool config.
 *
 * The pool is passed to `PrismaPg` as an explicit `pg.Pool` (NOT a
 * connection-string config) because the pool is the only place `max` takes
 * effect — see the knobs comment above.
 *
 * Cached at module scope so warm invocations reuse the client (and its single
 * connection). The container sizes its pool via `LAMBDA_DATABASE_POOL_MAX`.
 */
export async function getLambdaPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  // Cross-profile credential resolution (DATABASE_URL / DB_SECRET_ARN + RDS
  // Proxy override / decomposed Scaleway env). See `resolveDbConnectionString`.
  const connectionString = await resolveDbConnectionString(false);

  pool = new Pool({
    connectionString,
    ssl: buildDbSslOptions(connectionString, process.env, (message, context) =>
      getLogger().warn(message, context),
    ),
    max: Number(process.env.LAMBDA_DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX),
    connectionTimeoutMillis: Number(
      process.env.LAMBDA_DATABASE_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    allowExitOnIdle: false,
  });
  // Finding 8b: an idle-client auth failure (rotation landed mid-run)
  // invalidates the cached secret so the next attempt rebuilds fresh.
  pool.on("error", (err) => {
    invalidateDbCredentialsOnAuthError(err);
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
  return prisma;
}
