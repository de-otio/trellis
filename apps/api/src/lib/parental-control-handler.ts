/**
 * Parental Control Handler
 *
 * Manages guardian-child relationships and parental control settings.
 * Guardians can view and manage privacy settings for linked CHILD accounts.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";
import { applyPrivacyLocks, getPrivacyDefaults, type PrivacySettings } from "./privacy-defaults.js";

export class ParentalControlHandler {
  /**
   * List children linked to a guardian.
   */
  async getChildren(guardianId: string, env: Env): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      const links = await db.parentalLink.findMany({
        where: { guardianId, status: "ACTIVE" },
        include: {
          child: {
            select: {
              id: true,
              email: true,
              ageTier: true,
              profileVisibility: true,
            },
          },
        },
      });

      const children = links.map((link: any) => ({
        id: link.child.id,
        email: link.child.email,
        ageTier: link.child.ageTier,
        profileVisibility: link.child.profileVisibility,
      }));

      return new Response(JSON.stringify({ children }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      logger.error("Error fetching children:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get privacy settings for a linked child.
   */
  async getChildSettings(guardianId: string, childId: string, env: Env): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "No active parental link found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const child = await db.user.findUnique({ where: { id: childId } });
      if (!child) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "Child not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (child.ageTier !== "CHILD") {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "User is not a child account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const settings: PrivacySettings = {
        stealthMode: child.stealthMode,
        showOnlineStatus: child.showOnlineStatus,
        showTypingIndicator: child.showTypingIndicator,
        showLastSeen: child.showLastSeen,
        locationTrackingEnabled: child.locationTrackingEnabled,
        locationAnonymizationLevel: child.locationAnonymizationLevel,
        analyticsOptOut: child.analyticsOptOut,
        profileVisibility: child.profileVisibility,
        dmAccess: child.dmAccess,
      };

      return new Response(
        JSON.stringify({
          settings,
          quietHours: {
            enabled: child.quietHoursEnabled,
            start: child.quietHoursStart,
            end: child.quietHoursEnd,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error fetching child settings:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Update privacy settings for a linked child.
   * Locked fields are enforced — cannot be loosened below defaults.
   */
  async updateChildSettings(
    guardianId: string,
    childId: string,
    settings: Partial<PrivacySettings>,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "No active parental link found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const child = await db.user.findUnique({ where: { id: childId } });
      if (!child) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "Child not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (child.ageTier !== "CHILD") {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "User is not a child account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Merge incoming settings with current values
      const currentSettings: PrivacySettings = {
        stealthMode: child.stealthMode,
        showOnlineStatus: child.showOnlineStatus,
        showTypingIndicator: child.showTypingIndicator,
        showLastSeen: child.showLastSeen,
        locationTrackingEnabled: child.locationTrackingEnabled,
        locationAnonymizationLevel: child.locationAnonymizationLevel,
        analyticsOptOut: child.analyticsOptOut,
        profileVisibility: child.profileVisibility,
        dmAccess: child.dmAccess,
      };

      const merged: PrivacySettings = { ...currentSettings, ...settings };

      // Apply locks — locked fields snap back to age-tier defaults
      const locked = applyPrivacyLocks(merged, "CHILD");

      await db.user.update({
        where: { id: childId },
        data: {
          stealthMode: locked.stealthMode,
          showOnlineStatus: locked.showOnlineStatus,
          showTypingIndicator: locked.showTypingIndicator,
          showLastSeen: locked.showLastSeen,
          locationTrackingEnabled: locked.locationTrackingEnabled,
          locationAnonymizationLevel: locked.locationAnonymizationLevel,
          analyticsOptOut: locked.analyticsOptOut,
          profileVisibility: locked.profileVisibility,
          dmAccess: locked.dmAccess,
        },
      });

      return new Response(
        JSON.stringify({ settings: locked }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error updating child settings:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Set quiet hours for a linked child.
   * Start and end are in minutes from midnight (0-1439).
   */
  async setQuietHours(
    guardianId: string,
    childId: string,
    start: number,
    end: number,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      if (
        !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || start > 1439 ||
        end < 0 || end > 1439
      ) {
        return new Response(
          JSON.stringify({ error: "Bad request", message: "start and end must be integers between 0 and 1439" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "No active parental link found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const child = await db.user.findUnique({ where: { id: childId } });
      if (!child) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "Child not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (child.ageTier !== "CHILD") {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "User is not a child account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      await db.user.update({
        where: { id: childId },
        data: {
          quietHoursStart: start,
          quietHoursEnd: end,
          quietHoursEnabled: true,
        },
      });

      return new Response(
        JSON.stringify({ quietHours: { enabled: true, start, end } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error setting quiet hours:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Set DM access for a linked child.
   * Only NOBODY or CONNECTIONS are allowed for CHILD accounts (not ANYONE).
   */
  async setDmAccess(
    guardianId: string,
    childId: string,
    dmAccess: string,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      if (dmAccess !== "NOBODY" && dmAccess !== "CONNECTIONS") {
        return new Response(
          JSON.stringify({ error: "Bad request", message: "DM access for child accounts must be NOBODY or CONNECTIONS" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "No active parental link found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const child = await db.user.findUnique({ where: { id: childId } });
      if (!child) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "Child not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (child.ageTier !== "CHILD") {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "User is not a child account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      await db.user.update({
        where: { id: childId },
        data: { dmAccess: dmAccess as any },
      });

      return new Response(
        JSON.stringify({ dmAccess }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error setting DM access:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Set profile visibility for a linked child.
   */
  async setProfileVisibility(
    guardianId: string,
    childId: string,
    visibility: string,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      if (visibility !== "PUBLIC" && visibility !== "CONNECTIONS" && visibility !== "PRIVATE") {
        return new Response(
          JSON.stringify({ error: "Bad request", message: "Invalid profile visibility value" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "No active parental link found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      const child = await db.user.findUnique({ where: { id: childId } });
      if (!child) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "Child not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (child.ageTier !== "CHILD") {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "User is not a child account" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      await db.user.update({
        where: { id: childId },
        data: { profileVisibility: visibility as any },
      });

      return new Response(
        JSON.stringify({ profileVisibility: visibility }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error setting profile visibility:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Revoke a parental link between guardian and child.
   */
  async removeLink(
    guardianId: string,
    childId: string,
    env: Env,
  ): Promise<Response> {
    const { createPrisma } = await import("../db.js");
    const db = createPrisma(env);
    const logger = getLogger();

    try {
      const link = await db.parentalLink.findFirst({
        where: { guardianId, childId, status: "ACTIVE" },
      });

      if (!link) {
        return new Response(
          JSON.stringify({ error: "Not found", message: "No active parental link found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      await db.parentalLink.update({
        where: { id: link.id },
        data: { status: "REVOKED" },
      });

      return new Response(
        JSON.stringify({ status: "REVOKED" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error removing parental link:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }
}
