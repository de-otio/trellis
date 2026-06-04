/**
 * Internal Documentation Handler
 *
 * Handles serving internal documentation to INTERNAL and SUPER_ADMIN role users.
 * CRITICAL SECURITY: Only users with INTERNAL or SUPER_ADMIN role can access this documentation.
 */

import { createPrisma } from "../db.js";
import dashboardData from "./internal-docs-dashboard.json" with { type: "json" };
import {
  buildAllowedFilesFromNavigation,
  validateNavigation,
} from "./internal-docs-navigation.js";
import navigationData from "./internal-docs-navigation.json" with { type: "json" };
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { SecurityHeaders } from "./security-headers.js";
import type { Env } from "../env.js";
import { Session, SessionManager, UserRole } from "./session-cookie.js";

/**
 * Internal Documentation Handler class
 */
export class InternalDocsHandler {
  private sessionManager: SessionManager;
  private securityHeaders: SecurityHeaders;
  private allowedFiles: Record<string, string>;
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.sessionManager = new SessionManager();
    this.securityHeaders = new SecurityHeaders();
    this.logger = getLogger();

    // Validate navigation data at construction time
    const validation = validateNavigation(navigationData);
    if (!validation.valid) {
      this.logger.error(
        "[InternalDocsHandler] Navigation validation failed:",
        validation.errors,
      );
      throw new Error(
        `Invalid navigation data: ${validation.errors.join("; ")}`,
      );
    }

