/**
 * Parental Link Handler
 *
 * Manages parental/guardian links for child accounts.
 * Supports creating, confirming, revoking, and listing parental links.
 */

import { createPrisma } from "../db.js";
import type { Env } from "../env.js";
import { computeAgeTier } from "./age-gate.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import type { TrellisRequestContext } from "./request-context.js";
import type { Session } from "./session-cookie.js";

export class ParentalLinkHandler {
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.logger = getLogger();
  }

  /**
   * Create a PENDING parental link.
   *
   * Only callable by the child's session or during registration.
   * Validates: guardian email exists, child ageTier is CHILD, no duplicate link.
   */
  async createLink(
    childId: string,
    guardianEmail: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const db = createPrisma(env, requestContext.region);

      // Verify the session user is the child
      if (session.userId !== childId) {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "Only the child account can create a parental link",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Look up the child user and verify age tier
      const child = await db.user.findUnique({
        where: { id: childId },
        select: { id: true, dateOfBirth: true },
      });

      if (!child) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Child user not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Verify the child is actually a CHILD tier
      if (!child.dateOfBirth || computeAgeTier(child.dateOfBirth) !== "CHILD") {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "Parental links can only be created for child-tier accounts",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Look up the guardian by email
      const guardian = await db.user.findUnique({
        where: { email: guardianEmail },
        select: { id: true },
      });

      if (!guardian) {
        return new Response(
          JSON.stringify({
            error: "NOT_FOUND",
            message: "Guardian user not found",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Check for duplicate link
      const existing = await db.parentalLink.findFirst({
        where: {
          childId: childId,
          guardianId: guardian.id,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      });

      if (existing) {
        return new Response(
          JSON.stringify({
            error: "CONFLICT",
            message: "A parental link already exists between these users",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }

      // Create the pending link
      const link = await db.parentalLink.create({
        data: {
          childId: childId,
          guardianId: guardian.id,
          status: "PENDING",
        },
      });

      this.logger.info("[ParentalLinkHandler] Created parental link", {
        linkId: link.id,
        childId,
        guardianId: guardian.id,
      });

      return new Response(JSON.stringify(link), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      this.logger.error("[ParentalLinkHandler] Failed to create link", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Confirm a pending parental link.
   *
   * Only callable by the guardian. Sets status to ACTIVE and sets confirmedAt.
   */
  async confirmLink(
    linkId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const db = createPrisma(env, requestContext.region);

      const link = await db.parentalLink.findUnique({
        where: { id: linkId },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Parental link not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Only the guardian can confirm
      if (link.guardianId !== session.userId) {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "Only the guardian can confirm this link",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      if (link.status !== "PENDING") {
        return new Response(
          JSON.stringify({
            error: "CONFLICT",
            message: "Link is not in PENDING status",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }

      const updated = await db.parentalLink.update({
        where: { id: linkId },
        data: {
          status: "ACTIVE",
          confirmedAt: new Date(),
        },
      });

      this.logger.info("[ParentalLinkHandler] Confirmed parental link", {
        linkId,
        guardianId: session.userId,
      });

      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      this.logger.error("[ParentalLinkHandler] Failed to confirm link", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Revoke an active parental link.
   *
   * Callable by either the child or the guardian.
   */
  async revokeLink(
    linkId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const db = createPrisma(env, requestContext.region);

      const link = await db.parentalLink.findUnique({
        where: { id: linkId },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "NOT_FOUND", message: "Parental link not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // Either party can revoke
      if (link.childId !== session.userId && link.guardianId !== session.userId) {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "Only the child or guardian can revoke this link",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const updated = await db.parentalLink.update({
        where: { id: linkId },
        data: {
          status: "REVOKED",
        },
      });

      this.logger.info("[ParentalLinkHandler] Revoked parental link", {
        linkId,
        revokedBy: session.userId,
      });

      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      this.logger.error("[ParentalLinkHandler] Failed to revoke link", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get all parental links where the user is either the child or guardian.
   */
  async getLinksForUser(
    userId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    try {
      const db = createPrisma(env, requestContext.region);

      // Only allow users to view their own links
      if (session.userId !== userId) {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "You can only view your own parental links",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const links = await db.parentalLink.findMany({
        where: {
          OR: [{ childId: userId }, { guardianId: userId }],
        },
        orderBy: { createdAt: "desc" },
      });

      return new Response(JSON.stringify({ links }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      this.logger.error("[ParentalLinkHandler] Failed to get links", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
