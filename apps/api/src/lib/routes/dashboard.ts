/**
 * Dashboard Routes
 *
 * Routes for internal dashboard, partner dashboard, and admin features
 */

import { createPrisma } from "../../db.js";
import { addCorsHeaders } from "../../worker.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { detectRegionSync } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

export const dashboardRoutes: Route[] = [
  // Internal Dashboard - Statistics
  {
    path: "/api/dashboard/metrics/users",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const timeRange = url.searchParams.get("timeRange") || "30d";
        const metric = url.searchParams.get("metric") || "dau";

        // Calculate date range
        const now = new Date();
        let startDate: Date;
        if (timeRange === "7d") {
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (timeRange === "1y") {
          startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        } else {
          // Default to 30d
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        }

        // Get user metrics based on metric type
        let value = 0;
        let previousValue = 0;

        if (metric === "dau") {
          // Daily Active Users - count unique users who logged in today
          const today = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
          );
          const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

          // For now, return placeholder data
          // TODO: Implement actual DAU calculation from login events/audit logs
          value = 12345;
          previousValue = 12000;
        } else if (metric === "wau") {
          // Weekly Active Users
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          // TODO: Implement actual WAU calculation
          value = 50000;
          previousValue = 48000;
        } else if (metric === "mau") {
          // Monthly Active Users
          // TODO: Implement actual MAU calculation
          value = 200000;
          previousValue = 195000;
        }

        const change =
          previousValue > 0
            ? ((value - previousValue) / previousValue) * 100
            : 0;
        const changeType = change >= 0 ? "increase" : "decrease";

        // Generate trend data (placeholder - should come from actual data)
        const trend = [];
        const days = timeRange === "7d" ? 7 : timeRange === "1y" ? 365 : 30;
        for (let i = days - 1; i >= 0; i--) {
          const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
          trend.push({
            date: date.toISOString().split("T")[0],
            value: value + Math.floor(Math.random() * 1000) - 500, // Placeholder variation
          });
        }

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            metric,
            value,
            change: Math.abs(change),
            changeType,
            trend,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting user metrics:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get user metrics" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get user metrics (DAU/WAU/MAU)",
  },

  {
    path: "/api/dashboard/system/health",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Test database connection
        let dbStatus = "healthy";
        let dbUptime = 99.9;
        try {
          await withQueryTimeoutAndRetry(
            dbManager,
            region,
            env,
            async (db) => {
              await db.user.count();
            },
            { timeoutMs: 2000, retryTimeoutMs: 1000 },
          );
        } catch (error) {
          dbStatus = "unhealthy";
          dbUptime = 0;
        }

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            overall: dbStatus === "healthy" ? "healthy" : "degraded",
            services: [
              {
                name: "API",
                status: "healthy",
                uptime: 99.9,
                lastCheck: new Date().toISOString(),
              },
              {
                name: "Database",
                status: dbStatus,
                uptime: dbUptime,
                lastCheck: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting system health:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get system health" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get system health status",
  },

  {
    path: "/api/dashboard/metrics/performance",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const timeRange = url.searchParams.get("timeRange") || "30d";
        const endpoint = url.searchParams.get("endpoint");

        // Placeholder performance metrics
        // TODO: Implement actual performance metrics from monitoring/logging
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            avgResponseTime: 120,
            p95Latency: 250,
            p99Latency: 500,
            errorRate: 0.1,
            requestVolume: 1000000,
            trends: {
              responseTime: [],
              errorRate: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting performance metrics:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get performance metrics" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get API performance metrics",
  },

  // User Management
  {
    path: "/api/dashboard/users",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const search = url.searchParams.get("search") || "";
        const role = url.searchParams.get("role");
        const status = url.searchParams.get("status");
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        // Build where clause
        const where: any = {};
        if (search) {
          where.OR = [
            { email: { contains: search, mode: "insensitive" } },
            { id: { contains: search } },
            { handle: { contains: search, mode: "insensitive" } },
          ];
        }
        if (role) {
          where.role = role;
        }
        if (status === "suspended") {
          where.suspended = true;
        } else if (status === "active") {
          where.suspended = false;
        }

        // Get users
        const [users, total] = await Promise.all([
          withQueryTimeoutAndRetry(
            dbManager,
            region,
            env,
            async (db) => {
              return db.user.findMany({
                where,
                select: {
                  id: true,
                  email: true,
                  role: true,
                  suspended: true,
                  createdAt: true,
                },
                take: limit,
                skip: offset,
                orderBy: { createdAt: "desc" },
              });
            },
            QueryTimeoutPresets.STANDARD,
          ),
          withQueryTimeoutAndRetry(
            dbManager,
            region,
            env,
            async (db) => {
              return db.user.count({ where });
            },
            QueryTimeoutPresets.STANDARD,
          ),
        ]);

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            users: users.map((u) => ({
              id: u.id,
              email: u.email,
              role: u.role,
              status: u.suspended ? "suspended" : "active",
              createdAt: u.createdAt.toISOString(),
            })),
            total,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error listing users:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to list users" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "List users with search and filtering",
  },

  {
    path: /^\/api\/dashboard\/users\/(.+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Extract user ID from path
        const userIdMatch = pathname.match(/^\/api\/dashboard\/users\/(.+)$/);
        if (!userIdMatch) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid user ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        const userId = userIdMatch[1];

        // Get user details
        const targetUser = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: userId },
              select: {
                id: true,
                email: true,
                role: true,
                suspended: true,
                createdAt: true,
              },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (!targetUser) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get user stats (post count, comment count, etc.)
        // TODO: Implement actual stats calculation
        const stats = {
          posts: 0,
          comments: 0,
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: targetUser.id,
            email: targetUser.email,
            role: targetUser.role,
            status: targetUser.suspended ? "suspended" : "active",
            createdAt: targetUser.createdAt.toISOString(),
            stats,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting user details:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get user details" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get detailed user information",
  },

  {
    path: /^\/api\/dashboard\/users\/(.+)$/,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Extract user ID from path
        const userIdMatch = pathname.match(/^\/api\/dashboard\/users\/(.+)$/);
        if (!userIdMatch) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid user ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        const userId = userIdMatch[1];

        // Parse request body
        const body = (await request.json()) as {
          role?: string;
          status?: string;
        };
        const { role, status } = body;

        // Build update data
        const updateData: any = {};
        if (role) {
          // Validate role
          const validRoles = [
            "END_USER",
            "B2B_PARTNER",
            "PARTNER_ADMIN",
            "INTERNAL",
            "CONTENT_CREATOR",
            "SUPER_ADMIN",
          ];
          if (!validRoles.includes(role)) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Invalid role" }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }
          updateData.role = role;
        }
        if (status === "suspended") {
          updateData.suspended = true;
          updateData.suspendedAt = new Date();
        } else if (status === "active") {
          updateData.suspended = false;
          updateData.suspendedAt = null;
        }

        if (Object.keys(updateData).length === 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "No valid fields to update" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Update user
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.update({
              where: { id: userId },
              data: updateData,
              select: {
                id: true,
                email: true,
                role: true,
                suspended: true,
                createdAt: true,
              },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: updatedUser.id,
            email: updatedUser.email,
            role: updatedUser.role,
            status: updatedUser.suspended ? "suspended" : "active",
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Dashboard] Error updating user:", error);

        if (
          error.code === "P2025" ||
          error.message?.includes("Record to update not found")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to update user" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update user (role, status, etc.)",
  },

  {
    path: /^\/api\/dashboard\/users\/(.+)$/,
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Extract user ID from path
        const userIdMatch = pathname.match(/^\/api\/dashboard\/users\/(.+)$/);
        if (!userIdMatch) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid user ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        const userId = userIdMatch[1];

        // Prevent self-deletion
        if (userId === session.userId) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Cannot delete your own account" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Delete user (soft delete by setting deletion flags)
        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.update({
              where: { id: userId },
              data: {
                deletionRequestedAt: new Date(),
                deletionScheduledAt: new Date(
                  Date.now() + 7 * 24 * 60 * 60 * 1000,
                ), // 7 days
              },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            message: "User deleted successfully",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Dashboard] Error deleting user:", error);

        if (
          error.code === "P2025" ||
          error.message?.includes("Record to update not found")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to delete user" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Delete user account",
  },

  // Content Moderation
  {
    path: "/api/dashboard/moderation/posts",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const status = url.searchParams.get("status") || "all";
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        // TODO: Implement actual moderation system with flagged posts
        // For now, return empty list as placeholder
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            posts: [],
            total: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error listing moderation posts:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to list moderation posts" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "List posts requiring moderation",
  },

  {
    path: /^\/api\/dashboard\/moderation\/posts\/(.+)\/action$/,
    method: "POST",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be INTERNAL
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Internal access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Extract post ID from path
        const postIdMatch = pathname.match(
          /^\/api\/dashboard\/moderation\/posts\/(.+)\/action$/,
        );
        if (!postIdMatch) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid post ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        const postId = postIdMatch[1];

        // Parse request body
        const body = (await request.json()) as {
          action?: string;
          reason?: string;
        };
        const { action, reason } = body;

        // Validate action
        if (!action || !["approve", "reject", "delete"].includes(action)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: 'Invalid action. Must be "approve", "reject", or "delete"',
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // TODO: Implement actual moderation actions
        // For now, return success as placeholder
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            message: `Post ${action}d successfully`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error moderating post:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to moderate post" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Moderate a post (approve/reject/delete)",
  },

  // Partner Dashboard APIs
  {
    path: "/api/dashboard/b2b/usage/requests",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be PARTNER
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true /* T3 will replace partnerId with tenant context */ },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "B2B_PARTNER" && user.role !== "PARTNER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Partner access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const timeRange = url.searchParams.get("timeRange") || "30d";
        const endpoint = url.searchParams.get("endpoint");

        // Calculate date range
        const now = new Date();
        let startDate: Date;
        if (timeRange === "7d") {
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (timeRange === "1y") {
          startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        } else {
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        }

        // TODO: Implement actual API usage tracking from audit logs
        // Placeholder response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            total: 1234567,
            timeRange,
            trend: [],
            breakdown: {
              byEndpoint: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting partner usage:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get partner usage" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get API request volume for partner",
  },

  {
    path: "/api/dashboard/b2b/usage/rate-limits",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be PARTNER
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "B2B_PARTNER" && user.role !== "PARTNER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Partner access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // TODO: Implement actual rate limit tracking
        // Placeholder response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            limit: 10000,
            used: 7500,
            remaining: 2500,
            resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
            window: "hourly",
            history: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting rate limits:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get rate limits" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get rate limit status for partner",
  },

  {
    path: "/api/dashboard/b2b/performance",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be PARTNER
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (
          !user ||
          (user.role !== "B2B_PARTNER" && user.role !== "PARTNER_ADMIN")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Partner access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse query parameters
        const url = new URL(request.url);
        const timeRange = url.searchParams.get("timeRange") || "30d";
        const endpoint = url.searchParams.get("endpoint");

        // TODO: Implement actual performance metrics from monitoring
        // Placeholder response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            avgResponseTime: 120,
            p95Latency: 250,
            p99Latency: 500,
            errorRate: 0.1,
            successRate: 99.9,
            trends: {
              responseTime: [],
              errorRate: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting partner performance:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get partner performance" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get API performance metrics for partner",
  },

  // Scaling Health
  {
    path: "/api/dashboard/scaling-health",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (!user || user.role !== "SUPER_ADMIN") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Forbidden: Super-admin access required",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get user counts from database
        const counts = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            const thirtyDaysAgo = new Date(
              Date.now() - 30 * 24 * 60 * 60 * 1000,
            );
            const [totalUsers, recentUsers] = await Promise.all([
              db.user.count(),
              db.user.count({
                where: { createdAt: { gte: thirtyDaysAgo } },
              }),
            ]);
            return { totalUsers, recentActiveUsers: recentUsers };
          },
          QueryTimeoutPresets.STANDARD,
        );

        const { evaluateScalingHealth } = await import("../scaling-health.js");
        const result = await evaluateScalingHealth(
          env,
          counts.totalUsers,
          counts.recentActiveUsers,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting scaling health:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get scaling health" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get scaling health indicators (SUPER_ADMIN only)",
  },

  // Abuse Metrics
  {
    path: "/api/dashboard/abuse-metrics",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (!user || user.role !== "SUPER_ADMIN") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Forbidden: Super-admin access required",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const url = new URL(request.url);
        const timeRange = url.searchParams.get("timeRange") || "24h";

        const { evaluateAbuseMetrics } = await import("../abuse-metrics.js");
        const result = await evaluateAbuseMetrics(env, timeRange);

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(result),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Dashboard] Error getting abuse metrics:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to get abuse metrics" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Get abuse metrics and WAF effectiveness (SUPER_ADMIN only)",
  },

  // Role Management APIs
  {
    path: "/api/admin/roles",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be SUPER_ADMIN
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (!user || user.role !== "SUPER_ADMIN") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Super-admin access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get role metadata
        const db = createPrisma(env);
        const roles = await db.roleMetadata.findMany({
          where: { isActive: true },
          orderBy: { role: "asc" },
        });

        // Format response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            roles: roles.map((r: any) => ({
              id: r.role,
              name: r.displayName,
              description: r.description,
              permissions: r.permissions || [],
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Admin] Error listing roles:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to list roles" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "List all available roles",
  },

  {
    path: /^\/api\/admin\/users\/(.+)\/role$/,
    method: "PATCH",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Check user role - must be SUPER_ADMIN
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { role: true },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        if (!user || user.role !== "SUPER_ADMIN") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden: Super-admin access required" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Extract user ID from path
        const userIdMatch = pathname.match(/^\/api\/admin\/users\/(.+)\/role$/);
        if (!userIdMatch) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid user ID" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        const userId = userIdMatch[1];

        // Parse request body
        const body = (await request.json()) as { role?: string };
        const { role } = body;

        if (!role) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Role is required" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Validate role
        const validRoles = [
          "END_USER",
          "B2B_PARTNER",
          "PARTNER_ADMIN",
          "INTERNAL",
          "CONTENT_CREATOR",
          "SUPER_ADMIN",
        ];
        if (!validRoles.includes(role)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid role" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Update user role
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.update({
              where: { id: userId },
              data: { role: role as any },
              select: {
                id: true,
                email: true,
                role: true,
                subject: true,
                createdAt: true,
              },
            });
          },
          QueryTimeoutPresets.STANDARD,
        );

        // Claims-cache freshness audit: this is a GLOBAL-ROLE change, the
        // strongest privilege mutation in the product (it can grant or revoke
        // SUPER_ADMIN). A pre-token-generation cache HIT skips the RDS read
        // entirely, so without invalidation a demoted admin keeps minting
        // SUPER_ADMIN JWTs for up to one cache TTL (~1h). This call site was
        // missing it.
        const { invalidateClaims } = await import(
          "../auth/claims-invalidation.js"
        );
        await invalidateClaims([updatedUser.subject], "user.change_global_role");

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: updatedUser.id,
            email: updatedUser.email,
            role: updatedUser.role,
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error changing user role:", error);

        if (
          error.code === "P2025" ||
          error.message?.includes("Record to update not found")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to change user role" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Change user role",
  },
];