    // Generate allowedFiles whitelist from navigation (single source of truth)
    this.allowedFiles = buildAllowedFilesFromNavigation(navigationData);
    this.logger.info(
      `[InternalDocsHandler] Generated ${Object.keys(this.allowedFiles).length} allowed files from navigation`,
    );
  }

  /**
   * Verify user has INTERNAL or SUPER_ADMIN role
   * CRITICAL: This is a security check - only INTERNAL or SUPER_ADMIN users can access documentation
   */
  private async verifyInternalAccess(
    session: Session | null,
    env: Env,
  ): Promise<{ authorized: boolean; userRole?: UserRole }> {
    if (!session) {
      return { authorized: false };
    }

    try {
      const db = createPrisma(env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user) {
        return { authorized: false };
      }

      // CRITICAL: Only INTERNAL or SUPER_ADMIN role users can access
      if (user.role !== "INTERNAL" && user.role !== "SUPER_ADMIN") {
        return { authorized: false, userRole: user.role as UserRole };
      }

      return { authorized: true, userRole: user.role as UserRole };
    } catch (error) {
      this.logger.error("[InternalDocsHandler] Error verifying access:", error);
      return { authorized: false };
    }
  }

  /**
   * Get list of available documentation files
   * GET /api/internal/docs
   *
   * Returns list of documentation files available in doc/requirements/internal-documentation/
   */
  async handleGetDocsList(request: Request, env: Env): Promise<Response> {
    try {
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      const access = await this.verifyInternalAccess(session, env);

      if (!access.authorized) {
        // CRITICAL SECURITY: Log unauthorized access attempt
        this.logger.warn(
          "[InternalDocsHandler] Unauthorized access attempt to internal documentation",
          {
            userId: session?.userId,
            userRole: access.userRole,
            ipAddress:
              request.headers.get("CF-Connecting-IP") ||
              request.headers.get("X-Forwarded-For"),
            userAgent: request.headers.get("User-Agent"),
          },
        );

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Unauthorized: INTERNAL or SUPER_ADMIN role required",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Documentation files available in doc/requirements/internal-documentation/
      const docsList = [
        {
          id: "overview",
          title: "Overview",
          description: "Internal documentation system overview",
          path: "OVERVIEW.md",
          category: "general",
        },
        {
          id: "developer-guide",
          title: "Developer Guide",
          description: "Comprehensive technical guide for developers",
          path: "DEVELOPER_GUIDE.md",
          category: "developers",
        },
        {
          id: "developer",
          title: "Developer Documentation Strategy",
          description:
            "Strategy for creating and maintaining developer documentation",
          path: "DEVELOPER_DOCS.md",
          category: "developers",
        },
        {
          id: "business-analyst-guide",
          title: "Business Analyst Guide",
          description:
            "Comprehensive guide for business analysts and data scientists",
          path: "BUSINESS_ANALYST_GUIDE.md",
          category: "business-analysts",
        },
        {
          id: "business-analyst",
          title: "Business Analyst Documentation Strategy",
          description: "Strategy for business analyst documentation",
          path: "BUSINESS_ANALYST_DOCS.md",
          category: "business-analysts",
        },
        {
          id: "support-guide",
          title: "Support Guide",
          description:
            "Comprehensive guide for support workers and customer service",
          path: "SUPPORT_GUIDE.md",
          category: "support",
        },
        {
          id: "support",
          title: "Support Documentation Strategy",
          description: "Strategy for support documentation",
          path: "SUPPORT_DOCS.md",
          category: "support",
        },
        {
          id: "sales-guide",
          title: "Sales Guide",
          description: "Comprehensive guide for sales teams",
          path: "SALES_GUIDE.md",
          category: "sales",
        },
        {
          id: "sales",
          title: "Sales Documentation Strategy",
          description: "Strategy for sales documentation",
          path: "SALES_DOCS.md",
          category: "sales",
        },
        {
          id: "operations-guide",
          title: "Operations Guide",
          description:
            "Comprehensive guide for SRE, DevOps, and infrastructure teams",
          path: "OPERATIONS_GUIDE.md",
          category: "operations",
        },
        {
          id: "operations",
          title: "Operations Documentation Strategy",
          description: "Strategy for operations documentation",
          path: "OPERATIONS_DOCS.md",
          category: "operations",
        },
        {
          id: "compliance-guide",
          title: "Compliance Guide",
          description:
            "Comprehensive GDPR, BDSG, and security audit documentation",
          path: "COMPLIANCE_GUIDE.md",
          category: "compliance",
        },
        {
          id: "compliance",
          title: "Compliance Documentation Strategy",
          description: "Strategy for compliance documentation",
          path: "COMPLIANCE_DOCS.md",
          category: "compliance",
        },
        {
          id: "architecture",
          title: "Architecture",
          description: "Overall design and approach",
          path: "ARCHITECTURE.md",
          category: "developers",
        },
        {
          id: "implementation",
          title: "Implementation Guide",
          description: "Step-by-step implementation guide",
          path: "IMPLEMENTATION.md",
          category: "developers",
        },
        {
          id: "sync-strategy",
          title: "Sync Strategy",
          description: "Strategies for keeping documentation in sync",
          path: "SYNC_STRATEGY.md",
          category: "developers",
        },
      ];

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ docs: docsList }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error) {
      this.logger.error(
        "[InternalDocsHandler] Error in handleGetDocsList:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Get navigation structure for internal documentation
   * GET /api/internal/docs/navigation
   *
   * Returns the navigation structure used by the frontend component.
   * This is the same structure as navigation.json but served from API.
   */
  async handleGetNavigation(request: Request, env: Env): Promise<Response> {
    try {
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      const access = await this.verifyInternalAccess(session, env);

      if (!access.authorized) {
        // CRITICAL SECURITY: Log unauthorized access attempt
        this.logger.warn(
          "[InternalDocsHandler] Unauthorized access attempt to navigation",
          {
            userId: session?.userId,
            userRole: access.userRole,
            ipAddress:
              request.headers.get("CF-Connecting-IP") ||
              request.headers.get("X-Forwarded-For"),
            userAgent: request.headers.get("User-Agent"),
          },
        );

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Unauthorized: INTERNAL or SUPER_ADMIN role required",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Return navigation structure from JSON file
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ sections: navigationData.sections }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error) {
      this.logger.error(
        "[InternalDocsHandler] Error in handleGetNavigation:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Get dashboard-specific documentation structure
   * GET /api/internal/docs/dashboard
   *
   * Returns dashboard-specific organization of documentation files,
   * independent of the navigation menu structure.
   */
  async handleGetDashboardDocs(request: Request, env: Env): Promise<Response> {
    try {
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      const access = await this.verifyInternalAccess(session, env);

      if (!access.authorized) {
        // CRITICAL SECURITY: Log unauthorized access attempt
        this.logger.warn(
          "[InternalDocsHandler] Unauthorized access attempt to dashboard docs",
          {
            userId: session?.userId,
            userRole: access.userRole,
            ipAddress:
              request.headers.get("CF-Connecting-IP") ||
              request.headers.get("X-Forwarded-For"),
            userAgent: request.headers.get("User-Agent"),
          },
        );

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Unauthorized: INTERNAL or SUPER_ADMIN role required",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Return dashboard-specific structure from JSON file
      // Sort sections by order field
      const sortedSections = [...dashboardData.sections].sort(
        (a, b) => (a.order || 999) - (b.order || 999),
      );

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ sections: sortedSections }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error) {
      this.logger.error(
        "[InternalDocsHandler] Error in handleGetDashboardDocs:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Get specific documentation file content
   * GET /api/internal/docs/:filename
   *
   * SECURITY: This endpoint requires INTERNAL or SUPER_ADMIN role authentication
   * The filename is validated and checked against the whitelist
   *
   * Security layers (defense in depth):
   * 1. Authentication check (session + INTERNAL or SUPER_ADMIN role)
   * 2. Filename validation (path traversal prevention)
   * 3. Whitelist check (explicit file access control)
   */
  async handleGetDoc(
    request: Request,
    env: Env,
    filename: string,
  ): Promise<Response> {
    try {
      // ============================================================
      // SECURITY LAYER 0: Authentication and Authorization Check
      // ============================================================
      // Verify user has valid session and INTERNAL or SUPER_ADMIN role
      // This is the primary security gate - only employees and super admins can pass
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      const access = await this.verifyInternalAccess(session, env);

      if (!access.authorized) {
        // CRITICAL SECURITY: Log unauthorized access attempt
        // This helps with security monitoring and incident response
        this.logger.warn(
          "[InternalDocsHandler] Unauthorized access attempt to internal documentation file",
          {
            filename,
            userId: session?.userId || "no-session",
            userRole: access.userRole || "unknown",
            ipAddress:
              request.headers.get("CF-Connecting-IP") ||
              request.headers.get("X-Forwarded-For") ||
              "unknown",
            userAgent: request.headers.get("User-Agent") || "unknown",
          },
        );

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Unauthorized: INTERNAL or SUPER_ADMIN role required",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // ============================================================
      // SECURITY LAYER 1: Filename Validation (Path Traversal Prevention)
      // ============================================================
      // Validate filename format to prevent path traversal attacks
      // Allow: alphanumeric, hyphens, underscores, dots, forward slashes (for subdirectories)
      // Block: path traversal (..), absolute paths (/), and other dangerous patterns
      if (
        !/^[a-zA-Z0-9._\-\/]+\.md$/.test(filename) ||
        filename.includes("..") ||
        filename.startsWith("/")
      ) {
        // SECURITY: Log potential attack attempt
        this.logger.warn(
          "[InternalDocsHandler] Invalid filename format (potential path traversal):",
          {
            filename,
            ipAddress: request.headers.get("CF-Connecting-IP"),
            userAgent: request.headers.get("User-Agent"),
          },
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid filename" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // ============================================================
      // SECURITY LAYER 2: Whitelist Check (Explicit File Access Control)
      // ============================================================
      // The whitelist is generated from navigation.json at runtime
      // Only files explicitly listed in navigation can be accessed
      // This prevents:
      // - Access to files not intended for documentation
      // - Accidental exposure of unlisted files
      // - Path traversal even if validation is bypassed
      let filePath: string | undefined;

      // Try exact match first (most common case)
      filePath = this.allowedFiles[filename];

      // If not found, try case-insensitive lookup (for flexibility)
      if (!filePath) {
        const normalizedFilename = filename.toLowerCase();
        for (const [key, value] of Object.entries(this.allowedFiles)) {
          if (key.toLowerCase() === normalizedFilename) {
            filePath = value;
            break;
          }
        }
      }

      // SECURITY: If file is not in whitelist, deny access
      // This is intentional - we return 404 (not 403) to avoid information leakage
      // An attacker cannot distinguish between "file doesn't exist" and "file not allowed"
      if (!filePath) {
        // SECURITY: Log access attempt to non-whitelisted file
        this.logger.warn(
          "[InternalDocsHandler] Access attempt to non-whitelisted file:",
          {
            filename,
            userId: session?.userId,
            ipAddress: request.headers.get("CF-Connecting-IP"),
          },
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "File not found" }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Fetch the markdown file from the public docs folder
      // SECURITY: This is safe because we've already verified INTERNAL or SUPER_ADMIN role above
      // The files are in public/docs/internal/ but access is controlled via this API endpoint
      //
      // NOTE: In the future, consider:
      // - Using Cloudflare R2/KV for direct file storage
      // - Bundling files in Worker (if size allows)
      // - Using Cloudflare Assets API
      try {
        // Construct the URL to fetch from the frontend's public folder
        // Try multiple sources in order of preference
        const origin = request.headers.get("Origin");
        const appDomain = env.APP_DOMAIN;
        const frontendUrl = origin || appDomain || "https://rkm1.de";
        const docsUrl = `${frontendUrl}/docs/${filePath}`;

        this.logger.info("[InternalDocsHandler] Fetching docs from:", docsUrl);

        // Fetch with timeout and retry logic
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        let fileResponse: Response;
        try {
          // Add cache-busting query parameter to prevent Cloudflare CDN from serving stale content
          // In dev environment, we want fresh content on every request
          const cacheBust = Date.now();
          const separator = docsUrl.includes("?") ? "&" : "?";
          fileResponse = await fetch(`${docsUrl}${separator}cb=${cacheBust}`, {
            headers: {
              "User-Agent": "Trellis-Internal-Docs-API/1.0",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              Pragma: "no-cache",
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!fileResponse.ok) {
          // Distinguish between different error types
          if (fileResponse.status === 404) {
            this.logger.error(
              `[InternalDocsHandler] File not found: ${filePath} (404)`,
            );
            return this.securityHeaders.createSecureResponse(
              JSON.stringify({
                error: "File not found",
                filename,
                path: filePath,
                status: 404,
              }),
              {
                status: 404,
                headers: { "content-type": "application/json" },
              },
            );
          }

          if (fileResponse.status >= 500) {
            this.logger.error(
              `[InternalDocsHandler] Server error fetching file: ${filePath}, status: ${fileResponse.status}`,
            );
            return this.securityHeaders.createSecureResponse(
              JSON.stringify({
                error: "Frontend server error",
                message: `Failed to fetch file from frontend (${fileResponse.status} ${fileResponse.statusText})`,
                filename,
                path: filePath,
                status: 502,
              }),
              {
                status: 502,
                headers: { "content-type": "application/json" },
              },
            );
          }

          // Other client errors (403, etc.)
          this.logger.error(
            `[InternalDocsHandler] Failed to fetch file: ${filePath}, status: ${fileResponse.status}, statusText: ${fileResponse.statusText}`,
          );
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Failed to fetch file",
              message: `${fileResponse.status} ${fileResponse.statusText}`,
              filename,
              path: filePath,
              status: fileResponse.status,
            }),
            {
              status: fileResponse.status,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const markdownContent = await fileResponse.text();

        if (!markdownContent || markdownContent.trim().length === 0) {
          this.logger.warn(`[InternalDocsHandler] File ${filePath} is empty`);
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "File is empty",
              filename,
              path: filePath,
              status: 404,
            }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // Validate that the response is actually markdown, not HTML (e.g., index.html fallback)
        // Check for common HTML indicators
        const trimmedContent = markdownContent.trim();
        if (
          trimmedContent.startsWith("<!DOCTYPE") ||
          trimmedContent.startsWith("<!doctype") ||
          trimmedContent.startsWith("<html") ||
          trimmedContent.startsWith("<HTML") ||
          (trimmedContent.includes("<head>") &&
            trimmedContent.includes("<body>"))
        ) {
          this.logger.error(
            `[InternalDocsHandler] Received HTML instead of markdown for ${filePath}. This usually means the file is missing and the SPA served index.html as a fallback.`,
          );
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "File not found",
              message:
                "The requested documentation file was not found on the frontend server. The file may need to be copied to the web app's public folder.",
              filename,
              path: filePath,
              status: 404,
            }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        this.logger.info(
          `[InternalDocsHandler] Successfully loaded ${filePath}, content length: ${markdownContent.length}`,
        );

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            content: markdownContent,
            filename,
            path: filePath,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      } catch (error) {
        // Handle network errors, timeouts, etc.
        if (error instanceof Error && error.name === "AbortError") {
          this.logger.error(
            "[InternalDocsHandler] Timeout fetching markdown file:",
            filePath,
          );
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Request timeout",
              message: "Frontend did not respond in time",
              filename,
              path: filePath,
              status: 504,
            }),
            {
              status: 504,
              headers: { "content-type": "application/json" },
            },
          );
        }

        this.logger.error(
          "[InternalDocsHandler] Error fetching markdown file:",
          error,
        );
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Network error",
            message: errorMessage,
            filename,
            path: filePath,
            status: 500,
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    } catch (error) {
      this.logger.error("[InternalDocsHandler] Error getting doc:", error);
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }
}
