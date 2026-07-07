/**
 * Recap Routes (year-in-review core primitive)
 *
 * GET /api/recap/:subjectType/:subjectId?window=YYYY  (or ?from=<ISO>&to=<ISO>)
 *
 * Ownership-gated: a "user" subject must be the session user; an "entity"
 * subject requires the session user to hold an ACTIVE EntityOwnership on it.
 * Off by default for minor accounts (safer-social design).
 */

import { authMiddleware } from "../auth/auth-middleware.js";
import { createPrisma } from "../../db.js";
import { featureToggleMiddleware } from "../feature-gate-middleware.js";
import { corsMiddleware } from "../middleware.js";
import { RecapService } from "../recap-service.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

const RECAP_PATH = /^\/api\/recap\/([^/]+)\/([^/]+)$/;
const SUBJECT_TYPES = new Set(["user", "entity"]);

/**
 * Parse the recap window from query params: either `?window=YYYY` (the
 * calendar year, UTC) or an explicit `?from=<ISO>&to=<ISO>` range. Returns
 * null on missing/invalid input — callers respond 400.
 */
function parseRecapWindow(url: URL): { from: Date; to: Date } | null {
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (fromParam || toParam) {
    if (!fromParam || !toParam) return null;
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    if (from.getTime() > to.getTime()) return null;
    return { from, to };
  }

  const windowParam = url.searchParams.get("window");
  if (windowParam) {
    if (!/^\d{4}$/.test(windowParam)) return null;
    const year = Number(windowParam);
    return {
      from: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
      to: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
    };
  }

  return null;
}

export const recapRoutes: Route[] = [
  {
    path: RECAP_PATH,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);

      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      const match = pathname.match(RECAP_PATH);
      const subjectType = match?.[1];
      const subjectId = match?.[2];
      if (!subjectType || !subjectId || !SUBJECT_TYPES.has(subjectType)) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "subjectType must be 'user' or 'entity'",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const window = parseRecapWindow(new URL(request.url));
      if (!window) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "Provide ?window=YYYY or ?from=<ISO date>&to=<ISO date>",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const db = createPrisma(env);
      try {
        // Ownership gate.
        if (subjectType === "user") {
          if (subjectId !== session.userId) {
            return securityHeaders.createSecureResponse(
              JSON.stringify({ error: "FORBIDDEN", message: "Not authorized to view this recap" }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
          }
        } else {
          const ownership = await db.entityOwnership.findFirst({
            where: {
              entityId: subjectId,
              userId: session.userId,
              tenantId: auth.activeTenantId,
              status: "ACTIVE",
            },
          });
          if (!ownership) {
            return securityHeaders.createSecureResponse(
              JSON.stringify({ error: "FORBIDDEN", message: "Not authorized to view this recap" }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
          }
        }

        // Off by default for minor accounts (safer-social design — a
        // year-in-review is a classic engagement-maximizing surface).
        const requester = await db.user.findUnique({
          where: { id: session.userId },
          select: { ageTier: true },
        });
        if (requester && requester.ageTier !== "ADULT") {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "FORBIDDEN",
              message: "Year-in-review is not available for minor accounts",
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        const recapService = new RecapService();
        const payload = await recapService.generateRecap(
          {
            subjectType: subjectType as "user" | "entity",
            subjectId,
            window,
            tenantId: auth.activeTenantId,
          },
          env,
        );

        return securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      } finally {
        await db.release();
      }
    },
    middleware: [corsMiddleware(), featureToggleMiddleware("year_in_review_enabled")],
    description: "Get a subject's year-in-review recap",
  },
];
