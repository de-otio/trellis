/**
 * Age Gate Middleware
 *
 * Reads ageTier from the session and injects featureAccess into the request context.
 * Defaults to ADULT access if no ageTier is present on the session.
 */

import type { Middleware } from "./middleware.js";
import { getFeatureAccess, type FeatureAccess } from "./age-gate.js";

// Extend TrellisRequestContext with optional featureAccess
declare module "./request-context.js" {
  interface TrellisRequestContext {
    featureAccess?: FeatureAccess;
  }
}

/**
 * Middleware that computes feature access based on the session's ageTier
 * and attaches it to the request context.
 */
export function ageGateMiddleware(): Middleware {
  return async (context, next) => {
    const { requestContext } = context;

    // Only inject if we have a request context with a session
    if (requestContext?.session) {
      const ageTier = requestContext.session.ageTier ?? "ADULT";
      requestContext.featureAccess = getFeatureAccess(ageTier);
    }

    return next();
  };
}
