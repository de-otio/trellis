/**
 * Database Wrapper
 *
 * Wraps Prisma client with monitoring and query logging.
 *
 * Features:
 * - Connection failure monitoring
 * - Query logging (trace level only)
 * - Error handling and sanitization
 *
 * Note: Rate limiting is handled at the API level (in worker.ts), not per database operation.
 * This avoids the performance overhead of checking limits on every database call.
 */

import type { PrismaClient } from "@prisma/client";
import {
  DatabaseMonitor,
  type DatabaseMonitorEnv,
  type DatabaseQueryLog,
} from "./database-monitor.js";
import { getLogger, Logger } from "./logger.js";

export interface DatabaseWrapperEnv extends DatabaseMonitorEnv {}

export interface DatabaseWrapperOptions {
  userId?: string;
  region: string;
  operation?: string;
  request: Request;
  env: DatabaseWrapperEnv;
}

/**
 * Database wrapper that adds monitoring and logging
 *
 * Note: Rate limiting is handled at the API level, not here.
 */
export class DatabaseWrapper {
  private prisma: PrismaClient;
  private monitor: DatabaseMonitor;
  private logger: Logger;
  private region: string;

  constructor(prisma: PrismaClient, env: DatabaseWrapperEnv, region: string) {
    this.prisma = prisma;
    this.monitor = new DatabaseMonitor(env);
    this.logger = getLogger();
    this.region = region;
  }

  /**
   * Execute a database operation with monitoring and logging
   *
   * Note: Rate limiting is handled at the API level (in worker.ts), not here.
   */
  async execute<T>(
    operation: () => Promise<T>,
    options: DatabaseWrapperOptions,
  ): Promise<T> {
    const startTime = Date.now();
    const { userId, operation: opName, request, env } = options;

    try {
      // Execute operation
      const result = await operation();

      // Log query (trace level only)
      const duration = Date.now() - startTime;
      this.monitor.logQuery(
        {
          operation: opName || "unknown",
          region: this.region,
          duration,
          success: true,
          userId,
          timestamp: new Date(),
        },
        env,
      );

      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error?.message || "Unknown error";

      // Log connection failure if applicable
      if (this.isConnectionError(error)) {
        await this.monitor.logConnectionFailure(
          {
            region: this.region,
            error: errorMessage,
            operation: opName,
            userId,
            timestamp: new Date(),
          },
          env,
        );
      }

      // Log query failure (trace level only)
      this.monitor.logQuery(
        {
          operation: opName || "unknown",
          region: this.region,
          duration,
          success: false,
          error: errorMessage,
          userId,
          timestamp: new Date(),
        },
        env,
      );

      throw error;
    }
  }

  /**
   * Check if error is a connection error
   */
  private isConnectionError(error: any): boolean {
    const message = error?.message || "";
    const connectionErrorPatterns = [
      /connection.*failed/gi,
      /connection.*refused/gi,
      /timeout/gi,
      /network.*error/gi,
      /ECONNREFUSED/gi,
      /ETIMEDOUT/gi,
      /P1001/gi, // Prisma connection error code
      /P1017/gi, // Prisma server closed connection
    ];

    return connectionErrorPatterns.some((pattern) => pattern.test(message));
  }

  /**
   * Get underlying Prisma client (for direct access when needed)
   */
  getClient(): PrismaClient {
    return this.prisma;
  }
}
