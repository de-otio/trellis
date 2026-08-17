/**
 * Out Redirector Routes
 *
 * Handles safe link redirection with security warnings for risky links.
 * This endpoint acts as an intermediary between users and external links,
 * providing warnings for unknown or suspicious domains.
 */

import { DomainReputationService } from "../domain-reputation-service.js";
import { LinkSecurityHandler, LinkStatus } from "../link-security-handler.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

export interface Env {
  DATABASE_URL: string;
  US_DATABASE_URL?: string;
  EU_DATABASE_URL?: string;
  CN_DATABASE_URL?: string;
  DEFAULT_REGION?: string;
}

/**
 * HTML template for warning page
 */
function getWarningPageHtml(
  url: string,
  domain: string,
  reason?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Warning: External Link</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .warning-icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      color: #333;
      margin-bottom: 16px;
      font-size: 24px;
    }
    .message {
      color: #666;
      margin-bottom: 24px;
      line-height: 1.6;
    }
    .url-display {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      word-break: break-all;
      font-family: monospace;
      font-size: 14px;
      color: #333;
    }
    .domain {
      font-weight: bold;
      color: #d97706;
    }
    .buttons {
      display: flex;
      gap: 12px;
      flex-direction: column;
    }
    button {
      padding: 14px 28px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .continue-btn {
      background: #667eea;
      color: white;
    }
    .continue-btn:hover {
      background: #5568d3;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .cancel-btn {
      background: #e5e7eb;
      color: #374151;
    }
    .cancel-btn:hover {
      background: #d1d5db;
    }
    .reason {
      background: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 12px;
      margin-bottom: 24px;
      text-align: left;
      border-radius: 4px;
      font-size: 14px;
      color: #92400e;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="warning-icon">⚠️</div>
    <h1>Warning: External Link</h1>
    <p class="message">
      You are about to visit a link from an unknown or suspicious domain.
      Please proceed with caution.
    </p>
    ${reason ? `<div class="reason"><strong>Reason:</strong> ${reason}</div>` : ""}
    <div class="url-display">
      <div class="domain">${escapeHtml(domain)}</div>
      <div style="margin-top: 8px; font-size: 12px; color: #666;">${escapeHtml(url)}</div>
    </div>
    <div class="buttons">
      <button class="continue-btn" onclick="window.location.href='${escapeHtml(url)}'">
        Continue to Site
      </button>
      <button class="cancel-btn" onclick="window.history.back()">
        Go Back
      </button>
    </div>
  </div>
</body>
</html>`;
}

/**
 * HTML template for blocked page
 */
function getBlockedPageHtml(url: string, reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Blocked</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    .blocked-icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      color: #333;
      margin-bottom: 16px;
      font-size: 24px;
    }
    .message {
      color: #666;
      margin-bottom: 24px;
      line-height: 1.6;
    }
    .reason {
      background: #fee2e2;
      border-left: 4px solid #ef4444;
      padding: 12px;
      margin-bottom: 24px;
      text-align: left;
      border-radius: 4px;
      font-size: 14px;
      color: #991b1b;
    }
    button {
      padding: 14px 28px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      background: #e5e7eb;
      color: #374151;
      transition: all 0.2s;
    }
    button:hover {
      background: #d1d5db;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="blocked-icon">🚫</div>
    <h1>Link Blocked</h1>
    <p class="message">
      This link has been blocked for security reasons.
    </p>
    <div class="reason">
      <strong>Reason:</strong> ${escapeHtml(reason)}
    </div>
    <button onclick="window.history.back()">
      Go Back
    </button>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

export const outRoutes: Route[] = [
  {
    path: "/out",
    method: "GET",
    handler: async (request, env, { url: requestUrl }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const linkSecurityHandler = new LinkSecurityHandler(env);
      const domainReputationService = new DomainReputationService(env);

      try {
        // Parse URL parameter
        const url = new URL(requestUrl);
        const targetUrl = url.searchParams.get("url");

        if (!targetUrl) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Missing url parameter" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Apply rate limiting: 100 redirects per hour per IP
        const clientIP =
          request.headers.get("CF-Connecting-IP") ||
          request.headers.get("X-Forwarded-For")?.split(",")[0] ||
          "unknown";
        const rateLimitResponse = await rateLimiter.applyRateLimitKV(
          env as any,
          request,
          "/out",
          100,
          3600,
          clientIP,
        );
        if (rateLimitResponse) {
          return securityHeaders.addSecurityHeaders(rateLimitResponse);
        }

        // Validate and normalize URL
        const normalized = linkSecurityHandler.normalizeUrl(targetUrl);
        if (!normalized) {
          return securityHeaders.createSecureResponse(
            getBlockedPageHtml(targetUrl, "Invalid URL format"),
            {
              status: 403,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }

        // Full SSRF validation, DNS included. The interstitial's whole job is
        // to hand the user a destination, so a name resolving into private or
        // link-local space must be refused here — the lexical check alone
        // cannot see that.
        const validation = await linkSecurityHandler.validateUrl(targetUrl);

        if (validation.status === LinkStatus.BLOCKED) {
          logger.info(
            `[Out] Blocked link: ${targetUrl} - ${validation.reason}`,
          );
          return securityHeaders.createSecureResponse(
            getBlockedPageHtml(
              targetUrl,
              validation.reason || "Link blocked for security reasons",
            ),
            {
              status: 403,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }

        // Check domain reputation
        const region = env.DEFAULT_REGION || "EU";
        const reputation = await domainReputationService.getReputation(
          normalized.domain,
          region,
          env as any,
        );

        // Determine final status based on reputation
        let finalStatus: LinkStatus = validation.status;
        if (reputation.status === "blocked") {
          finalStatus = LinkStatus.BLOCKED;
        } else if (
          reputation.status === "warning" ||
          validation.status === LinkStatus.PENDING
        ) {
          finalStatus = LinkStatus.WARNING;
        } else if (reputation.status === "safe") {
          finalStatus = LinkStatus.SAFE;
        }

        // Handle based on status
        if (finalStatus === LinkStatus.BLOCKED) {
          logger.info(
            `[Out] Blocked link (reputation): ${targetUrl} - domain: ${normalized.domain}`,
          );
          return securityHeaders.createSecureResponse(
            getBlockedPageHtml(
              targetUrl,
              `Domain ${normalized.domain} is blocked`,
            ),
            {
              status: 403,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }

        if (
          finalStatus === LinkStatus.WARNING ||
          finalStatus === LinkStatus.PENDING
        ) {
          // Show warning page
          logger.info(
            `[Out] Warning page for: ${targetUrl} - domain: ${normalized.domain}`,
          );
          return securityHeaders.createSecureResponse(
            getWarningPageHtml(
              normalized.normalized,
              normalized.domain,
              reputation.status === "warning"
                ? "Domain has low reputation"
                : undefined,
            ),
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }

        // Safe link - redirect directly
        logger.info(
          `[Out] Safe redirect: ${targetUrl} - domain: ${normalized.domain}`,
        );
        return Response.redirect(normalized.normalized, 302);
      } catch (error: any) {
        logger.error("[Out] Error processing redirect:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to process link" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware()],
    description: "Safe link redirector with security warnings",
  },
];
