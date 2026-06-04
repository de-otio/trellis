/**
 * Request Context Module
 *
 * Provides request context including region detection and configuration.
 * This allows handlers to access region-specific settings throughout the request lifecycle.
 */

import type { Env } from "../env.js";
import {
  RegionConfigManager,
  type RegionConfig,
  getRegionConfig,
} from "./region-config.js";
import {
  RegionDetector,
  type Region,
  detectRegion,
  detectRegionSync,
} from "./region-detection.js";
import type { Session, SessionManager } from "./session-cookie.js";

/**
 * Extended environment interface for request context
 */
export interface TrellisRequestContextEnv {
  // Region detection
  DEFAULT_REGION?: string;
  ENABLE_IP_GEOLOCATION?: string;
  IP_GEOLOCATION_API_KEY?: string;
  IP_GEOLOCATION_SERVICE?: "cloudflare" | "ipapi" | "ip-api";

  // Session
  SESSION_SECRET?: string;

  // Region configuration (endpoints, etc.)
  US_API_ENDPOINT?: string;
  US_FRONTEND_ENDPOINT?: string;
  US_CDN_ENDPOINT?: string;
  EU_API_ENDPOINT?: string;
  EU_FRONTEND_ENDPOINT?: string;
  EU_CDN_ENDPOINT?: string;
  CN_API_ENDPOINT?: string;
  CN_FRONTEND_ENDPOINT?: string;
  CN_CDN_ENDPOINT?: string;
}

/**
 * Request context containing region and configuration
 */
export interface TrellisRequestContext {
  region: Region;
  config: RegionConfig;
  session?: Session | null;
}

/**
 * Request Context Manager class
 */
export class TrellisRequestContextManager {
  private regionDetector: RegionDetector;
  private regionConfigManager: RegionConfigManager;
  private env: TrellisRequestContextEnv;

  constructor(env: TrellisRequestContextEnv) {
    this.env = env;
    this.regionDetector = new RegionDetector(env as Env);
    this.regionConfigManager = new RegionConfigManager(env as Env);
  }

  /**
   * Create request context with region detection and configuration
   *
   * This is the main function to call at the start of request handling.
   * It detects the region, loads configuration, and optionally fetches the session.
   *
   * Performance: Optimized to use sync detection when possible (99% of cases).
   * Only uses async if external IP geolocation is configured (rare).
   *
   * @param request - Request object
   * @param sessionManager - Optional session manager (for user preference detection)
   * @param session - Optional existing session (to avoid re-fetching)
   * @returns Request context with region and configuration
   */
  async createRequestContext(
    request: Request,
    sessionManager?: SessionManager,
    session?: Session | null,
  ): Promise<TrellisRequestContext> {
    // PERFORMANCE: Fast path - use sync version if external IP geolocation not configured
    // This avoids Promise overhead for 99% of requests
    if (
      !this.env.IP_GEOLOCATION_API_KEY ||
      this.env.IP_GEOLOCATION_SERVICE !== "ipapi"
    ) {
      const region = this.regionDetector.detectRegionSync(request);
      const config = this.regionConfigManager.getRegionConfig(region);
      return {
        region,
        config,
        session: session || undefined,
      };
    }

    // Slow path: Only if external IP geolocation is configured (rare)
    const region = await this.regionDetector.detectRegion(
      request,
      sessionManager,
      session,
    );
    const config = this.regionConfigManager.getRegionConfig(region);

    return {
      region,
      config,
      session: session || undefined,
    };
  }

  /**
   * Create request context synchronously (for simple cases)
   *
   * Uses only synchronous detection methods (CloudFront-Viewer-Country / CF-IPCountry, Accept-Language).
   * Does not fetch session or use external IP geolocation.
   *
   * @param request - Request object
   * @returns Request context with region and configuration
   */
  createRequestContextSync(request: Request): TrellisRequestContext {
    // Detect region synchronously
    const region = this.regionDetector.detectRegionSync(request);

    // Get region configuration
    const config = this.regionConfigManager.getRegionConfig(region);

    // Return context
    return {
      region,
      config,
    };
  }

  /**
   * Add region headers to response for debugging
   *
   * Adds X-Region and X-Region-Detected headers to help with debugging.
   * These headers are safe to expose and help identify region detection issues.
   *
   * @param response - Response object
   * @param context - Request context
   * @returns New response with region headers added
   */
  addRegionHeaders(response: Response, context: TrellisRequestContext): Response {
    // Clone response to add headers
    const newHeaders = new Headers(response.headers);

    // Add region headers (safe to expose)
    newHeaders.set("X-Region", context.region);
    newHeaders.set("X-Region-Detected", context.region);

    // Return new response with headers
    // Note: We can't clone the body easily, so this is best used before response is created
    // For existing responses, we'd need to read the body first
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  /**
   * Add region headers to response (async version that handles body reading)
   *
   * This version can handle responses that have already been created.
   *
   * PERFORMANCE: Only reads body if response has already been created.
   * For new responses, use addRegionHeaders() instead to avoid body reading.
   *
   * @param response - Response object
   * @param context - Request context
   * @returns New response with region headers added
   */
  async addRegionHeadersAsync(
    response: Response,
    context: TrellisRequestContext,
  ): Promise<Response> {
    // PERFORMANCE: Try to add headers without reading body first
    // If response.body is null or already consumed, we'll need to read it
    if (response.body === null) {
      // Body already consumed, can't clone
      // In practice, this function should be called before the body is consumed
      const newHeaders = new Headers(response.headers);
      newHeaders.set("X-Region", context.region);
      newHeaders.set("X-Region-Detected", context.region);
      // Return response with headers but no body (body was already consumed)
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // PERFORMANCE: If body is available, try to clone it first
    // If cloning fails (body already consumed), handle gracefully
    let body: ArrayBuffer | null = null;
    try {
      const clonedResponse = response.clone();
      body = await clonedResponse.arrayBuffer();
    } catch (error) {
      // Body was consumed between check and clone, handle gracefully
      body = null;
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.set("X-Region", context.region);
    newHeaders.set("X-Region-Detected", context.region);

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }
}

/**
 * Legacy functions for backward compatibility
 * @deprecated Use new TrellisRequestContextManager class instead
 */
export async function createRequestContext(
  request: Request,
  env: TrellisRequestContextEnv,
  sessionManager?: SessionManager,
  session?: Session | null,
): Promise<TrellisRequestContext> {
  const manager = new TrellisRequestContextManager(env);
  return manager.createRequestContext(request, sessionManager, session);
}

export function createRequestContextSync(
  request: Request,
  env: TrellisRequestContextEnv,
): TrellisRequestContext {
  const manager = new TrellisRequestContextManager(env);
  return manager.createRequestContextSync(request);
}

export function addRegionHeaders(
  response: Response,
  context: TrellisRequestContext,
): Response {
  const manager = new TrellisRequestContextManager({});
  return manager.addRegionHeaders(response, context);
}

export async function addRegionHeadersAsync(
  response: Response,
  context: TrellisRequestContext,
): Promise<Response> {
  const manager = new TrellisRequestContextManager({});
  return manager.addRegionHeadersAsync(response, context);
}
