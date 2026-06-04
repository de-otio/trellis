import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Privacy Handler class for managing user privacy preferences
 *
 * This handler manages GDPR-compliant privacy preferences.
 * Currently uses KV for storage, but can be extended to use Salesforce Individual object.
 */

import { Session } from "./session-cookie.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface PrivacyPreferences {
  hasOptedOutTracking: boolean;
  hasOptedOutProcessing: boolean;
  hasOptedOutEmail: boolean;
  profilePrivacy: "Public" | "Followers" | "Private";
  postVisibility: "public" | "friends-only" | "private";
}

export interface Env {
  PRIVACY_PREFERENCES_KV?: KVNamespace; // Optional KV namespace for privacy preferences
  DATABASE_URL?: string; // Database URL for user suspension
  SECURITY_WEBHOOK_URL?: string; // Security webhook URL
  // Future: Salesforce connection for full GDPR compliance
}

export class PrivacyHandler {
  /**
   * Get privacy preferences for a user
   */
  async getPreferences(
    session: Session,
    env: Env,
  ): Promise<PrivacyPreferences | null> {
    try {
      // Try to get from KV if available
      if (env.PRIVACY_PREFERENCES_KV) {
        const key = `privacy:${session.userId}`;
        const stored = await env.PRIVACY_PREFERENCES_KV.get(key, "json");
        if (stored) {
          return stored as PrivacyPreferences;
        }
      }

      // Return null if no preferences found (frontend will use defaults)
      return null;
    } catch (error) {
      getLogger().error(
        "Error getting privacy preferences:",
        error,
      );
      return null;
    }
  }

  /**
   * Update privacy preferences for a user
   */
  async updatePreferences(
    session: Session,
    preferences: PrivacyPreferences,
    env: Env,
  ): Promise<void> {
    try {
      // Validate preferences
      if (!this.validatePreferences(preferences)) {
        throw new Error("Invalid privacy preferences");
      }

      // Store in KV if available
      if (env.PRIVACY_PREFERENCES_KV) {
        const key = `privacy:${session.userId}`;
        await env.PRIVACY_PREFERENCES_KV.put(key, JSON.stringify(preferences));
      }

      // TODO: Future implementation - sync to Salesforce Individual object
      // This would use the getIndividualPreferences and updateIndividualPreferences
      // functions from the GDPR documentation
    } catch (error) {
      getLogger().error(
        "Error updating privacy preferences:",
        error,
      );
      throw error;
    }
  }

  /**
   * Validate privacy preferences
   */
  private validatePreferences(
    preferences: any,
  ): preferences is PrivacyPreferences {
    if (!preferences || typeof preferences !== "object") {
      return false;
    }

    // Check required fields
    if (
      typeof preferences.hasOptedOutTracking !== "boolean" ||
      typeof preferences.hasOptedOutProcessing !== "boolean" ||
      typeof preferences.hasOptedOutEmail !== "boolean"
    ) {
      return false;
    }

    // Check profilePrivacy enum
    if (
      !["Public", "Followers", "Private"].includes(preferences.profilePrivacy)
    ) {
      return false;
    }

    // Check postVisibility enum
    if (
      !["public", "friends-only", "private"].includes(
        preferences.postVisibility,
      )
    ) {
      return false;
    }

    return true;
  }

  /**
   * Handle GET request for privacy preferences
   */
  async handleGetPreferences(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const preferences = await this.getPreferences(session, env);

      if (!preferences) {
        // Return 404 if no preferences found (frontend will use defaults)
        return new Response(
          JSON.stringify({ error: "Preferences not found" }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify(preferences), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error handling get preferences:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get privacy preferences" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Handle PUT request for privacy preferences
   */
  async handleUpdatePreferences(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const body = await request.json();
      const preferences = body as PrivacyPreferences;

      await this.updatePreferences(session, preferences, env);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error(
        "Error handling update preferences:",
        error,
      );
      return new Response(
        JSON.stringify({
          error: error.message || "Failed to update privacy preferences",
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

}
