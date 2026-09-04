/**
 * Age Gate Middleware
 *
 * Injects `featureAccess` into the request context for authenticated
 * requests.
 *
 * **The tier is ADULT for every session**, and that is deliberate, not a
 * side-effect. Minor tiers are quarantined behind
 * `age-gate.ts`'s `MINOR_TIERS_SUPPORTED` (see the 18+ decision documented
 * there), so resolution goes through `resolveSessionAgeTier`, which returns
 * ADULT even for a session that explicitly carries `ageTier: "CHILD"`.
 *
 * This used to read `session.ageTier ?? "ADULT"`, which produced ADULT too —
 * but only because no token path ever populated the field. That is an
 * accident, not a guarantee: it would have silently started gating the moment
 * a claim carried a tier. The behaviour is now a property of one tested
 * function.
 */

import type { Middleware } from "./middleware.js";
import {
  getFeatureAccess,
  resolveSessionAgeTier,
  type FeatureAccess,
} from "./age-gate.js";

// Extend TrellisRequestContext with optional featureAccess
declare module "./request-context.js" {
  interface TrellisRequestContext {
    featureAccess?: FeatureAccess;
  }
}

/**
 * Middleware that resolves the request's age tier and attaches the matching
 * feature access to the request context. See the module header: the resolved
 * tier is ADULT for every session while minor tiers are quarantined.
 */
export function ageGateMiddleware(): Middleware {
  return async (context, next) => {
    const { requestContext } = context;

    // Only inject if we have a request context with a session
    if (requestContext?.session) {
      const ageTier = resolveSessionAgeTier(requestContext.session.ageTier);
      requestContext.featureAccess = getFeatureAccess(ageTier);
    }

    return next();
  };
}
