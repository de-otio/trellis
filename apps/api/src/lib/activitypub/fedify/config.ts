/**
 * Fedify Configuration
 *
 * Configures Fedify with application-specific settings.
 */

import type { FederationOptions } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import { getActivityPubBaseUrl } from "./context.js";
import { getLogger, Logger } from "../../logger.js";

/**
 * Get Fedify configuration from environment
 *
 * @param env - Cloudflare Workers environment variables
 * @returns Fedify configuration options
 */
export function getFedifyConfig(
  env: Env,
): Partial<FederationOptions<any>> {
  const logger = getLogger();
  const baseUrl = getActivityPubBaseUrl(env);

  logger.debug("[Fedify] Configuring Fedify", { baseUrl });

  return {
    // Base URL for ActivityPub actor URIs
    // Fedify will use this to generate actor URIs
    // Note: Fedify's CreateFederationOptions may use different property name
    ...({ url: new URL(baseUrl) } as any),

    // JSON-LD context URLs
    // Fedify handles JSON-LD serialization automatically
    // We can customize context loading if needed

    // Key pair generation
    // Fedify can generate key pairs automatically

    // HTTP signature configuration
    // Fedify handles HTTP signatures automatically
    // We'll configure key storage via the Actor Dispatcher

    // Activity delivery
    // Fedify provides activity delivery
  };
}
