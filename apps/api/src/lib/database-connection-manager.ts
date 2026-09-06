/**
 * Database Connection Manager
 *
 * Manages persistent, process-level connection pools for ECS Fargate.
 * One pg.Pool per unique connection string (region), reused across all requests.
 * Pool size is configurable via DATABASE_POOL_MAX (default 10).
 *
 * See: doc/plans/002-database-connections-and-cloudflare-cleanup.md
 * See: doc/02-technical/development/misc/aws-ecs-database-connections.md
 */


import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import { Pool } from "pg";
import { DatabaseCircuitBreaker } from "./database-circuit-breaker.js";
import { buildDbSslOptions } from "./db-ssl.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { redactConnectionString } from "./redact-connection-string.js";
import { resolveTenantScopeMode, tenantScopeExtension } from "./tenant-scope.js";
import {
  getPerformanceMetricsCollector,
  type ConnectionPoolMetrics,
} from "./performance-metrics.js";
export interface EnvWithDb {
  DATABASE_URL: string;
  DATABASE_URL_CN?: string;
  LOG_LEVEL?: string;
  DATABASE_POOL_MAX?: string;
  DATABASE_POOL_MIN?: string;
  DATABASE_CONNECTION_TIMEOUT_MS?: string;
  /** DB TLS (DP-7): CA to verify the server against — see `db-ssl.ts`. */
  DB_SSL_CA?: string;
  DB_SSL_CA_PATH?: string;
  DATABASE_STATEMENT_TIMEOUT_MS?: string;
  DATABASE_IDLE_TIMEOUT_MS?: string;
}

type ManagedClient = {
  client: PrismaClient;
  cleanup: () => Promise<void>;
};

type CachedPool = {
  pool: Pool;
  client: PrismaClient;
  region: string;
  createdAt: number;
};

export class DatabaseConnectionManager {
  private logger: Logger;
  private poolCache: Map<string, CachedPool> = new Map();

  /**
   * Per-region circuit breakers. Keyed by region so one region's outage
   * does not trip another's. Wraps the whole retry sequence in
   * executeWithRetry so a sustained database outage opens the circuit and
   * subsequent calls fail fast instead of retry-storming.
   */
  private circuitBreakers: Map<string, DatabaseCircuitBreaker> = new Map();

  private readonly DEFAULT_CONNECTION_TIMEOUT_MS = 3000;
  private readonly DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
  private readonly DEFAULT_POOL_MAX = 10;
  private readonly DEFAULT_POOL_MIN = 2; // keep ≥2 warm connections so the hot path never cold-starts
  // 10 min. The previous 30s closed every connection during quiet periods, so the
  // next request re-paid pool-init + TLS-handshake cost. For a small, long-lived
  // ECS fleet we want connections to stay warm; override with DATABASE_IDLE_TIMEOUT_MS.
  private readonly DEFAULT_IDLE_TIMEOUT_MS = 600000;

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Drain and close all cached pools. Call on SIGTERM for graceful shutdown.
   */
  async shutdown(): Promise<void> {
    this.logger.info("[DatabaseConnectionManager] Shutting down all connection pools", {
      poolCount: this.poolCache.size,
    });
    for (const [key, cached] of this.poolCache) {
      try {
        await cached.client.$disconnect();
      } catch (err: any) {
        this.logger.warn("[DatabaseConnectionManager] Error disconnecting Prisma client during shutdown", {
          key, error: err?.message,
        });
      }
      try {
        await cached.pool.end();
      } catch (err: any) {
        this.logger.warn("[DatabaseConnectionManager] Error ending pool during shutdown", {
          key, error: err?.message,
        });
      }
    }
    this.poolCache.clear();
  }

  /**
   * Drain all cached pools and clear the cache. Pools will be recreated on next use.
   */
  clearPools(): void {
    this.logger.debug("[DatabaseConnectionManager] clearPools called", {
      poolCount: this.poolCache.size,
    });
    // Fire-and-forget shutdown of existing pools
    for (const [, cached] of this.poolCache) {
      cached.client.$disconnect().catch(() => {});
      cached.pool.end().catch(() => {});
    }
    this.poolCache.clear();
  }

