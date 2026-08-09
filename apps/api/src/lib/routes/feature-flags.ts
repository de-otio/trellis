/**
 * Feature Flags Routes
 *
 * Routes for retrieving region-specific feature flags
 */

import { createPrisma } from "../../db.js";
import { addCorsHeaders } from "../../worker.js";
import { getPlatformFlags } from "../feature-flags.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware } from "../middleware.js";
import { getFeatureFlagsAsync, getRegionConfig } from "../region-config.js";
import { detectRegionSync, isValidRegion } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const featureFlagsRoutes: Route[] = [
  {
    path: "/api/feature-flags",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const url = new URL(request.url);

      try {
        // Get region from query parameter or detect from request
        const regionParam = url.searchParams.get("region");
        let region: string;

        if (regionParam && isValidRegion(regionParam)) {
          region = regionParam;
        } else {
          // Detect region from request
          region = detectRegionSync(request, env);
        }

        // Get region configuration (base config for endpoints/timeouts)
        const config = getRegionConfig(region, env as any);

        // Get feature flags with database toggle checks
        // Wrap in try-catch to handle database connection errors gracefully
        let features;
        let db: ReturnType<typeof createPrisma> | undefined;
        try {
          db = createPrisma(env);
          features = await getFeatureFlagsAsync(region, env as any, db);
        } catch (dbError) {
          logger.error(
            "[FeatureFlagsRoutes] Database error, using default config:",
            dbError,
          );
          // Fall back to default config if database fails
          features = config.features;
        }

        // `platform` block (evolvability plan §2.2/T9): additive-only,
        // resolved from FeatureToggleService GLOBAL values (this endpoint
        // is unauthenticated — no tenant context, so per-tenant overrides
        // are not reflected here; see getPlatformFlags doc comment).
        // getPlatformFlags never throws: a missing/failed db falls back to
        // all-false defaults, same tolerance as the block above.
        const platform = await getPlatformFlags(db);

        // Format response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            region: config.region,
            features: {
              authentication: features.authentication,
              application: features.features,
              performance: features.performance,
              security: features.security,
            },
            endpoints: config.endpoints,
            timeouts: config.timeouts,
            platform,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error(
          "[FeatureFlagsRoutes] Error getting feature flags:",
          error,
        );
        const validator = new Validator();
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get feature flags for a region",
  },
];
