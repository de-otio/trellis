/**
 * App metadata routes — the client version policy.
 *
 * `GET /api/app/version-policy` is the one endpoint a client may call BEFORE
 * it knows whether it is still supported, so it is deliberately the cheapest
 * thing in the API:
 *
 *   - unauthenticated and session-free (no cookie, no Bearer, no CSRF);
 *   - **no DB and no KV read** — the whole body comes from four optional
 *     environment variables (strictly cheaper than the `/api/feature-flags`
 *     precedent, which does hit the database);
 *   - cacheable (`Cache-Control: public, max-age=300`), because every client
 *     polls it and the value changes at deploy cadence, not request cadence.
 *
 * CORS: the body is public, credential-free data, so it is served with
 * `Access-Control-Allow-Origin: *` and NO `Access-Control-Allow-Credentials`.
 * The default reflected-origin + credentials `corsMiddleware` is deliberately
 * NOT attached: a shared cache in front of a reflected-origin response is the
 * classic cache-poisoning shape. `Vary: Origin` is set anyway so any
 * intermediary that also sees an origin-varying response for this path keeps
 * the entries separate.
 *
 * Unset policy => every field is `null` => the mechanism is dormant and the
 * 426 backstop is a no-op. That is the shipped default.
 */

import { resolveVersionPolicy } from "../client-version.js";
import { SecurityHeaders } from "../security-headers.js";
import type { Route } from "./types.js";

/** Public, cacheable, credential-free. See the file header. */
const VERSION_POLICY_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
  vary: "Origin",
};

export const appMetaRoutes: Route[] = [
  {
    path: "/api/app/version-policy",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const policy = resolveVersionPolicy(env);
      return securityHeaders.createSecureResponse(JSON.stringify(policy), {
        status: 200,
        headers: { ...VERSION_POLICY_HEADERS },
      });
    },
    publicSpec: true,
    description:
      "Client version policy: minimum/recommended app version and store URLs (all nullable when unset)",
  },
];
