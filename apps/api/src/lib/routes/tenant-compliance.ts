/**
 * Tenant Compliance Route
 *
 * GET /api/tenants/:id/compliance.json
 *
 * Returns the platform compliance baseline merged with tenant-specific overrides:
 *   - dataResidency.activeRegion from tenant.dataRegion
 *   - subprocessors.identityProvider from the tenant's TenantIdentityProvider row
 *   - dataMinimization.tenantSpecific.activeIntegrations
 *
 * Auth requirements:
 *   - Authenticated (401 if not)
 *   - Active tenant must match path :id (403 if cross-tenant)
 *   - Caller must hold audit.view capability (403 if GUEST/MEMBER)
 *
 * Design reference:
 *   doc/02-technical/identity-federation/11-agent-friendly-compliance.md §"Layer 2"
 */

import { corsMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { authMiddleware, requireActiveTenant } from "../auth/auth-middleware.js";
import { Capability, requireCapability } from "../auth/require.js";
import { BASELINE_COMPLIANCE } from "../compliance/baseline.js";
import { mergeTenantOverrides } from "../compliance/tenant-merge.js";
import { unauthorizedError } from "./errors.js";
import type { Route } from "./types.js";
import type { AuthContext } from "../auth/auth-context.js";
import type { Env } from "../../env.js";

const ROUTE_RE = /^\/api\/tenants\/([^/]+)\/compliance\.json$/;

async function handleComplianceRead(
  tenantId: string,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  // Cross-tenant isolation: 403 if the caller's active tenant != path tenant.
  const tenantDenied = requireActiveTenant(auth, tenantId);
  if (tenantDenied) return tenantDenied;

  // Capability gate: requires audit.view (ADMIN / OWNER / SUPER_ADMIN).
  const capDenied = requireCapability(auth, Capability.AuditView);
  if (capDenied) return capDenied;

  const { createPrisma } = await import("../../db.js");
  const db = createPrisma(env);

  // Load tenant region (all queries scoped to tenantId for isolation).
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, region: true },
  });

  if (!tenant) {
    return new Response(
      JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }

  // Load IdP row (scoped to tenantId).
  const idpRow = await db.tenantIdentityProvider.findUnique({
    where: { tenantId },
    select: {
      kind: true,
      issuerUrl: true,
    },
  });

  // LOW-5: read the region from the tenant row rather than hardcoding.
  // The `Tenant.region` column defaults to "EU" so existing rows still
  // resolve to the same value as before until they're explicitly set.
  const tenantInput = {
    region: tenant.region as string | null | undefined,
  };

  const idpInput = idpRow
    ? { kind: String(idpRow.kind), issuerUrl: idpRow.issuerUrl ?? null }
    : null;

  const merged = mergeTenantOverrides(BASELINE_COMPLIANCE, tenantInput, idpInput);

  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const tenantComplianceRoutes: Route[] = [
  {
    path: ROUTE_RE,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const securityHeaders = new SecurityHeaders(env);

      const auth = await authMiddleware(request, env);
      if (!auth) return unauthorizedError(securityHeaders);

      const tenantId = pathname.match(ROUTE_RE)?.[1] ?? "";
      const response = await handleComplianceRead(tenantId, auth, env);
      return securityHeaders.addSecurityHeaders(response);
    },
    middleware: [corsMiddleware()],
    description: "Get tenant compliance bundle (baseline + tenant overrides)",
  },
];
