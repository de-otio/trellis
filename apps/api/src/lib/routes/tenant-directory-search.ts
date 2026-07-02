/**
 * Directory Search Route
 *
 * GET /api/directory/search — public, opt-in tenant directory search across
 * name / category / location, spanning all tenants.
 *
 * AUTHENTICATION IS REQUIRED (MVP decision, not left open — see the route's
 * `description`). This was an assumption resolved by the implementation plan
 * under its unattended-execution rule: requiring auth gives a simpler,
 * non-bypassable rate-limiting story (per-user, not per-IP, which is trivially
 * defeated by rotating IPs) and makes the "no list-everything" enumeration
 * bound (S18) actually enforceable. Unauthenticated directory browsing can be
 * revisited in a later phase if it matters for adoption.
 *
 * Security posture (see `../tenant/directory-search.ts` for the query-level
 * invariants): min-query-length + statement-timeout + no-empty-filter guards,
 * the S3 CITY/HIDDEN triangulation exclusion in the query path, and a per-user
 * rate limit (reusing the shared `RateLimiter`, not a second mechanism).
 */

import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { RateLimiter } from "../rate-limit.js";
import { getDirectorySearchConfig } from "../org-category/directory-search-config.js";
import {
  validateAndNormalize,
  executeDirectorySearch,
  type RawDirectorySearchInput,
} from "../tenant/directory-search.js";
import { getLogger } from "../logger.js";
import type { Route } from "./types.js";

const ENDPOINT = "/api/directory/search";

export const tenantDirectorySearchRoutes: Route[] = [
  {
    path: ENDPOINT,
    method: "GET",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);

      const json = (body: unknown, status: number): Response =>
        securityHeaders.addSecurityHeaders(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );

      // 1. Auth: the endpoint requires authentication (see file header).
      const session = await sessionManager.getSession(request, env.SESSION_SECRET, env);
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const config = getDirectorySearchConfig(env);

      // 2. Per-user rate limit (reuse the shared RateLimiter — S10).
      const rateLimiter = new RateLimiter();
      const limited = await rateLimiter.applyRateLimitKV(
        env,
        request,
        ENDPOINT,
        config.rateLimit,
        config.rateLimitWindowSeconds,
        undefined, // sessionId
        undefined, // email
        session.userId, // per-user keying
      );
      if (limited) return securityHeaders.addSecurityHeaders(limited);

      // 3. Validate + normalize inputs (min length, ranges, no-empty-filter, bounds).
      const url = new URL(request.url);
      const raw: RawDirectorySearchInput = {
        name: url.searchParams.get("name"),
        categoryId: url.searchParams.get("categoryId"),
        categoryCode: url.searchParams.get("categoryCode"),
        lat: url.searchParams.get("lat"),
        lng: url.searchParams.get("lng"),
        radius: url.searchParams.get("radius"),
        locationLabel: url.searchParams.get("locationLabel"),
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize"),
      };
      const validated = validateAndNormalize(raw, config);
      if (!validated.ok) {
        return json({ error: validated.error, message: validated.message }, 400);
      }

      // 4. Execute.
      try {
        const { createPrisma } = await import("../../db.js");
        const prisma = createPrisma(env);
        const results = await executeDirectorySearch(prisma, validated.params, config);
        return json(
          {
            results,
            page: validated.params.page,
            pageSize: validated.params.pageSize,
          },
          200,
        );
      } catch (error) {
        getLogger().error("[DirectorySearch] search failed:", error);
        return json({ error: "INTERNAL_ERROR", message: "Internal server error" }, 500);
      }
    },
    middleware: [corsMiddleware()],
    description:
      "Search the public tenant directory by name, category, and/or location (authentication required for MVP; CITY/HIDDEN listings are excluded from radius search to prevent location triangulation)",
  },
];
