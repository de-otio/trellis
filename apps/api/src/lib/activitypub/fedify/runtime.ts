/**
 * Fedify Runtime Adapter for Cloudflare Workers
 *
 * Fedify automatically uses Cloudflare Workers' global fetch and crypto APIs.
 * No special runtime adapter is needed - Fedify detects the environment.
 */

import type { Env } from "../../../env.js";
import { getLogger, Logger } from "../../logger.js";

/**
 * Get Fedify context data for Cloudflare Workers
 *
 * Fedify uses the global fetch and crypto APIs available in Cloudflare Workers.
 * This function can be used to provide environment-specific context if needed.
 *
 * @param env - Cloudflare Workers environment variables
 * @returns Context data (currently empty, can be extended)
 */
export function getFedifyContextData(env: Env): Record<string, unknown> {
  const logger = getLogger();
  logger.debug("[Fedify] Getting context data for Cloudflare Workers");

  // Return empty context - Fedify will use global fetch/crypto automatically
  return {};
}
