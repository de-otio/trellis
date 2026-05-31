/**
 * Setup-status route.
 *
 *   GET /api/tenants/:id/setup-status
 *
 * Returns a machine-friendly tenant onboarding progress object.
 * See apps/api/src/lib/tenant/setup-status.ts for the computed shape.
 *
 * Auth requirements:
 *   - Authenticated (401 if not)
 *   - Caller's activeTenantId must match the path :id (403 if cross-tenant)
 *   - Caller must hold IdpView capability (ADMIN / OWNER / SUPER_ADMIN)
 *
 * --- Existence-leak posture (G4 MEDIUM-4, by design) ---
 *
 * The path returns a 403 for "you are authenticated but your active
 * tenant doesn't match the requested resource" and a 404 for "tenant
 * does not exist" — distinct status codes for distinct conditions.
 * That asymmetry intentionally lets a caller who already knows the
 * target tenant id distinguish "I don't have access" from "this id is
 * unused", which the federation onboarding flow needs (an admin
 * scripting setup must be able to check whether a tenant they expect
 * to exist actually exists). The threat model accepts this leak: tenant
 * ids are only known to authenticated callers via tenant switching, and
 * an existence probe leaks no PII.
 *
 * Data-side reads that lookup arbitrary cross-tenant resources should
 * use `requireOwnTenant` (404 for both conditions) instead. Admin-side
 * mutation paths use `requireActiveTenant` (this 403 path) per the
 * pattern documented at the helper site.
 */

import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { authMiddleware, requireActiveTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { loadSetupStatus } from "../tenant/setup-status.js";
import { structuredError, unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";

const SETUP_STATUS_RE = /^\/api\/tenants\/([^/]+)\/setup-status$/;

export const setupStatusRoutes: Route[] = [
  {
    path: SETUP_STATUS_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);

      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(SETUP_STATUS_RE)?.[1] ?? "";

      // Cross-tenant isolation: 403 when activeTenantId !== path tenantId.
      const tenantDenied = requireActiveTenant(auth, tenantId);
      if (tenantDenied) {
        return securityHeaders.addSecurityHeaders(
          structuredError(403, {
            error: "FORBIDDEN",
            message: "Active tenant does not match the requested resource.",
            remediation: "Switch to the correct tenant using POST /api/auth/switch-tenant before retrying.",
          }),
        );
      }

      // Capability gate — requires IdpView (ADMIN / OWNER).
      const capDenied = requireCapability(auth, Capability.IdpView);
      if (capDenied) {
        return securityHeaders.addSecurityHeaders(
          structuredError(403, {
            error: "FORBIDDEN",
            message: "You do not have permission to view setup status for this tenant.",
            remediation: "Request ADMIN or OWNER role from your tenant administrator.",
          }),
        );
      }

      const status = await loadSetupStatus(tenantId, env);

      if (!status) {
        return securityHeaders.addSecurityHeaders(
          structuredError(404, {
            error: "NOT_FOUND",
            message: "Tenant not found.",
            remediation: "Verify the tenant ID in the URL.",
          }),
        );
      }

      return securityHeaders.addSecurityHeaders(
        new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    middleware: [corsMiddleware()],
    description: "Get tenant setup-status (machine-friendly onboarding progress)",
  },
];
