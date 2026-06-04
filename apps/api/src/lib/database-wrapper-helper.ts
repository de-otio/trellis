/**
 * Database Wrapper Helper
 *
 * Provides seamless integration of database monitoring and logging
 * without requiring changes to existing database call patterns.
 *
 * Performance Considerations:
 * - Monitoring: Minimal overhead (<1ms) for logging
 * - Query logging: Only at TRACE level, zero overhead in production
 *
 * Note: Rate limiting is handled at the API level (in worker.ts), not per database operation.
 *
 * Usage:
 * ```typescript
 * const db = getWrappedDatabase(region, env, request, userId);
 * // Use db normally - all operations are automatically monitored
 * const user = await db.user.findUnique({ where: { id } });
 * ```
 */

import type { PrismaClient } from "@prisma/client";
import { createPrismaForRegion, type EnvWithDb } from "../db.js";
import { DatabaseWrapper, type DatabaseWrapperEnv } from "./database-wrapper.js";

/**
 * Get a wrapped database client with monitoring and logging
 *
 * Performance: Creates fresh Prisma clients per request to follow Hyperdrive best practices
 *
 * Note: Rate limiting is handled at the API level, not here.
 *
 * @param region - Region code ('US', 'EU', 'CN')
 * @param env - Environment variables
 * @param request - Request object (for monitoring context)
 * @param userId - Optional user ID (for monitoring context)
 * @returns Wrapped Prisma client that automatically monitors operations
 */
export function getWrappedDatabase(
  region: string,
  env: DatabaseWrapperEnv,
  request: Request,
  userId?: string,
): PrismaClient {
  // Always create a fresh Prisma client per request to avoid stale connections
  const prisma = createPrismaForRegion(region, env);
  const wrapper = new DatabaseWrapper(prisma, env, region);
  return createDatabaseProxy(wrapper, env, request, userId, region);
}

/**
 * Create a proxy that intercepts Prisma operations
 *
 * This allows existing code to use the database normally while adding
 * monitoring and logging transparently.
 */
function createDatabaseProxy(
  wrapper: DatabaseWrapper,
  env: DatabaseWrapperEnv,
  request: Request,
  userId: string | undefined,
  region: string,
): PrismaClient {
  const prisma = wrapper.getClient();

  // Create a proxy that intercepts method calls
  return new Proxy(prisma, {
    get(target, prop) {
      const value = (target as any)[prop];

      // If it's a model (user, post, etc.), wrap its methods
      if (
        typeof value === "object" &&
        value !== null &&
        prop !== "$connect" &&
        prop !== "$disconnect"
      ) {
        return createModelProxy(
          value,
          wrapper,
          env,
          request,
          userId,
          prop as string,
          region,
        );
      }

      // For other properties (like $transaction, $queryRaw), return as-is
      // These are handled separately if needed
      return value;
    },
  }) as PrismaClient;
}

/**
 * Create a proxy for a Prisma model (user, post, etc.)
 */
function createModelProxy(
  model: any,
  wrapper: DatabaseWrapper,
  env: DatabaseWrapperEnv,
  request: Request,
  userId: string | undefined,
  modelName: string,
  region: string,
): any {
  return new Proxy(model, {
    get(target, prop) {
      const method = target[prop];

      // If it's a function (findUnique, findMany, create, update, etc.), wrap it
      if (typeof method === "function") {
        return async (...args: any[]) => {
          // Extract operation name from method name
          const operation = `${modelName}.${String(prop)}`;

          return wrapper.execute(() => method.apply(target, args), {
            region,
            operation,
            request,
            userId,
            env,
          });
        };
      }

      return method;
    },
  });
}

/**
 * Get unwrapped database client (for internal operations that don't need monitoring)
 *
 * Use this sparingly - only for operations that should bypass monitoring
 * (e.g., health checks, admin operations)
 */
export function getUnwrappedDatabase(
  region: string,
  env: EnvWithDb,
): PrismaClient {
  return createPrismaForRegion(region, env);
}
