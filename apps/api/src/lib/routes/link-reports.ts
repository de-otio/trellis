/**
 * Link Report Routes
 *
 * Handles user reports of malicious or suspicious links.
 */

import { DataRouter, type DataRouterEnv } from "../data-router.js";
import { DomainReputationService } from "../domain-reputation-service.js";
import { createEmailProvider } from "../email-provider.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export interface Env extends DataRouterEnv {
  // No additional env vars needed
}

export const linkReportRoutes: Route[] = [
  {
    path: /^\/api\/posts\/([^/]+)\/links\/([^/]+)\/report$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting: 10 reports per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/link-reports",
        10,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        // Extract postId and linkId from path
        const match = pathname.match(
          /^\/api\/posts\/([^/]+)\/links\/([^/]+)\/report$/,
        );
        if (!match) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid URL format" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const postId = match[1];
        const linkId = match[2];

        // Parse request body
        const body = (await request.json().catch(() => ({}))) as {
          reason?: string;
        };

        // Get region from request context
        const region = requestContext.region || env.DEFAULT_REGION || "EU";
        const db = DataRouter.getDatabaseForRegion(region, env);

        // Get link check to find the URL and domain
        const linkCheck = await db.linkCheck.findUnique({
          where: { id: linkId },
          include: {
            post: {
              where: { id: postId },
            },
          },
        });

        if (!linkCheck || linkCheck.postId !== postId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Link not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Extract domain from URL
        let domain = "";
        try {
          const url = new URL(linkCheck.normalizedUrl || linkCheck.originalUrl);
          domain = url.hostname.toLowerCase();
          // Remove www. prefix
          if (domain.startsWith("www.")) {
            domain = domain.substring(4);
          }
        } catch (e) {
          logger.warn(
            `[LinkReports] Failed to parse URL: ${linkCheck.originalUrl}`,
          );
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid link URL" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Create link report
        const report = await db.linkReport.create({
          data: {
            userId: session.userId,
            linkUrl: linkCheck.normalizedUrl || linkCheck.originalUrl,
            domain,
            reason: body.reason || null,
            status: "pending",
          },
        });

        // Update domain reputation (negative signal)
        const reputationService = new DomainReputationService(env);
        await reputationService.updateReputation(
          domain,
          "user_report",
          region,
          env,
        );

        // Check if domain should be auto-blocked
        const shouldAutoBlock = await reputationService.shouldAutoBlock(
          domain,
          region,
          env,
        );
        if (shouldAutoBlock) {
          await reputationService.updateReputation(
            domain,
            "auto_block",
            region,
            env,
          );
          logger.info(
            `[LinkReports] Auto-blocked domain ${domain} due to report threshold`,
          );

          // Notify moderators about auto-block
          await notifyModeratorsOfAutoBlock(domain, report.id, env, logger);
        }

        // Log the report
        logger.info(
          `[LinkReports] User ${session.userId} reported link ${linkId} in post ${postId} (domain: ${domain})`,
        );

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            report: {
              id: report.id,
              status: report.status,
              createdAt: report.createdAt.toISOString(),
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("[LinkReports] Error creating report:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Report a link in a post",
  },

  {
    path: /^\/api\/comments\/([^/]+)\/links\/([^/]+)\/report$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const rateLimiter = new RateLimiter();
      const validator = new Validator();

      // Check authentication
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Apply rate limiting: 10 reports per hour per user
      const rateLimitResponse = await rateLimiter.applyRateLimitKV(
        env as any,
        request,
        "/link-reports",
        10,
        3600,
        session.userId,
      );
      if (rateLimitResponse) {
        return securityHeaders.addSecurityHeaders(rateLimitResponse);
      }

      try {
        if (!requestContext) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Request context not available" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        // Extract commentId and linkId from path
        const match = pathname.match(
          /^\/api\/comments\/([^/]+)\/links\/([^/]+)\/report$/,
        );
        if (!match) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid URL format" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const commentId = match[1];
        const linkId = match[2];

        // Parse request body
        const body = (await request.json().catch(() => ({}))) as {
          reason?: string;
        };

        // Get region from request context
        const region = requestContext.region || env.DEFAULT_REGION || "EU";
        const db = DataRouter.getDatabaseForRegion(region, env);

        // Get link check to find the URL and domain
        const linkCheck = await db.linkCheck.findUnique({
          where: { id: linkId },
          include: {
            comment: {
              where: { id: commentId },
            },
          },
        });

        if (!linkCheck || linkCheck.commentId !== commentId) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Link not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        // Extract domain from URL
        let domain = "";
        try {
          const url = new URL(linkCheck.normalizedUrl || linkCheck.originalUrl);
          domain = url.hostname.toLowerCase();
          // Remove www. prefix
          if (domain.startsWith("www.")) {
            domain = domain.substring(4);
          }
        } catch (e) {
          logger.warn(
            `[LinkReports] Failed to parse URL: ${linkCheck.originalUrl}`,
          );
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid link URL" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        // Create link report
        const report = await db.linkReport.create({
          data: {
            userId: session.userId,
            linkUrl: linkCheck.normalizedUrl || linkCheck.originalUrl,
            domain,
            reason: body.reason || null,
            status: "pending",
          },
        });

        // Update domain reputation (negative signal)
        const reputationService = new DomainReputationService(env);
        await reputationService.updateReputation(
          domain,
          "user_report",
          region,
          env,
        );

        // Check if domain should be auto-blocked
        const shouldAutoBlock = await reputationService.shouldAutoBlock(
          domain,
          region,
          env,
        );
        if (shouldAutoBlock) {
          await reputationService.updateReputation(
            domain,
            "auto_block",
            region,
            env,
          );
          logger.info(
            `[LinkReports] Auto-blocked domain ${domain} due to report threshold`,
          );

          // Notify moderators about auto-block
          await notifyModeratorsOfAutoBlock(domain, report.id, env, logger);
        }

        // Log the report
        logger.info(
          `[LinkReports] User ${session.userId} reported link ${linkId} in comment ${commentId} (domain: ${domain})`,
        );

        return securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            report: {
              id: report.id,
              status: report.status,
              createdAt: report.createdAt.toISOString(),
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      } catch (error: any) {
        logger.error("[LinkReports] Error creating report:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Report a link in a comment",
  },
];

/**
 * Notify moderators when a domain is auto-blocked
 */
async function notifyModeratorsOfAutoBlock(
  domain: string,
  reportId: string,
  env: any,
  logger: Logger,
): Promise<void> {
  try {
    // Check if webhook URL is configured
    if (env.MODERATOR_WEBHOOK_URL) {
      await fetch(env.MODERATOR_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "domain_auto_blocked",
          domain,
          reportId,
          timestamp: new Date().toISOString(),
          message: `Domain ${domain} has been automatically blocked due to reaching the report threshold. Review report ${reportId}.`,
        }),
      });
      logger.info(
        `[LinkReports] Sent auto-block notification to moderators for domain ${domain}`,
      );
    } else if (env.MODERATOR_EMAILS) {
      // Fallback to email if webhook not configured
      const emailProvider = createEmailProvider({
        provider: (env.EMAIL_SERVICE as any) || "resend",
        resendApiKey: env.RESEND_API_KEY,
        alibabaAccessKeyId: env.ALIBABA_ACCESS_KEY_ID,
        alibabaAccessKeySecret: env.ALIBABA_ACCESS_KEY_SECRET,
        alibabaRegion: env.ALIBABA_REGION,
        alibabaAccountName: env.ALIBABA_ACCOUNT_NAME,
        tencentSecretId: env.TENCENT_SECRET_ID,
        tencentSecretKey: env.TENCENT_SECRET_KEY,
        tencentRegion: env.TENCENT_REGION,
        tencentFromEmail: env.TENCENT_FROM_EMAIL,
        awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        awsRegion: env.AWS_REGION,
      });

      const moderatorEmails = Array.isArray(env.MODERATOR_EMAILS)
        ? env.MODERATOR_EMAILS
        : env.MODERATOR_EMAILS.split(",").map((e: string) => e.trim());

      await emailProvider.sendEmail({
        from: env.FROM_EMAIL || "noreply@example.com",
        to: moderatorEmails,
        subject: `Domain Auto-Blocked: ${domain}`,
        html: `
          <h2>Domain Auto-Blocked</h2>
          <p>The domain <strong>${domain}</strong> has been automatically blocked due to reaching the report threshold.</p>
          <p><strong>Report ID:</strong> ${reportId}</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p>Please review the report and take appropriate action.</p>
        `,
        text: `Domain Auto-Blocked: ${domain}\n\nReport ID: ${reportId}\nTimestamp: ${new Date().toISOString()}\n\nPlease review the report and take appropriate action.`,
      });
      logger.info(
        `[LinkReports] Sent auto-block email to moderators for domain ${domain}`,
      );
    } else {
      logger.warn(
        `[LinkReports] No moderator notification configured (MODERATOR_WEBHOOK_URL or MODERATOR_EMAILS)`,
      );
    }
  } catch (error: any) {
    logger.error(
      "[LinkReports] Failed to notify moderators of auto-block:",
      error,
    );
    // Don't throw - notification failure shouldn't break report creation
  }
}
