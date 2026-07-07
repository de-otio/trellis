/**
 * Feature-toggle gate middleware.
 *
 * Wraps a route so it behaves as if it does not exist (404) unless its global
 * `FeatureToggle` is enabled. Used to keep opt-in capabilities OFF BY DEFAULT
 * (like ActivityPub): the seed provisions the toggle row `false`, and an
 * operator flips it per environment when ready. `FeatureToggleService.isEnabled`
 * fails soft to `false`, so a missing/broken toggle keeps the feature disabled.
 *
 * 404 (not 403) is deliberate: a disabled feature is indistinguishable from a
 * non-existent route, leaking nothing about what may exist behind the flag.
 */

import type { Middleware } from "./middleware.js";

export function featureToggleMiddleware(toggleKey: string): Middleware {
  return async (context, next) => {
    const { env } = context;
    try {
      const { createPrisma } = await import("../db.js");
      const { FeatureToggleService } = await import("./feature-toggle-service.js");
      const service = new FeatureToggleService(createPrisma(env));
      // Global toggle (no tenant scope) — these capabilities gate platform-wide.
      const enabled = await service.isEnabled(toggleKey);
      if (!enabled) {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
    } catch {
      // Fail closed for an opt-in feature: if we cannot resolve the toggle,
      // treat the feature as disabled.
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return next();
  };
}
