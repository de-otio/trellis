/**
 * ActivityPub Standalone Mode Helper
 *
 * Provides efficient checking of the ActivityPub Standalone Mode feature toggle.
 * In standalone mode, the application runs ActivityPub protocol features locally
 * only, without federation (no remote activities, deliveries, or fetches).
 */

import type { Env } from "../../env.js";
import type { PrismaClient } from "@prisma/client";
import { getLogger, Logger } from "../logger.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../db-query-helper.js";
import { detectRegionSync } from "../region-detection.js";

const STANDALONE_MODE_TOGGLE_KEY = "activitypub_standalone_mode_enabled";

/**
 * Check if ActivityPub Standalone Mode is enabled
 *
 * This function efficiently checks the feature toggle with:
 * - Database query timeout protection
 * - Graceful degradation (defaults to false if toggle doesn't exist)
 * - Error handling
 *
 * @param db - Prisma client (optional, will use shared connection manager if not provided)
 * @param env - Cloudflare Workers environment
 * @param request - Request object (optional, for region detection)
 * @returns True if standalone mode is enabled, false otherwise
 */
export async function isStandaloneModeEnabled(
  env: Env,
  db?: PrismaClient,
  request?: Request,
): Promise<boolean> {
  const logger = getLogger();

  try {
    // If database provided, use it directly (most efficient)
    if (db) {
      const { FeatureToggleService } = await import(
        "../feature-toggle-service.js"
      );
      const toggleService = new FeatureToggleService(db);
      return await toggleService.isEnabled(STANDALONE_MODE_TOGGLE_KEY);
    }

    // Otherwise, use shared connection manager with region detection
    const region = request ? detectRegionSync(request, env) : "EU";
    const dbManager = sharedDatabaseConnectionManager;

    const result = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (client) => {
        const { FeatureToggleService } = await import(
          "../feature-toggle-service.js"
        );
        const toggleService = new FeatureToggleService(client);
        return await toggleService.isEnabled(STANDALONE_MODE_TOGGLE_KEY);
      },
      {
        ...QueryTimeoutPresets.STANDARD, // Use STANDARD preset
        defaultValue: false, // Default to false (federation enabled) if query fails
        context: {
          operation: "checkStandaloneMode",
        },
      },
    );

    return result ?? false;
  } catch (error) {
    logger.error(
      "[StandaloneMode] Error checking standalone mode toggle:",
      error,
    );
    // Fail-safe: default to false (federation enabled) on error
    return false;
  }
}

/**
 * Check if a URI is remote (not from this server)
 *
 * Helper function to determine if a URI belongs to a remote server.
 *
 * @param uri - URI to check
 * @param env - Cloudflare Workers environment
 * @returns True if URI is remote, false if local
 */
export function isRemoteUri(uri: string, env: Env): boolean {
  // Get base URL directly from env to avoid circular dependencies
  // Try ACTIVITYPUB_BASE_URL first, then APP_DOMAIN, then default
  let baseUrl = "https://example.com";
  if (env.ACTIVITYPUB_BASE_URL) {
    try {
      const url = new URL(env.ACTIVITYPUB_BASE_URL);
      baseUrl = `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, use default
    }
  } else if (env.APP_DOMAIN) {
    try {
      const url = new URL(env.APP_DOMAIN);
      baseUrl = `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, use default
    }
  }
  // Compare parsed origins rather than a string prefix, so a host like
  // "example.com.attacker.com" cannot masquerade as local.
  try {
    return new URL(uri).origin !== new URL(baseUrl).origin;
  } catch {
    // Unparseable URI — treat as remote (untrusted).
    return true;
  }
}
