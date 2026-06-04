/**
 * Badge Handler
 *
 * Handles user badge API endpoints.
 * Badges are computed automatically based on verification status.
 */

import { createPrisma } from "../db.js";
import type { Env } from "../env.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { SessionManager } from "./session-cookie.js";
import { getUserBadges } from "./user-badge.js";

export class BadgeHandler {
  /**
   * GET /api/users/:userId/badges
   * Get all badges for a user
   */
  async handleGetUserBadges(
    request: Request,
    env: Env,
    userId: string,
  ): Promise<Response> {
    const db = createPrisma(env);

    try {
      // Get user from database
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          emailVerified: true,
          emailVerifiedAt: true,
          showVerifiedBadge: true,
          identityVerified: true,
          identityVerifiedAt: true,
          showIdentityVerifiedBadge: true,
          identityVerificationMethod: true,
        },
      });

      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Compute badges
      const badges = getUserBadges(user);

      return new Response(
        JSON.stringify({
          badges,
          count: badges.length,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      getLogger().error(
        "[BadgeHandler] Error getting user badges:",
        error,
      );
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /**
   * PATCH /api/users/:userId/badges/display
   * Toggle badge display preference
   */
  async handleUpdateBadgeDisplay(
    request: Request,
    env: Env,
    userId: string,
  ): Promise<Response> {
    const sessionManager = new SessionManager();
    const sessionSecret = env.SESSION_SECRET;
    const session = await sessionManager.getSession(
      request,
      sessionSecret,
      env,
    );

    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only user can update their own badge display
    if (session.userId !== userId) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const db = createPrisma(env);

    try {
      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { badgeSchema } = await import("./schemas.js");

      const validation = await validateRequest(request, badgeSchema);
      if (!validation.success) {
        return validation.error;
      }
      const { showVerifiedBadge } = validation.data;

      // showVerifiedBadge is already validated by Zod schema (must be boolean)

      await db.user.update({
        where: { id: userId },
        data: { showVerifiedBadge },
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      getLogger().error(
        "[BadgeHandler] Error updating badge display:",
        error,
      );
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
