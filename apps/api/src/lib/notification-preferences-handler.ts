/**
 * Notification Preferences Handler
 *
 * Manages user notification preferences. CHILD users cannot edit
 * their own preferences (must be managed by guardian).
 * Part of Stream C: Notifications.
 */

import type { Env } from "../env.js";
import { createPrisma } from "../db.js";
import { getLogger, Logger } from "./logger.js";

export interface NotificationPreferenceInput {
  dmEnabled: boolean;
  followEnabled: boolean;
  digestEnabled: boolean;
  systemEnabled: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferenceInput = {
  dmEnabled: true,
  followEnabled: true,
  digestEnabled: true,
  systemEnabled: true,
};

export class NotificationPreferencesHandler {
  /**
   * Get notification preferences for a user.
   * Returns defaults if no stored preferences exist.
   */
  async getPreferences(userId: string, env: Env): Promise<Response> {
    const logger = getLogger();
    const db = createPrisma(env);

    try {
      const prefs = await db.notificationPreference.findUnique({
        where: { userId },
      });

      const result = prefs
        ? {
            dmEnabled: prefs.dmEnabled,
            followEnabled: prefs.followEnabled,
            digestEnabled: prefs.digestEnabled,
            systemEnabled: prefs.systemEnabled,
          }
        : DEFAULT_PREFERENCES;

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      logger.error("Error getting notification preferences:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get notification preferences" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    } finally {
      await db.release();
    }
  }

  /**
   * Update notification preferences.
   * CHILD users cannot edit their own preferences (403).
   */
  async updatePreferences(
    userId: string,
    ageTier: string,
    preferences: Partial<NotificationPreferenceInput>,
    env: Env,
  ): Promise<Response> {
    const logger = getLogger();
    const db = createPrisma(env);

    try {
      // CHILD cannot edit own preferences
      if (ageTier === "CHILD") {
        return new Response(
          JSON.stringify({
            error: "FORBIDDEN",
            message: "Child accounts cannot modify notification preferences",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Validate preference values are booleans
      const validKeys: (keyof NotificationPreferenceInput)[] = [
        "dmEnabled",
        "followEnabled",
        "digestEnabled",
        "systemEnabled",
      ];

      const updateData: Record<string, boolean> = {};
      for (const key of validKeys) {
        if (key in preferences) {
          const value = preferences[key];
          if (typeof value !== "boolean") {
            return new Response(
              JSON.stringify({
                error: "VALIDATION_ERROR",
                message: `Invalid value for ${key}: must be a boolean`,
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          updateData[key] = value;
        }
      }

      if (Object.keys(updateData).length === 0) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "No valid preference fields provided",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const result = await db.notificationPreference.upsert({
        where: { userId },
        create: {
          userId,
          ...DEFAULT_PREFERENCES,
          ...updateData,
        },
        update: updateData,
      });

      return new Response(
        JSON.stringify({
          dmEnabled: result.dmEnabled,
          followEnabled: result.followEnabled,
          digestEnabled: result.digestEnabled,
          systemEnabled: result.systemEnabled,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      logger.error("Error updating notification preferences:", error);
      return new Response(
        JSON.stringify({ error: "Failed to update notification preferences" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    } finally {
      await db.release();
    }
  }
}
