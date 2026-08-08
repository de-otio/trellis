/**
 * Circle Handler
 *
 * Endpoints for circle views: members, feeds, glance mode, depth mode,
 * read status, and per-entity status.
 *
 * TENANT (H1). Every read here reaches tenant-scoped rows, and the graph layer
 * no longer resolves a tenant from ambient context — it took one from an
 * `AsyncLocalStorage` that is never populated in the default configuration
 * (`TENANT_SCOPE_MODE=off`), producing queries with NO tenant predicate at all.
 * The caller's verified `activeTenantId` (from `authMiddleware`, i.e. the JWT
 * claim the pre-token-generation Lambda signs after an ACTIVE-membership check —
 * never the cookie) is threaded in explicitly and every handler refuses without
 * it. The routes also reject earlier, so {@link CircleHandler.tenantError} is a
 * belt-and-braces guard for a handler called directly.
 */

import type { Env } from "../env.js";
import type { OrgCategoryFeedFilter } from "./graph/graph-service.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

type CircleTier = 0 | 1 | 2 | 3;

/**
 * Upper bound on how many org-root-category codes a single feed request may
 * carry per list. Not a security threshold (the codes are bound SQL parameters,
 * never interpolated) — just an abuse/size guard so a request can't smuggle an
 * unbounded `IN (...)` list. The real curated root set is a handful of codes.
 */
const MAX_ORG_FILTER_CODES = 24;

/** Accepted shape of a category code (curated slugs, optionally `parent:leaf`). */
const ORG_CATEGORY_CODE_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/i;

