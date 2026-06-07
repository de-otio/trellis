import { Logger } from "@aws-lambda-powertools/logger";
import { getSecret } from "@aws-lambda-powertools/parameters/secrets";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { DatabaseCircuitBreaker } from "./database-circuit-breaker.js";

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: string | number;
  dbname: string;
}

const logger = new Logger({ serviceName: "lambda-prisma" });

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

let prisma: PrismaClient | null = null;
let pool: Pool | null = null;

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
      logger.warn("lambda_db.breaker_open", { operation });
    }
    throw err;
  }
}

/**
 * Build (and cache) a PrismaClient for standalone Lambda handlers.
 *
 * RDS enforces `force_ssl`, so the connection MUST negotiate TLS — otherwise
 * Postgres rejects it with `28000 / no pg_hba.conf entry … no encryption`
 * (surfaced by Prisma as P1010). The request-path client gets this via
 * `DatabaseConnectionManager` (`ssl: { rejectUnauthorized: false }`); Lambda
 * handlers must do the same. Prisma 7 supplies the connection through a pg
 * driver adapter (the old `datasources` constructor option is gone), so the
 * `ssl` option and the size cap go on the pool config.
 *
 * The pool is passed to `PrismaPg` as an explicit `pg.Pool` (NOT a
 * connection-string config) because the pool is the only place `max` takes
 * effect — see the knobs comment above.
 *
 * Cached at module scope so warm invocations reuse the client (and its single
 * connection).
 */
export async function getLambdaPrisma(): Promise<PrismaClient> {
  if (prisma) return prisma;
  const { username, password, host, port, dbname } = (await getSecret(
    process.env.DB_SECRET_ARN!,
    { transform: "json" },
  )) as unknown as DbSecret;

  // When an RDS Proxy is provisioned, the infra injects its endpoint here so the
  // Lambda connects through the proxy (which multiplexes and caps the
  // connections the DB ever sees); fall back to the direct instance endpoint
  // when unset, so the default deployment is unchanged.
  const dbHost = process.env.LAMBDA_DATABASE_PROXY_HOST || host;

  pool = new Pool({
    connectionString: `postgresql://${username}:${encodeURIComponent(password)}@${dbHost}:${port}/${dbname}`,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.LAMBDA_DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX),
    connectionTimeoutMillis: Number(
      process.env.LAMBDA_DATABASE_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    allowExitOnIdle: false,
  });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
  return prisma;
}