  /**
   * Return real stats from all cached pools.
   */
  getPoolStatus(): Array<{
    key: string;
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    age: number;
    errorCount: number;
  }> {
    const now = Date.now();
    return Array.from(this.poolCache.entries()).map(([key, cached]) => ({
      key,
      totalCount: cached.pool.totalCount,
      idleCount: cached.pool.idleCount,
      waitingCount: cached.pool.waitingCount,
      age: now - cached.createdAt,
      errorCount: 0,
    }));
  }

  /**
   * Log connection pool statistics and alert if pool is exhausted.
   * PHASE 2: Connection Pool Monitoring
   */
  private logPoolStats(region: string, pool: Pool): void {
    try {
      const stats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: (pool as any).options?.max ?? this.DEFAULT_POOL_MAX,
      };

      this.logger.debug("[DatabaseConnectionManager] Pool stats", {
        region,
        ...stats,
      });

      // Record connection pool metric
      const metricsCollector = getPerformanceMetricsCollector();
      const poolMetric: ConnectionPoolMetrics = {
        region,
        total: stats.total,
        idle: stats.idle,
        waiting: stats.waiting,
        timestamp: Date.now(),
      };
      metricsCollector.recordConnectionPoolMetric(poolMetric);

      // Alert if pool is exhausted (waiting connections)
      if (stats.waiting > 0) {
        this.logger.warn("[DatabaseConnectionManager] Connections waiting", {
          region,
          waiting: stats.waiting,
          total: stats.total,
          idle: stats.idle,
          max: stats.max,
        });
      }

      // Alert if pool is at capacity and no idle connections
      if (stats.total >= stats.max && stats.idle === 0 && stats.waiting > 0) {
        this.logger.error(
          "[DatabaseConnectionManager] Pool exhausted - all connections in use",
          {
            region,
            total: stats.total,
            idle: stats.idle,
            waiting: stats.waiting,
            max: stats.max,
          },
        );
      }
    } catch (error: any) {
      // Don't fail if pool stats logging fails
      this.logger.debug(
        "[DatabaseConnectionManager] Failed to log pool stats",
        {
          region,
          error: error?.message,
        },
      );
    }
  }

  private addQueryParam(
    connectionString: string,
    param: string,
    value: string,
  ): string {
    try {
      const url = new URL(connectionString);
      url.searchParams.set(param, value);
      return url.toString();
    } catch {
      const separator = connectionString.includes("?") ? "&" : "?";
      return `${connectionString}${separator}${param}=${value}`;
    }
  }

  private resolveConnectionStrings(region: string, env: EnvWithDb) {
    // AWS/ECS: Use DATABASE_URL directly (no Hyperdrive or PostgREST needed)
    const base = env.DATABASE_URL;

    if (!base || typeof base !== "string") {
      throw new Error(
        `CRITICAL: DATABASE_URL is required but not available. Region: ${region}`,
      );
    }

    // Verify it's a PostgreSQL connection string
    if (!base.startsWith("postgresql://") && !base.startsWith("postgres://")) {
      throw new Error(
        `CRITICAL: DATABASE_URL is not a valid PostgreSQL connection string. ` +
          `Expected format starting with postgresql:// or postgres://, ` +
          `Got: ${redactConnectionString(base)}`,
      );
    }

    // Redacted, never a prefix: a libpq URI carries the password right after
    // the user name, so `substring(0, 50)` of a real DATABASE_URL was the user
    // and the first characters of the password (seen live, 2026-09-05).
    this.logger.debug(
      "[DatabaseConnectionManager] Using DATABASE_URL connection string",
      {
        region,
        connectionString: redactConnectionString(base),
      },
    );

    const statementTimeout = env.DATABASE_STATEMENT_TIMEOUT_MS
      ? parseInt(env.DATABASE_STATEMENT_TIMEOUT_MS, 10)
      : this.DEFAULT_STATEMENT_TIMEOUT_MS;

    const connectionTimeout = env.DATABASE_CONNECTION_TIMEOUT_MS
      ? parseInt(env.DATABASE_CONNECTION_TIMEOUT_MS, 10)
      : this.DEFAULT_CONNECTION_TIMEOUT_MS;

    const connectionString = this.addQueryParam(
      base,
      "statement_timeout",
      statementTimeout.toString(),
    );

    return {
      connectionString,
      connectionTimeout,
      statementTimeout,
    };
  }

  /**
   * Invalidate a cached pool (e.g., after unrecoverable connection errors).
   * The pool will be recreated on next acquireClient() call.
   */
  /**
   * Get (or lazily create) the circuit breaker for a region.
   *
   * Defaults: opens after 5 consecutive failed query sequences, with a 30s
   * cooldown before a recovery probe. The threshold counts whole
   * executeWithRetry sequences (not individual attempts), since the breaker
   * wraps the retry loop — so a single transient blip that recovers on retry
   * does not move the breaker toward OPEN.
   */
  private getCircuitBreaker(region: string): DatabaseCircuitBreaker {
    let breaker = this.circuitBreakers.get(region);
    if (!breaker) {
      breaker = new DatabaseCircuitBreaker(
        { failureThreshold: 5, cooldownMs: 30000 },
        this.logger,
      );
      this.circuitBreakers.set(region, breaker);
    }
    return breaker;
  }

  private invalidatePool(cacheKey: string): void {
    const cached = this.poolCache.get(cacheKey);
    if (cached) {
      this.logger.warn("[DatabaseConnectionManager] Invalidating pool", { key: cacheKey });
      cached.client.$disconnect().catch(() => {});
      cached.pool.end().catch(() => {});
      this.poolCache.delete(cacheKey);
    }
  }

  /**
   * Acquire a Prisma client backed by a persistent, shared connection pool.
   * The pool is created on first use and cached for the process lifetime.
   * The returned cleanup function is a no-op — pool lifecycle is managed by shutdown().
   */
  acquireClient(region: string, env: EnvWithDb): ManagedClient {
    const resolved = this.resolveConnectionStrings(region, env);
    const cacheKey = resolved.connectionString;

    // Return cached pool if available
    const cached = this.poolCache.get(cacheKey);
    if (cached) {
      this.logger.debug("[DatabaseConnectionManager] Reusing cached pool", {
        region,
        poolTotal: cached.pool.totalCount,
        poolIdle: cached.pool.idleCount,
        poolWaiting: cached.pool.waitingCount,
      });
      return { client: cached.client, cleanup: async () => {} };
    }

    // Create new pool
    const poolMax = env.DATABASE_POOL_MAX
      ? parseInt(env.DATABASE_POOL_MAX, 10)
      : this.DEFAULT_POOL_MAX;
    const poolMin = env.DATABASE_POOL_MIN
      ? parseInt(env.DATABASE_POOL_MIN, 10)
      : this.DEFAULT_POOL_MIN;
    const idleTimeout = env.DATABASE_IDLE_TIMEOUT_MS
      ? parseInt(env.DATABASE_IDLE_TIMEOUT_MS, 10)
      : this.DEFAULT_IDLE_TIMEOUT_MS;

    this.logger.info("[DatabaseConnectionManager] Creating persistent connection pool", {
      region,
      maxConnections: poolMax,
      minConnections: poolMin,
      idleTimeoutMs: idleTimeout,
      connectionTimeoutMs: resolved.connectionTimeout,
      connectionString: redactConnectionString(resolved.connectionString),
    });

    // TLS posture is decided in one place (`db-ssl.ts`): local hosts get no
    // TLS, a configured CA gets full verification, and the unverified legacy
    // mode survives only with a boot-time warning (security deep pass DP-7).
    const ssl = buildDbSslOptions(
      resolved.connectionString,
      env,
      (message, context) => this.logger.warn(message, context),
    );

    const pool = new Pool({
      connectionString: resolved.connectionString,
      max: poolMax,
      // Keep a warm floor of connections so the request hot-path never pays
      // cold-start (pool-init + TLS handshake) latency. Pair with warmup() at
      // boot, which opens these eagerly rather than on first query.
      min: poolMin,
      connectionTimeoutMillis: resolved.connectionTimeout,
      idleTimeoutMillis: idleTimeout,
      // TCP keepalive so long-idle connections aren't silently dropped by the
      // network/RDS between bursts (avoids handing out a half-dead connection).
      keepAlive: true,
      allowExitOnIdle: false,
      ssl,
    });

    pool.on("error", (err) => {
      this.logger.error(
        "[DatabaseConnectionManager] Database connection pool error",
        {
          region,
          error: err.message,
          code: (err as any)?.code,
        },
      );
    });

    pool.on("connect", (client) => {
      this.logger.debug("[DatabaseConnectionManager] Client connected", {
        region,
        processId: (client as any)?.processID,
      });
    });

    pool.on("acquire", () => {
      this.logPoolStats(region, pool);
    });

    pool.on("remove", () => {
      this.logPoolStats(region, pool);
    });

    const adapter = new PrismaPg(pool);
    const baseClient = new PrismaClient({ adapter });
    // WS2 (multi-tenancy, doc/14): attach the tenant-scope extension to the
    // request-path client. Default "off" (no-op); "shadow" logs unscoped
    // queries; "enforce" injects the active-tenant filter. The lambda/cron
    // clients are intentionally NOT extended — they run system/cross-tenant work.
    const scopeMode = resolveTenantScopeMode();
    if (scopeMode === "enforce") {
      this.logger.warn(
        "[tenant-scope] enforce mode active — PARTIAL isolation only. Unique-id " +
          "reads/writes, raw SQL, and by-relation models rely on the PostgreSQL " +
          "RLS backstop (WS3), which must be deployed before this is the sole " +
          "isolation mechanism. See doc/14-multi-tenancy.",
        { region },
      );
    }
    const client: PrismaClient =
      scopeMode === "off"
        ? baseClient
        : (baseClient.$extends(
            tenantScopeExtension(scopeMode),
          ) as unknown as PrismaClient);

    this.poolCache.set(cacheKey, {
      pool,
      client,
      region,
      createdAt: Date.now(),
    });

    this.logPoolStats(region, pool);

    // No-op cleanup — pool lifecycle managed by shutdown()
    return { client, cleanup: async () => {} };
  }

  /**
   * Run a callback with a managed client that is always cleaned up.
   */
  async withClient<T>(
    region: string,
    env: EnvWithDb,
    fn: (client: PrismaClient) => Promise<T>,
  ): Promise<T> {
    const { client, cleanup } = this.acquireClient(region, env);
    try {
      return await fn(client);
    } finally {
      await cleanup();
    }
  }

  /**
   * Warm the primary connection pool at process startup so the first real
   * request does not pay pool-init + TLS-handshake latency. Eagerly opens up to
   * `min` connections and validates each with `SELECT 1`.
   *
   * Best-effort and non-fatal: a transient DB blip at boot must not stop the
   * server from starting — the pool then warms on first use, protected by the
   * connection-aware operation-timeout floor in executeWithRetry.
   */
  async warmup(region: string, env: EnvWithDb): Promise<void> {
    try {
      // Create + cache the pool (no query yet).
      this.acquireClient(region, env);
      const resolved = this.resolveConnectionStrings(region, env);
      const cached = this.poolCache.get(resolved.connectionString);
      if (!cached) return;

      const poolMin = env.DATABASE_POOL_MIN
        ? parseInt(env.DATABASE_POOL_MIN, 10)
        : this.DEFAULT_POOL_MIN;

      // Open `min` physical connections concurrently, validate, then release
      // them back to the pool as idle (kept warm by min + idleTimeout).
      const clients = await Promise.all(
        Array.from({ length: Math.max(1, poolMin) }, () => cached.pool.connect()),
      );
      try {
        await Promise.all(clients.map((c) => c.query("SELECT 1")));
      } finally {
        clients.forEach((c) => c.release());
      }

      this.logger.info("[DatabaseConnectionManager] Pool warmed at startup", {
        region,
        warmed: clients.length,
        poolTotal: cached.pool.totalCount,
        poolIdle: cached.pool.idleCount,
      });
    } catch (err: any) {
      this.logger.warn(
        "[DatabaseConnectionManager] Pool warmup failed (non-fatal; will warm on first use)",
        { region, error: err?.message || String(err) },
      );
    }
  }

  /**
   * Execute a query with retry and timeout, owning the client lifecycle.
   */
  async executeWithRetry<T>(
    region: string,
    env: EnvWithDb,
    queryFn: (client: PrismaClient) => Promise<T>,
    options: {
      timeoutMs?: number;
      retryTimeoutMs?: number;
      maxRetries?: number;
      baseDelayMs?: number;
      defaultValue?: T;
      context?: Record<string, any>;
    } = {},
  ): Promise<T> {
    const {
      timeoutMs = 2000,
      retryTimeoutMs = 500,
      maxRetries = 1,
      baseDelayMs = 100,
      defaultValue,
      context = {},
    } = options;

    // Acquire client once — shared pool, reused across retries
    let client: PrismaClient;
    let cacheKey: string;
    let connectionTimeoutMs = this.DEFAULT_CONNECTION_TIMEOUT_MS;
    let statementTimeoutMs = this.DEFAULT_STATEMENT_TIMEOUT_MS;
    try {
      const resolved = this.resolveConnectionStrings(region, env);
      cacheKey = resolved.connectionString;
      connectionTimeoutMs = resolved.connectionTimeout;
      statementTimeoutMs = resolved.statementTimeout;
      const result = this.acquireClient(region, env);
      client = result.client;
    } catch (error: any) {
      this.logger.error(
        "[DatabaseConnectionManager] CRITICAL: Failed to acquire database connection",
        { region, error: error?.message, ...context },
      );
      throw error;
    }

    const runAttempt = async (attemptTimeout: number) => {
      const attemptStartTime = Date.now();

      this.logger.debug("[DatabaseConnectionManager] Starting query attempt", {
        region,
        timeoutMs: attemptTimeout,
        ...context,
      });

      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.logger.warn(
            "[DatabaseConnectionManager] Query timeout triggered",
            { region, timeoutMs: attemptTimeout, ...context },
          );
          reject(new Error(`Database query timeout after ${attemptTimeout}ms`));
        }, attemptTimeout);
      });

      try {
        const queryStartTime = Date.now();
        const result = await Promise.race([queryFn(client), timeoutPromise]);
        const queryDuration = Date.now() - queryStartTime;

        this.logger.debug(
          "[DatabaseConnectionManager] Query completed successfully",
          { region, durationMs: queryDuration, ...context },
        );
        const attemptDuration = Date.now() - attemptStartTime;
        if (attemptDuration > 1000) {
          this.logger.warn("[DatabaseConnectionManager] Slow query detected", {
            durationMs: attemptDuration,
            timeoutMs: attemptTimeout,
            ...context,
          });
        }
        return result as T;
      } catch (error: any) {
        const attemptDuration = Date.now() - attemptStartTime;
        const errorMessage = error?.message || String(error);
        const errorCode = (error as any)?.code;

        const isConnectionError =
          errorMessage.toLowerCase().includes("connection") ||
          errorMessage.toLowerCase().includes("econnrefused") ||
          errorMessage.toLowerCase().includes("etimedout") ||
          errorMessage.toLowerCase().includes("econnreset") ||
          errorMessage.toLowerCase().includes("memory access out of bounds") ||
          errorCode === "ECONNREFUSED" ||
          errorCode === "ETIMEDOUT" ||
          errorCode === "ECONNRESET";

        if (isConnectionError) {
          this.logger.error(
            "[DatabaseConnectionManager] Connection error — invalidating pool",
            { durationMs: attemptDuration, error: errorMessage, region, ...context },
          );
          // Invalidate the broken pool so next retry creates a fresh one
          this.invalidatePool(cacheKey);
          const result = this.acquireClient(region, env);
          client = result.client;
        }
        throw error;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };

    let lastError: any;

    const isConnectionLikeError = (error: any) => {
      const message = (error?.message || String(error) || "").toLowerCase();
      return (
        message.includes("connection") ||
        message.includes("timeout exceeded when trying to connect") ||
        message.includes("econnrefused") ||
        message.includes("etimedout") ||
        message.includes("enotfound") ||
        message.includes("econnreset") ||
        message.includes("memory access out of bounds") || // PrismaPg adapter error from stale connections
        (error?.code &&
          typeof error.code === "string" &&
          error.code.startsWith("08"))
      );
    };

    const isConfigError = (error: any) => {
      const message = (error?.message || String(error) || "").toLowerCase();
      return (
        message.includes("database_url is required") ||
        message.includes("database_url is not a valid postgresql")
      );
    };

    // Floor every attempt's timeout so the operation budget always covers a
    // worst-case cold path: establishing a connection (connectionTimeoutMs) AND
    // running a full-length statement (statement_timeout, the inner server-side
    // guard). The prior defaults inverted this — a 2000ms op timeout under a
    // 3000ms connect timeout meant a cold connection was killed before it could
    // even open. The app timeout must be the OUTER guard, statement_timeout the
    // inner one. (Callers' shorter timeouts are intentionally raised, not lowered.)
    const minAttemptTimeoutMs = connectionTimeoutMs + statementTimeoutMs;
    const attemptTimeouts = [timeoutMs, retryTimeoutMs, retryTimeoutMs]
      .slice(0, maxRetries + 1)
      .map((t) => Math.max(t, minAttemptTimeoutMs));

    // The retry sequence. Non-retryable errors (config / permanent failures)
    // are returned as a `nonRetryable` outcome rather than thrown, so the
    // circuit breaker (which treats every throw as a failure) does NOT count
    // them toward opening the circuit — a burst of unique-constraint or
    // validation errors is not a database outage and must not fail-fast
    // healthy queries. Retryable failures that exhaust all attempts are
    // thrown, so a sustained outage DOES move the breaker toward OPEN.
    type RetryOutcome =
      | { kind: "ok"; value: T }
      | { kind: "nonRetryable"; error: any };

    const runRetrySequence = async (): Promise<RetryOutcome> => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const attemptTimeout = attemptTimeouts[attempt] ?? retryTimeoutMs;
        try {
          const result = await runAttempt(attemptTimeout);
          if (attempt > 0) {
            this.logger.info("[DatabaseConnectionManager] Retry succeeded", {
              attempt,
              ...context,
            });
          }
          return { kind: "ok", value: result };
        } catch (error: any) {
          lastError = error;

          // CRITICAL: If database config is fundamentally wrong, don't retry
          if (isConfigError(error)) {
            this.logger.error(
              "[DatabaseConnectionManager] CRITICAL: Database configuration error - not retrying",
              {
                error: error?.message || String(error),
                region,
                ...context,
              },
            );
            return { kind: "nonRetryable", error }; // Fail immediately, no retries
          }

          // PHASE 4: Don't retry on permanent failures (database constraint errors, validation errors)
          // These are not transient and retrying won't help
          const isPermanentFailure = this.isPermanentFailure(error);
          if (isPermanentFailure) {
            this.logger.warn(
              "[DatabaseConnectionManager] Permanent failure detected - not retrying",
              {
                error: error?.message || String(error),
                errorCode: (error as any)?.code,
                region,
                ...context,
              },
            );
            return { kind: "nonRetryable", error }; // Fail immediately, no retries
          }

          const isConnectionError = isConnectionLikeError(error);
          const errorMessage = error?.message || String(error);

          this.logger.error("[DatabaseConnectionManager] Attempt failed", {
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            error: errorMessage,
            errorCode: (error as any)?.code,
            isConnectionError,
            region,
            ...context,
          });

          if (attempt === maxRetries) {
            break;
          }

          // For connection errors (especially "memory access out of bounds"),
          // use longer delay to allow connection state to settle
          const delayMs = isConnectionError
            ? Math.max(baseDelayMs * Math.pow(2, attempt), 200) // At least 200ms for connection errors
            : baseDelayMs * Math.pow(2, attempt);

          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Retryable failures exhausted — throw so the breaker records a failure.
      throw new Error(
        `Database query failed after ${maxRetries} retries: ${
          lastError?.message || lastError
        }`,
      );
    };

    // Wrap the whole retry sequence in the per-region circuit breaker. The
    // breaker sits AROUND the retry loop (not inside it) so we never retry
    // into an open circuit, and so a single open-circuit rejection — not N
    // retry attempts — is what callers see during an outage.
    const breaker = this.getCircuitBreaker(region);
    let outcome: RetryOutcome;
    try {
      outcome = await breaker.execute(() => runRetrySequence(), {
        region,
        ...context,
      });
    } catch (error: any) {
      const message = error?.message || String(error);

      // Circuit is OPEN (fail-fast) or the retry sequence threw after
      // exhausting retryable attempts. Honor defaultValue if present.
      if (defaultValue !== undefined) {
        this.logger.warn(
          message.startsWith("Circuit breaker is OPEN")
            ? "[DatabaseConnectionManager] Returning default value (circuit OPEN)"
            : "[DatabaseConnectionManager] Returning default value after retries exhausted",
          {
            maxRetries,
            error: message,
            region,
            ...options.context,
          },
        );
        return defaultValue;
      }
      throw error;
    }

    if (outcome.kind === "nonRetryable") {
      // Non-retryable error: surfaced to the caller unchanged (and did not
      // count against the breaker). Honor defaultValue for parity with the
      // previous behavior is intentionally NOT done here — config/permanent
      // failures always threw before, and continue to throw.
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * Check if error is a permanent failure that shouldn't be retried
   * PHASE 4: Don't retry on database constraint errors, validation errors, etc.
   */
  private isPermanentFailure(error: any): boolean {
    const errorCode = (error as any)?.code;
    const errorMessage = (error?.message || String(error)).toLowerCase();

    // Prisma error codes for permanent failures
    // P2002: Unique constraint violation
    // P2025: Record not found (for updates/deletes)
    // P2003: Foreign key constraint violation
    // P2011: Null constraint violation
    // P2012: Required value missing
    if (
      errorCode === "P2002" || // Unique constraint
      errorCode === "P2025" || // Record not found
      errorCode === "P2003" || // Foreign key constraint
      errorCode === "P2011" || // Null constraint
      errorCode === "P2012" // Required value missing
    ) {
      return true;
    }

    // Check for database trigger/constraint errors
    // PostgreSQL constraint violations
    if (
      errorMessage.includes("unique constraint") ||
      errorMessage.includes("foreign key constraint") ||
      errorMessage.includes("check constraint") ||
      errorMessage.includes("not null constraint") ||
      errorMessage.includes("violates check constraint") ||
      errorMessage.includes("violates unique constraint") ||
      errorMessage.includes("violates foreign key constraint")
    ) {
      return true;
    }

    // Check for validation trigger errors (from validate_follow_target_trigger, etc.)
    if (
      errorMessage.includes("validation failed") ||
      errorMessage.includes("target does not exist") ||
      errorMessage.includes("invalid target type") ||
      errorMessage.includes("privacy settings prevent")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Backward-compatible creation helper.
   * Returns a managed client that should be paired with release() in callers.
   */
  async createClient(region: string, env: EnvWithDb): Promise<ManagedClient> {
    return this.acquireClient(region, env);
  }
}

export const sharedDatabaseConnectionManager = new DatabaseConnectionManager();

/**
 * Run `fn` inside a Prisma transaction scoped to the ambient tenant (P3 of the
 * multi-tenancy plan, doc/14). Reads the active tenant from foundation's ALS
 * (`getCurrentTenantId`, set by the auth seam — WS1) and, as the first
 * statement of the transaction, sets the PostgreSQL GUC `app.current_tenant`
 * that RLS policies (WS3/P4) read.
 *
 * - **Fail closed:** if there is no ambient tenant, this throws before opening
 *   any transaction. A query that should be tenant-scoped must never run
 *   without a tenant, so callers cannot accidentally bypass RLS.
 * - **Transaction-local GUC:** `set_config(..., true)` sets the value only for
 *   the duration of this transaction (the `is_local = true` argument). This is
 *   safe under transaction-mode connection poolers (e.g. PgBouncer/RDS Proxy),
 *   where a session is reused across tenants between transactions. Validated on
 *   real RDS PostgreSQL 16.9 (P0 spike).
 * - **Do NOT use session-level `SET`:** a session-scoped `SET app.current_tenant`
 *   would leak the value to the next request that reuses the pooled connection,
 *   defeating isolation.
 *
 * Not yet wired into any request path — activation (routing request DB access
 * through this) lands with P4/RLS.
 */
export async function withTenantTx<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const tid = getCurrentTenantId();
  if (!tid) throw new Error("withTenantTx: no tenant context");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tid}, true)`;
    return fn(tx);
  });
}
