/**
 * Security Headers
 *
 * Utilities for adding security headers to responses.
 *
 * Environment Variables:
 * - CSP_CONNECT_SRC: Additional domains for CSP connect-src directive
 * - CSP_SCRIPT_SRC: Override for CSP script-src directive
 * - CSP_STYLE_SRC: Override for CSP style-src directive
 */

export interface SecurityHeadersEnv {
  CSP_CONNECT_SRC?: string; // Additional CSP connect-src domains (space-separated)
  CSP_SCRIPT_SRC?: string; // Override for CSP script-src
  CSP_STYLE_SRC?: string; // Override for CSP style-src
}

// The header set is a pure function of the three CSP env inputs, but
// `new SecurityHeaders(env)` runs inside nearly every route handler — so the
// CSP string was being re-joined on every request. Cache the built set per
// input tuple at module level (same pattern as session-cookie.ts's
// moduleCookieCache); entries are frozen because instances share them.
const moduleHeaderCache = new Map<string, Record<string, string>>();

/** Test hook: reset the module-level header cache. */
export function clearSecurityHeadersCache(): void {
  moduleHeaderCache.clear();
}

/**
 * Security Headers manager class
 */
export class SecurityHeaders {
  private headers: Record<string, string>;

  constructor(env?: SecurityHeadersEnv) {
    const cacheKey = [
      env?.CSP_CONNECT_SRC ?? "",
      env?.CSP_SCRIPT_SRC ?? "",
      env?.CSP_STYLE_SRC ?? "",
    ].join("\u0000");

    const cached = moduleHeaderCache.get(cacheKey);
    if (cached) {
      this.headers = cached;
      return;
    }

    // Build CSP policy based on environment
    const cspConnectSrc = this.buildCSPConnectSrc(env);
    const cspScriptSrc =
      env?.CSP_SCRIPT_SRC || "'self' https://www.gstatic.com";
    // Note: 'unsafe-inline' intentionally removed for security. If Flutter web
    // uses inline styles, set CSP_STYLE_SRC env var to include 'unsafe-inline'.
    const cspStyleSrc = env?.CSP_STYLE_SRC || "'self' https://fonts.googleapis.com";

    const csp = [
      "default-src 'self'",
      `script-src ${cspScriptSrc}`,
      `style-src ${cspStyleSrc}`,
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${cspConnectSrc}`,
      "frame-ancestors 'none'",
      // Phase 8 hardening: kill legacy plugin embedding (<object>/<embed>) and
      // pin the document base URL so an injected <base href> cannot re-point
      // every relative script/form target at an attacker host.
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; ");

    this.headers = Object.freeze({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security":
        "max-age=31536000; includeSubDomains; preload",
      "Content-Security-Policy": csp,
    });
    moduleHeaderCache.set(cacheKey, this.headers);
  }

  /**
   * Build CSP connect-src directive with environment-specific domains
   */
  private buildCSPConnectSrc(env?: SecurityHeadersEnv): string {
    const defaults = [
      "'self'",
      "https://bsky.social",
      "https://api.rkm1.de",
      "https://www.gstatic.com",
    ];

    if (env?.CSP_CONNECT_SRC) {
      // Add additional domains from environment
      const additionalDomains = env.CSP_CONNECT_SRC.trim().split(/\s+/);
      return [...defaults, ...additionalDomains].join(" ");
    }

    return defaults.join(" ");
  }

  /**
   * Add security headers to a response
   * Preserves existing headers and status
   */
  addSecurityHeaders(response: Response): Response {
    // Create a new response with the same body and status
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // Add security headers (this will override if they already exist)
    Object.entries(this.headers).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });

    return newResponse;
  }

  /**
   * Add security headers to a new response
   */
  createSecureResponse(body: BodyInit | null, init?: ResponseInit): Response {
    const response = new Response(body, init);
    return this.addSecurityHeaders(response);
  }
}
