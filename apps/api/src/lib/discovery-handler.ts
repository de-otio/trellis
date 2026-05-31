/**
 * Discovery Handler
 *
 * Endpoints for entity discovery via graph traversal, spatial proximity,
 * and graph-based recommendations.
 *
 * SECURITY: Discovery is rate-limited to 5 requests/minute/user.
 * Hops are hard-capped at 2. Lat/lng are coarsened to 3 decimal places.
 */

import type { Env } from "../env.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

// Simple in-memory rate limiter: 5 requests per 60-second window per user.
// NOTE: Per-process only — does not enforce across multiple ECS tasks. Known tradeoff.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Hard cap to prevent unbounded growth under many unique users
const RATE_LIMIT_MAP_MAX_SIZE = 50_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
let lastCleanupAt = Date.now();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();

  // Periodic cleanup: sweep expired entries every 60 seconds to prevent memory leak
  if (now - lastCleanupAt > RATE_LIMIT_WINDOW_MS) {
    lastCleanupAt = now;
    for (const [key, val] of rateLimitMap) {
      if (now >= val.resetAt) rateLimitMap.delete(key);
    }
  }

  // Hard size cap: if at limit and this user isn't already tracked, deny
  if (!rateLimitMap.has(userId) && rateLimitMap.size >= RATE_LIMIT_MAP_MAX_SIZE) {
    return false;
  }

  const entry = rateLimitMap.get(userId);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

export class DiscoveryHandler {
  async handleDiscoverByGraph(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      if (!checkRateLimit(session.userId)) {
        return rateLimitResponse();
      }

      const url = new URL(request.url);
      const hopsStr = url.searchParams.get("hops");
      const entityType = url.searchParams.get("entityType") || undefined;
      const breed = url.searchParams.get("breed") || undefined;
      const lifeStage = url.searchParams.get("lifeStage") || undefined;
      const limitStr = url.searchParams.get("limit");

      // Hard-cap hops at 2 (security requirement — prevents graph traversal DoS)
      const hops = Math.min(Math.max(parseInt(hopsStr || "2", 10) || 2, 1), 2);
      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const results = await graphService.discoverByGraph(session.userId, hops, {
        entityType,
        breed,
        lifeStage,
        hops: hops as 1 | 2,
        limit,
      });

      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleDiscoverNearby(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      if (!checkRateLimit(session.userId)) {
        return rateLimitResponse();
      }

      const url = new URL(request.url);
      const latStr = url.searchParams.get("lat");
      const lngStr = url.searchParams.get("lng");
      const radiusStr = url.searchParams.get("radius");
      const entityType = url.searchParams.get("entityType") || undefined;
      const breed = url.searchParams.get("breed") || undefined;
      const limitStr = url.searchParams.get("limit");

      if (!latStr || !lngStr) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "lat and lng are required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const lat = parseFloat(latStr);
      const lng = parseFloat(lngStr);

      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", message: "lat must be -90..90, lng must be -180..180" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Coarsen to 3 decimal places (~1km precision) to prevent triangulation
      const coarseLat = Math.round(lat * 1000) / 1000;
      const coarseLng = Math.round(lng * 1000) / 1000;

      const radius = Math.min(Math.max(parseInt(radiusStr || "5000", 10) || 5000, 100), 50000);
      const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const results = await graphService.discoverNearby(
        session.userId,
        coarseLat,
        coarseLng,
        radius,
        { entityType, breed, limit },
      );

      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  async handleGetRecommendations(
    request: Request,
    session: Session,
    env: Env,
    _requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      if (!checkRateLimit(session.userId)) {
        return rateLimitResponse();
      }

      const url = new URL(request.url);
      const limitStr = url.searchParams.get("limit");
      const limit = Math.min(Math.max(parseInt(limitStr || "10", 10) || 10, 1), 30);

      const { createGraphServiceFromEnv } = await import("./graph/index.js");
      const graphService = await createGraphServiceFromEnv(env);

      const recommendations = await graphService.getRecommendations(session.userId, limit);

      return new Response(JSON.stringify({ recommendations }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      return await this.handleError(error, env);
    }
  }

  private async handleError(error: any, env: Env): Promise<Response> {
    const logger = getLogger();

    if (error?.constructor?.name === "GraphConnectionError") {
      const isPoolTimeout =
        typeof error.message === "string" &&
        error.message.includes("connection acquisition timed out");
      if (isPoolTimeout) {
        logger.warn("graph_pool_acquire_timeout", { code: error.code, name: error.constructor.name });
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      } else {
        logger.warn("[DiscoveryHandler] Graph connection error", { code: error.code, name: error.constructor.name });
      }
      return new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }

    logger.error("[DiscoveryHandler] Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

function rateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ error: "RATE_LIMITED", message: "Too many discovery requests. Try again in 60 seconds." }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
  );
}

import { getLogger, Logger } from "./logger.js";
