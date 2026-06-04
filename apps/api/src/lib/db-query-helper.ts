/**
 * Database Query Helper
 *
 * Provides reusable timeout and retry logic for database queries to handle stale connections.
 * Now uses DatabaseConnectionManager for clear state management.
 *
 * Best Practices:
 * - All database queries should use this helper for consistent timeout and retry behavior
 * - Application timeout (3s for user-facing) is less than statement_timeout (15s) to fail fast
 * - Retry logic clears pools and retries once with fresh connection
 * - Graceful degradation: returns default value or throws based on context
 *
 * Usage:
 * ```typescript
 * const { sharedDatabaseConnectionManager: manager } = await import('./database-connection-manager.js');
 * const result = await withQueryTimeoutAndRetry(
 *   manager,
 *   'US',
 *   env,
 *   (client) => client.user.findUnique({ where: { id } }),
 *   { timeoutMs: 3000, retryTimeoutMs: 2000 }
 * );
 * ```
 */

import type { PrismaClient } from "@prisma/client";
import type { EnvWithDb } from "../db.js";
import { DatabaseConnectionManager } from "./database-connection-manager.js";

export interface QueryTimeoutOptions {
  /**
   * Application-level timeout in milliseconds
   * Should be less than statement_timeout (15s) to fail fast
   * Default: 3000 (3 seconds for user-facing)
   */
  timeoutMs?: number;

  /**
   * Retry timeout in milliseconds (shorter than initial timeout)
   * Default: 2000 (2 seconds)
   */
  retryTimeoutMs?: number;

  /**
   * Maximum number of retry attempts (default: 3)
   * Total attempts = 1 initial + maxRetries retries
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds for exponential backoff (default: 100ms)
   * Retry delays: baseDelayMs, baseDelayMs * 2, baseDelayMs * 4, etc.
   */
  baseDelayMs?: number;

  /**
   * Default value to return if query fails after retry
   * If not provided, error will be thrown
   */
  defaultValue?: any;

  /**
   * Context for logging (operation name, userId, etc.)
   */
  context?: {
    operation?: string;
    userId?: string;
    [key: string]: any;
  };
}

/**
 * Timeout presets for different use cases
 */
export const QueryTimeoutPresets = {
  /**
   * User-facing requests (frontend API calls)
   * CRITICAL FIX: Increased timeout based on Cloudflare logs analysis
   * Logs showed 108 query timeouts - 500ms is too aggressive
   * Queries are taking 800ms+ under load, causing premature timeouts
   * Total max wait: 4 seconds (2000ms initial + 2000ms retry)
   */
  USER_FACING: {
    timeoutMs: 2000, // Increased from 500ms to 2000ms - Cloudflare logs showed 108 query timeouts with 500ms being too aggressive
    retryTimeoutMs: 2000, // Increased from 500ms to 2000ms for retry
  },

  /**
   * Background operations (scheduled jobs, async processing)
   * Longer timeouts acceptable since not blocking user
   * Total max wait: 17 seconds (12s initial + 5s retry)
   */
  BACKGROUND: {
    timeoutMs: 12000, // 12 seconds
    retryTimeoutMs: 5000, // 5 seconds for retry
  },

  /**
   * Critical operations (auth, payments)
   * Medium timeouts with retry for reliability
   * Total max wait: 8 seconds (5s initial + 3s retry)
   */
  CRITICAL: {
    timeoutMs: 5000, // 5 seconds
    retryTimeoutMs: 3000, // 3 seconds for retry
  },

  /**
   * Standard operations (default for most queries)
   * CRITICAL FIX: Increased timeout based on Cloudflare logs analysis
   * Logs showed 108 query timeouts - 500ms is too aggressive
   * Total max wait: 4 seconds (2000ms initial + 2000ms retry)
   */
  STANDARD: {
    timeoutMs: 2000, // Increased from 500ms to 2000ms - Cloudflare logs showed 108 query timeouts with 500ms being too aggressive
    retryTimeoutMs: 2000, // Increased from 500ms to 2000ms for retry
  },
} as const;

/**
 * Execute a database query with timeout protection and retry logic for stale connections
 *
 * @param manager - DatabaseConnectionManager instance (manages state)
 * @param region - Region code ('US', 'EU', 'CN', etc.)
 * @param env - Environment variables
 * @param queryFn - Function that executes the query using the provided PrismaClient
 * @param options - Timeout and retry configuration
 * @returns Query result or default value if retry fails
 * @throws Error if query fails and no default value provided
 */
export async function withQueryTimeoutAndRetry<T>(
  manager: DatabaseConnectionManager,
  region: string,
  env: EnvWithDb,
  queryFn: (client: PrismaClient) => Promise<T>,
  options: QueryTimeoutOptions = {},
): Promise<T> {
  return manager.executeWithRetry(region, env, queryFn, options);
}

/**
 * Execute a database query with timeout protection only (no retry)
 * Use this for queries that should fail fast without retry
 *
 * @param queryFn - Function that returns a Promise for the database query
 * @param timeoutMs - Timeout in milliseconds (default: 12000)
 * @returns Query result
 * @throws Error if query times out
 */
export async function withQueryTimeout<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = 12000,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("Database query timeout"));
    }, timeoutMs);
  });

  return await Promise.race([queryFn(), timeoutPromise]);
}
