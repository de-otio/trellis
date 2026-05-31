/**
 * Employees Routes
 */

import { createPrisma } from "../../db.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const employeesRoutes: Route[] = [
  {
    path: "/api/employees",
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const db = createPrisma(env);
        const user = await db.user.findUnique({
          where: { id: session.userId },
          select: { role: true },
        });

        if (!user) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        type EmployeeData = {
          id: string;
          email: string;
          handle: string | null;
          actorUri: string | null;
          role?: string;
        };

        let employees: EmployeeData[];

        if (user.role === "INTERNAL") {
          employees = (await db.user.findMany({
            where: { role: "INTERNAL" },
            select: { id: true, email: true, handle: true, actorUri: true },
            orderBy: { email: "asc" },
          })) as EmployeeData[];
        } else if (
          user.role === "B2B_PARTNER" ||
          user.role === "PARTNER_ADMIN"
        ) {
          // T3: list users who are active TenantMembers of the caller's active tenant.
          const { authMiddleware: resolveAuth } = await import("../auth/auth-middleware.js");
          const auth = await resolveAuth(request, env);
          if (!auth || !auth.activeTenantId) {
            return securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Unauthorized" }),
              { status: 401, headers: { "content-type": "application/json" } },
            );
          }

          const memberships = await db.tenantMember.findMany({
            where: { tenantId: auth.activeTenantId, status: "ACTIVE" },
            include: {
              user: {
                select: { id: true, email: true, handle: true, actorUri: true, role: true },
              },
            },
            orderBy: { user: { email: "asc" } },
          });

          employees = memberships.map((m) => ({
            id: m.user.id,
            email: m.user.email,
            handle: m.user.handle,
            actorUri: m.user.actorUri,
            role: m.user.role,
          }));
        } else {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Forbidden" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        const formattedEmployees = employees.map((emp: EmployeeData) => ({
          id: emp.id,
          email: emp.email,
          actorUri: emp.actorUri || undefined,
          handle: emp.handle || undefined,
          status: "ACCEPTED" as const,
        }));

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ friends: formattedEmployees }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error getting employees:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Get employees list",
  },
];
