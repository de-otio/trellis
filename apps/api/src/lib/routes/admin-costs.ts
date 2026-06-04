/**
 * Admin Cost Status Route
 *
 * Exposes cost protection status to SUPER_ADMIN users.
 */

import { createPrisma } from "../../db.js";
import { addCorsHeaders } from "../../worker.js";
import { CostAccumulator } from "../cost-accumulator.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { OpenAiBudget, type OpenAiBudgetConfig } from "../openai-budget.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

/** Cache cost data in-memory for 30 seconds per ECS task. */
let cachedStatus: { data: any; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export const adminCostRoutes: Route[] = [
  {
    path: "/api/admin/costs",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Authenticate
      const sessionManager = new SessionManager();
      const sessionSecret = env.SESSION_SECRET;
      const session = await sessionManager.getSession(request, sessionSecret, env as any);

      if (!session) {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }

      // Check SUPER_ADMIN role
      const db = createPrisma(env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || user.role !== "SUPER_ADMIN") {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Super-admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }

      // Return cached data if fresh
      if (cachedStatus && Date.now() - cachedStatus.fetchedAt < CACHE_TTL_MS) {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify(cachedStatus.data),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }

      try {
        const budgetConfig: OpenAiBudgetConfig = {
          enabled: (env as any).OPENAI_BUDGET_ENABLED !== "false",
          maxRequestsPerHour: parseInt((env as any).OPENAI_BUDGET_HOURLY_MAX || "500", 10),
          maxRequestsPerDay: parseInt((env as any).OPENAI_BUDGET_DAILY_MAX || "5000", 10),
        };

        const [openaiStatus, dailySummary] = await Promise.all([
          new OpenAiBudget(budgetConfig).getStatus(),
          CostAccumulator.getInstance().getDailySummary(),
        ]);

        // Determine overall status
        let status: "ok" | "warning" | "exceeded" = "ok";
        if (openaiStatus.exceeded || dailySummary.estimatedTotal >= dailySummary.limit) {
          status = "exceeded";
        } else if (
          openaiStatus.dailyUsed / openaiStatus.dailyLimit > 0.8 ||
          dailySummary.estimatedTotal / dailySummary.limit > 0.8
        ) {
          status = "warning";
        }

        const data = {
          status,
          openai: openaiStatus,
          daily: dailySummary,
        };

        cachedStatus = { data, fetchedAt: Date.now() };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(data),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[AdminCosts] Error fetching cost status:", error);
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to fetch cost status" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get cost protection status (super-admin only)",
  },
];
