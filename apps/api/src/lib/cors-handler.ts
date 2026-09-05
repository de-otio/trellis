/**
 * CORS Handler
 *
 * Handles CORS-related functionality including origin validation
 * and header management.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";

/**
 * The single source of truth for `Access-Control-Allow-Headers`.
 *
 * Browsers preflight any non-simple request header, so a header the client
 * sends but this list omits makes the *whole* request fail — for the web
 * build only, which is exactly the kind of gap that ships unnoticed from a
 * mobile-first test pass. `X-Client-Version` / `X-Client-Platform` are sent by
 * the app on every call (see `lib/client-version.ts`), so they belong here.
 *
 * NEVER widen this to `*`: these responses are served with
 * `Access-Control-Allow-Credentials: true`, and the wildcard is invalid (and
 * silently ignored) in credentialed mode.
 */
export const CORS_ALLOWED_REQUEST_HEADERS =
  "Content-Type, Authorization, X-CSRF-Token, X-Retry-Count, X-Client-Version, X-Client-Platform, Idempotency-Key";

/**
 * Headers a browser-based client is allowed to *read* off a cross-origin
 * response (`Access-Control-Expose-Headers`). Browsers only expose a small
 * CORS-safelisted set by default; anything else is invisible to
 * `fetch().headers.get(...)` unless listed here.
 *
 * `Idempotency-Replay` (see `lib/middleware/idempotency.ts`) tells the caller
 * whether a write was executed or replayed from cache. Without exposing it, a
 * web client that retries a POST after a timeout cannot tell a fresh write
 * from a replay and will double-count.
 */
export const CORS_EXPOSED_RESPONSE_HEADERS = "Idempotency-Replay";

/**
 * SEC M4 — is this origin a loopback (local development) origin?
 *
 * Only `localhost`, `127.0.0.0/8` and `[::1]` count, on any port and on
 * http/https. Deliberately hostname-exact: `localhost.attacker.example` and
 * `notlocalhost` must NOT match, which is why this parses the URL instead of
 * substring-matching.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Prefix a bare host with `https://` if it has no scheme yet. `undefined`
 * passes through as `undefined` so callers can chain `?.` / `||` unchanged.
 */
function withScheme(host: string | undefined): string | undefined {
  if (!host) return host;
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

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
      return withScheme(env.APP_DOMAIN?.replace(/\/$/, "")) || null;
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
      // APP_DOMAIN is deployed as a bare host (OpenTofu's `local.app_domain`,
      // e.g. "app.dev.skybber.com" — no scheme). A browser's Origin header
      // always carries one, so without normalizing here this entry could
      // never match and the operator's own APP_DOMAIN would be silently
      // treated as not-allowed rather than as the origin it names.
      const appDomain = withScheme(env.APP_DOMAIN.replace(/\/$/, ""))!;
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

    // SEC M4 — fail CLOSED when nothing is configured.
    //
    // This branch used to reflect the request origin verbatim whenever neither
    // APP_DOMAIN nor ALLOWED_ORIGINS was set. Combined with
    // `Access-Control-Allow-Credentials: true` (added unconditionally by
    // `addCorsHeaders`), that let ANY site make credentialed cross-origin
    // requests and read the responses — and for a published, reusable core,
    // "the deployer set no origin config" is a realistic deployment.
    //
    // Local development still works: reflection is now limited to loopback
    // origins, which no remote attacker can present.
    if (!env.APP_DOMAIN && !env.ALLOWED_ORIGINS) {
      if (isLoopbackOrigin(normalizedRequestOrigin)) {
        getLogger().info(
          `[CORS] No origin config; allowing loopback dev origin: ${normalizedRequestOrigin}`,
        );
        return normalizedRequestOrigin;
      }
      getLogger().warn(
        `[CORS] No APP_DOMAIN or ALLOWED_ORIGINS configured; denying non-loopback origin: ${normalizedRequestOrigin}`,
      );
      return null;
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
      // SEC M4: `example.com` removed — it is the IANA reserved example
      // domain, it shipped in the published core's allow-list, and anyone can
      // stand up a subdomain of a domain they control that ends in it only by
      // owning it. Nothing legitimate needed it.
      const knownDomains = ["rkm1.de"];
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
      const corsHeaders = CorsHandler.getCorsHeaders(request, env);
      if (!corsHeaders["Access-Control-Allow-Origin"]) {
        // Log when origin is not allowed for debugging. The remaining CORS
        // headers are still added even without an allowed origin — the
        // browser will reject it, but at least we tried.
        const requestOrigin = request.headers.get("Origin");
        getLogger().info(
          `[CORS] No allowed origin found. Request origin: ${requestOrigin}, APP_DOMAIN: ${env.APP_DOMAIN}, ALLOWED_ORIGINS: ${env.ALLOWED_ORIGINS}`,
        );
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

      // Log that a Set-Cookie header is being preserved — by cookie NAME only.
      // This used to log the first 100 characters of the header at INFO on
      // every response that set a cookie, which on login is most of the sealed
      // session token.
      const setCookieBefore = allHeaders.get("Set-Cookie");
      if (setCookieBefore) {
        getLogger().info("[CORS] Preserving Set-Cookie header", {
          cookieNames: setCookieBefore
            .split(/,(?=\s*[^;,=\s]+=)/)
            .map((c) => c.trim().split("=")[0] ?? "")
            .filter((n) => n.length > 0),
        });
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
      const corsHeaders = CorsHandler.getCorsHeaders(request, env);
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
      "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": CORS_EXPOSED_RESPONSE_HEADERS,
    };
    if (allowedOrigin) {
      corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
    }
    return corsHeaders;
  }
}
