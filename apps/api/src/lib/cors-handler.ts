/**
 * CORS Handler
 *
 * Handles CORS-related functionality including origin validation
 * and header management.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";

export class CorsHandler {
  /**
   * Get allowed CORS origin based on request origin and configured allowed origins
   * When credentials are involved, we must return the exact origin (not '*')
   */
  static getAllowedOrigin(request: Request, env: Env): string | null {
    const requestOrigin = request.headers.get("Origin");
    if (!requestOrigin) {
      // No origin header (e.g., same-origin request or non-browser client)
      // CORS doesn't apply to same-origin requests, but we return APP_DOMAIN for safety
      return env.APP_DOMAIN?.replace(/\/$/, "") || null;
    }

    // Build list of allowed origins
    const allowedOrigins: string[] = [];

    // Add origins from ALLOWED_ORIGINS env var (comma-separated)
    if (env.ALLOWED_ORIGINS) {
      const origins = env.ALLOWED_ORIGINS.split(",").map((o) =>
        o.trim().replace(/\/$/, ""),
      );
      allowedOrigins.push(...origins);
    }

    // Add APP_DOMAIN and its www/non-www variations
    if (env.APP_DOMAIN) {
      const appDomain = env.APP_DOMAIN.replace(/\/$/, "");
      allowedOrigins.push(appDomain);

      // Also allow www and non-www variations
      const domainWithoutProtocol = appDomain.replace(/^https?:\/\//, "");
      if (domainWithoutProtocol.startsWith("www.")) {
        allowedOrigins.push(
          `https://${domainWithoutProtocol.replace(/^www\./, "")}`,
        );
      } else {
        allowedOrigins.push(`https://www.${domainWithoutProtocol}`);
      }
    }

    // Normalize request origin (remove trailing slash)
    const normalizedRequestOrigin = requestOrigin.replace(/\/$/, "");

    // Check if request origin is in allowed list
    if (allowedOrigins.includes(normalizedRequestOrigin)) {
      return normalizedRequestOrigin;
    }

    // If no APP_DOMAIN or ALLOWED_ORIGINS is configured (local dev), allow the request origin
    // This is a safety fallback for local development
    if (!env.APP_DOMAIN && !env.ALLOWED_ORIGINS) {
      getLogger().info(
        `[CORS] No APP_DOMAIN or ALLOWED_ORIGINS configured, allowing origin: ${normalizedRequestOrigin}`,
      );
      return normalizedRequestOrigin;
    }

    // Allow Cloudflare Pages domains (only specific known projects)
    if (normalizedRequestOrigin.includes(".pages.dev")) {
      const allowedPagesProjects = [
        "trellis-web",
        "trellis-preview",
        "trellis-at",
      ];
      const pagesDomainMatch = normalizedRequestOrigin.match(
        /^https:\/\/([^.]+)\.pages\.dev$/,
      );
      if (
        pagesDomainMatch &&
        allowedPagesProjects.includes(pagesDomainMatch[1])
      ) {
        getLogger().info(
          `[CORS] Allowing Cloudflare Pages project: ${pagesDomainMatch[1]}`,
        );
        return normalizedRequestOrigin;
      }
      getLogger().info(
        `[CORS] Cloudflare Pages project not in whitelist: ${normalizedRequestOrigin}`,
      );
      return null;
    }

    // S1.6 — Allow known production domains with strict suffix matching
    try {
      const originUrl = new URL(normalizedRequestOrigin);
      const host = originUrl.hostname;
      const knownDomains = ["rkm1.de", "example.com"];
      const isKnownDomain = knownDomains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      );
      if (isKnownDomain) {
        getLogger().info(
          `[CORS] Allowing known domain origin: ${normalizedRequestOrigin}`,
        );
        return normalizedRequestOrigin;
      }
    } catch {
      // Invalid URL, fall through to rejection
    }

    // Origin not allowed
    getLogger().info(
      `[CORS] Origin not allowed: ${normalizedRequestOrigin}. Allowed origins: ${allowedOrigins.join(", ")}`,
    );
    return null;
  }

  /**
   * Add CORS headers to a response
   * Creates a new response with CORS headers added
   * Note: Response bodies can only be read once, so we need to clone first
   *
   * PREPARATORY: Also adds region headers for debugging
   */
  static async addCorsHeaders(
    response: Response,
    request: Request,
    env: Env,
    requestContext?: { region: string },
  ): Promise<Response> {
    try {
      const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);
      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count",
        "Access-Control-Allow-Credentials": "true",
      };
      if (allowedOrigin) {
        corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
      } else {
        // Log when origin is not allowed for debugging
        const requestOrigin = request.headers.get("Origin");
        getLogger().info(
          `[CORS] No allowed origin found. Request origin: ${requestOrigin}, APP_DOMAIN: ${env.APP_DOMAIN}, ALLOWED_ORIGINS: ${env.ALLOWED_ORIGINS}`,
        );
        // Still add other CORS headers even if origin is not allowed
        // The browser will reject it, but at least we tried
      }

      // CRITICAL: For binary responses (images, files), we must NOT read as text
      // Reading binary data as text corrupts it (UTF-8 decoding)
      // Check Content-Type to determine if this is binary data
      const contentType = response.headers.get("Content-Type") || "";
      const isBinaryResponse =
        contentType.startsWith("image/") ||
        contentType.startsWith("video/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("application/octet-stream") ||
        contentType.startsWith("application/pdf");

      let responseBody: ArrayBuffer | string;
      let allHeaders: Headers;

      if (isBinaryResponse) {
        // For binary responses, read as ArrayBuffer to preserve binary data
        try {
          const clonedResponse = response.clone();
          responseBody = await clonedResponse.arrayBuffer();
        } catch (cloneError) {
          // If cloning fails, try to read the original response body
          getLogger().error(
            "[CORS] Error cloning binary response, trying direct read:",
            cloneError,
          );
          responseBody = await response.arrayBuffer();
        }
        // Copy existing headers (this preserves Set-Cookie headers)
        allHeaders = new Headers(response.headers);
      } else {
        // For text responses (JSON, HTML, etc.), read as text
        let bodyText: string;
        try {
          const clonedResponse = response.clone();
          bodyText = await clonedResponse.text();
        } catch (cloneError) {
          // If cloning fails, try to read the original response body
          getLogger().error(
            "[CORS] Error cloning response, trying direct read:",
            cloneError,
          );
          bodyText = await response.text();
        }
        responseBody = bodyText;
        // Copy existing headers (this preserves Set-Cookie headers)
        allHeaders = new Headers(response.headers);
      }

      // Log Set-Cookie header before adding CORS headers
      const setCookieBefore = allHeaders.get("Set-Cookie");
      if (setCookieBefore) {
        getLogger().info(
          "[CORS] Preserving Set-Cookie header (first 100 chars):",
          setCookieBefore.substring(0, 100),
        );
      }

      // Add CORS headers
      Object.entries(corsHeaders).forEach(([key, value]) => {
        allHeaders.set(key, value);
      });

      // PREPARATORY: Add region headers for debugging (if requestContext provided)
      if (requestContext) {
        allHeaders.set("X-Region", requestContext.region);
        allHeaders.set("X-Region-Detected", requestContext.region);
      }

      // Verify Set-Cookie is still present after adding CORS headers
      const setCookieAfter = allHeaders.get("Set-Cookie");
      if (setCookieBefore && !setCookieAfter) {
        getLogger().error(
          "[CORS] WARNING: Set-Cookie header was lost!",
        );
      }

      // Create new response with all headers and body
      // Use the appropriate body type (ArrayBuffer for binary, string for text)
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: allHeaders,
      });
    } catch (error: any) {
      // If adding CORS headers fails, at least return a response with CORS headers
      getLogger().error("[CORS] Error adding CORS headers:", error);
      const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);
      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-CSRF-Token",
        "Access-Control-Allow-Credentials": "true",
      };
      if (allowedOrigin) {
        corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
      }
      // Return error response with CORS headers
      // Note: requestContext not available in error handler, so region headers won't be added
      return new Response(
        JSON.stringify({
          error: "Failed to process response",
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json",
            ...corsHeaders,
          },
        },
      );
    }
  }

  /**
   * Get CORS headers object
   */
  static getCorsHeaders(request: Request, env: Env): Record<string, string> {
    const allowedOrigin = CorsHandler.getAllowedOrigin(request, env);
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-CSRF-Token",
      "Access-Control-Allow-Credentials": "true",
    };
    if (allowedOrigin) {
      corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
    }
    return corsHeaders;
  }
}
