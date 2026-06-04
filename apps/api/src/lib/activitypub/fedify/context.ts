/**
 * Fedify Context Setup
 *
 * Creates and configures the Fedify context for Cloudflare Workers.
 * This is the main entry point for Fedify integration.
 */

import { createFederation, type Federation } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import { getFedifyConfig } from "./config.js";
import { getLogger, Logger } from "../../logger.js";

/**
 * Get or create Fedify context for Cloudflare Workers
 *
 * @param env - Cloudflare Workers environment variables
 * @returns Fedify Federation instance configured for Cloudflare Workers
 */
export function getFedifyContext(env: Env): Federation<any> {
  const logger = getLogger();
  const config = getFedifyConfig(env);

  // Fedify automatically detects Cloudflare Workers environment
  // and uses global fetch, crypto, etc.
  const federation = createFederation(config as any);

  logger.debug("[Fedify] Created Federation instance");

  return federation;
}

/**
 * Get base URL for ActivityPub from environment
 * Uses APP_DOMAIN or ACTIVITYPUB_BASE_URL if available
 */
export function getActivityPubBaseUrl(env: Env, requestUrl?: string): string {
  // Use requestUrl first if provided (highest priority)
  if (requestUrl) {
    try {
      const url = new URL(requestUrl);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through
    }
  }

  // Try APP_DOMAIN
  if (env.APP_DOMAIN) {
    try {
      const url = new URL(env.APP_DOMAIN);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through
    }
  }

  // Try ACTIVITYPUB_BASE_URL if set
  if (env.ACTIVITYPUB_BASE_URL) {
    try {
      const url = new URL(env.ACTIVITYPUB_BASE_URL);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      // Invalid URL, fall through
    }
  }

  // Default fallback
  return "https://example.com";
}