export class CircleHandler {
  async handleGetMembers(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const tier = this.parseTier(request);
      if (tier === null) {
        return this.tierError();
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const members = await graphService.getCircleMembers(
        session.userId,
        tier,
        activeTenantId,
      );

      return new Response(JSON.stringify({ members }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetFeed(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const tier = this.parseTier(request);
      if (tier === null) {
        return this.tierError();
      }

      const url = new URL(request.url);
      const sinceStr = url.searchParams.get("since");
      const limitStr = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");

      const since = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (isNaN(since.getTime())) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid since date" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

      const orgFilter = this.parseOrgCategoryFilter(url);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const result = await graphService.getVisiblePostIds(
        session.userId,
        tier,
        since,
        { limit, cursor: cursor || undefined },
        activeTenantId,
        orgFilter,
      );

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetGlance(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const tier = this.parseTier(request);
      if (tier === null) {
        return this.tierError();
      }

      const url = new URL(request.url);
      const limitStr = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

      const orgFilter = this.parseOrgCategoryFilter(url);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const items = await graphService.getGlanceItems(
        session.userId,
        tier,
        limit,
        activeTenantId,
        orgFilter,
      );

      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetDepth(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const url = new URL(request.url);
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");

      if (!targetType || !targetId || !["user", "entity"].includes(targetType)) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "targetType and targetId are required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const sinceStr = url.searchParams.get("since");
      const limitStr = url.searchParams.get("limit");

      const since = sinceStr ? new Date(sinceStr) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (isNaN(since.getTime())) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid since date" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const postIds = await graphService.getDepthPostIds(
        session.userId,
        targetType as "user" | "entity",
        targetId,
        since,
        limit,
        activeTenantId,
      );

      return new Response(JSON.stringify({ postIds }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetStatus(
    _request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const status = await graphService.getCircleStatus(
        session.userId,
        activeTenantId,
      );

      return new Response(JSON.stringify({ tiers: status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetEntityStatus(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
    activeTenantId: string,
  ): Promise<Response> {
    try {
      if (!activeTenantId) return this.tenantError();

      const tier = this.parseTier(request);
      if (tier === null) {
        return this.tierError();
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const entities = await graphService.getCircleEntityStatus(
        session.userId,
        tier,
        activeTenantId,
      );

      return new Response(JSON.stringify({ entities }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  /**
   * Mark a tier read. Takes no tenant: `CircleReadState` is keyed
   * `(userId, tier)` and carries no `tenantId` column, so there is nothing to
   * scope. Adding an unused parameter here would suggest a check that is not
   * happening.
   */
  async handleMarkRead(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const body = await request.json() as Record<string, unknown>;
      const tier = typeof body.tier === "number" ? body.tier : NaN;

      if (isNaN(tier) || tier < 0 || tier > 3 || !Number.isInteger(tier)) {
        return this.tierError();
      }

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      await graphService.markCircleRead(session.userId, tier as CircleTier);

      return new Response(null, { status: 204 });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  /**
   * Parse the optional org-category feed-declutter query params
   * (`excludeOrgRootCategories` / `includeOrgRootCategories`, each a
   * comma-separated list of `PlatformCategory` root codes) into an
   * {@link OrgCategoryFeedFilter}. Returns `undefined` when neither param is
   * present or both parse to empty lists, so the graph layer applies no org
   * filter at all. Malformed codes are dropped defensively (bad input never
   * reaches SQL — codes are bound parameters regardless).
   */
  private parseOrgCategoryFilter(url: URL): OrgCategoryFeedFilter | undefined {
    const exclude = this.parseCategoryCodeList(
      url.searchParams.get("excludeOrgRootCategories"),
    );
    const include = this.parseCategoryCodeList(
      url.searchParams.get("includeOrgRootCategories"),
    );
    if (!exclude && !include) return undefined;
    const filter: OrgCategoryFeedFilter = {};
    if (exclude) filter.exclude = exclude;
    if (include) filter.include = include;
    return filter;
  }

  /**
   * Split a comma-separated code list, trim, drop empties and codes that don't
   * match {@link ORG_CATEGORY_CODE_RE}, dedupe, and cap at
   * {@link MAX_ORG_FILTER_CODES}. Returns `undefined` for a null/blank input or
   * one that yields no valid codes.
   */
  private parseCategoryCodeList(raw: string | null): string[] | undefined {
    if (!raw) return undefined;
    const seen = new Set<string>();
    for (const part of raw.split(",")) {
      const code = part.trim();
      if (code.length === 0 || !ORG_CATEGORY_CODE_RE.test(code)) continue;
      seen.add(code);
      if (seen.size >= MAX_ORG_FILTER_CODES) break;
    }
    return seen.size > 0 ? Array.from(seen) : undefined;
  }

  private parseTier(request: Request): CircleTier | null {
    const url = new URL(request.url);
    const tierStr = url.searchParams.get("tier");
    if (tierStr === null) return null;
    const tier = parseInt(tierStr, 10);
    if (isNaN(tier) || tier < 0 || tier > 3 || !Number.isInteger(tier)) return null;
    return tier as CircleTier;
  }

  /**
   * Refusal for a caller with no verified active tenant. 403, not 500: the
   * request is well-formed and authenticated, it just carries no scope to read
   * in. Deliberately says nothing about what exists in any tenant.
   */
  private tenantError(): Response {
    return new Response(
      JSON.stringify({
        error: "FORBIDDEN",
        message: "An active tenant is required",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  private tierError(): Response {
    return new Response(
      JSON.stringify({ error: "VALIDATION_ERROR", message: "tier must be 0, 1, 2, or 3" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  private async handleError(error: any, env: Env): Promise<Response> {
    const logger = getLogger();

    if (error instanceof SyntaxError) {
      return new Response(
        JSON.stringify({ error: "VALIDATION_ERROR", message: "Invalid JSON body" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    if (error?.constructor?.name === "GraphConnectionError") {
      const isPoolTimeout =
        typeof error.message === "string" &&
        error.message.includes("connection acquisition timed out");
      if (isPoolTimeout) {
        logger.warn("graph_pool_acquire_timeout", { code: error.code, name: error.constructor.name });
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      } else {
        logger.warn("[CircleHandler] Graph connection error", { code: error.code, name: error.constructor.name });
      }
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }

    logger.error("[CircleHandler] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

import { getLogger, Logger } from "./logger.js";
