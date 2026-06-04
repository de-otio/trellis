/**
 * Orphaned Media Health Check Routes
 *
 * Provides health monitoring endpoints for the orphaned media cleanup system.
 * Used by monitoring tools to verify cleanup jobs are running correctly.
 */

import { getLogger, Logger } from "../logger.js";
import { OrphanedMediaMonitor } from "../scheduled/orphaned-media-monitor.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

/**
 * GET /api/admin/orphaned-media/health
 *
 * Returns health status of orphaned media cleanup system.
 * Checks:
 * - Last run time (should run daily)
 * - Error rates (should be low)
 * - Backlog size (should not grow indefinitely)
 *
 * Response:
 * {
 *   healthy: boolean,
 *   lastRun: string | null,
 *   hoursSinceLastRun: number | null,
 *   backlogEstimate: number,
 *   errorRate: number,
 *   issues: string[]
 * }
 */
async function getHealthStatus(request: Request, env: any): Promise<Response> {
  const logger = getLogger();
  const securityHeaders = new SecurityHeaders(env);

  try {
    const monitor = new OrphanedMediaMonitor(env);
    const health = await monitor.checkHealth(env);

    // Return appropriate status code based on health
    const statusCode = health.healthy ? 200 : 503;

    return securityHeaders.createSecureResponse(
      JSON.stringify(health, null, 2),
      {
        status: statusCode,
        headers: {
          "content-type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  } catch (error: any) {
    logger.error("[OrphanedMediaHealth] Health check failed", {
      error: error.message,
    });

    return securityHeaders.createSecureResponse(
      JSON.stringify({
        healthy: false,
        error: "Health check failed",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

/**
 * GET /api/admin/orphaned-media/backlog
 *
 * Returns current backlog size by querying database.
 * More expensive than health check, use sparingly.
 *
 * Response:
 * {
 *   orphanedCount: number,      // Ready for soft delete
 *   softDeletedCount: number,   // Ready for R2 deletion
 *   timestamp: string
 * }
 */
async function getBacklogSize(request: Request, env: any): Promise<Response> {
  const logger = getLogger();
  const securityHeaders = new SecurityHeaders(env);

  try {
    const monitor = new OrphanedMediaMonitor(env);
    const backlog = await monitor.getBacklogSize(env);

    return securityHeaders.createSecureResponse(
      JSON.stringify(
        {
          ...backlog,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  } catch (error: any) {
    logger.error("[OrphanedMediaHealth] Backlog check failed", {
      error: error.message,
    });

    return securityHeaders.createSecureResponse(
      JSON.stringify({
        error: "Backlog check failed",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

export const orphanedMediaHealthRoutes: Route[] = [
  {
    path: "/api/admin/orphaned-media/health",
    method: "GET",
    handler: getHealthStatus,
    middleware: [],
    description: "Get orphaned media cleanup health status",
  },
  {
    path: "/api/admin/orphaned-media/backlog",
    method: "GET",
    handler: getBacklogSize,
    middleware: [],
    description: "Get orphaned media backlog size",
  },
];
