/**
 * Pure tenant-id resolution for the media path (T9).
 *
 * The media upload/serve shell must scope every CAS key by a tenant
 * (`cas/{tenantId}/{hash}`, D18). The active tenant is normally ambient
 * (`getCurrentTenantId()` from the auth seam, app.ts), but `TENANT_SCOPE_MODE`
 * defaults to `"off"` and in that mode no ambient tenant is set on the request.
 *
 * ASSUMPTION (recorded per T9): when scope mode is `"off"` we fall back to the
 * uploader's `User.personalTenantId`. This mirrors the graph layer's wiring
 * (`input.tenantId ?? getCurrentTenantId()` in graph/postgres/sync.ts) — every
 * user has a personal tenant created at sign-up (post-confirmation.ts), so the
 * fallback is always available for an authenticated request. When scope mode is
 * shadow/enforce the ambient tenant is authoritative and the fallback is not
 * consulted (a missing ambient tenant in those modes is a real error, surfaced
 * by the caller, not papered over by the personal tenant).
 *
 * This module is the PURE decision; the I/O (reading the ambient ALS value and
 * loading `personalTenantId` from the DB) lives in the shell (media.ts).
 */

import type { TenantScopeMode } from "../tenant-scope.js";

export type TenantResolution =
  | { ok: true; tenantId: string; source: "ambient" | "personal-fallback" }
  | { ok: false; reason: "no-tenant" };

/**
 * Decide which tenant id scopes a media object, given the ambient tenant (may
 * be undefined), the uploader's personal tenant (may be undefined), and the
 * deploy scope mode.
 *
 * - Ambient tenant always wins when present (any mode).
 * - When scope mode is `"off"` and there is no ambient tenant, fall back to the
 *   uploader's personal tenant.
 * - In shadow/enforce with no ambient tenant, do NOT fall back — return
 *   `no-tenant` so the caller fails closed.
 */
export function resolveMediaTenantId(
  ambientTenantId: string | undefined | null,
  personalTenantId: string | undefined | null,
  scopeMode: TenantScopeMode,
): TenantResolution {
  if (ambientTenantId) {
    return { ok: true, tenantId: ambientTenantId, source: "ambient" };
  }
  if (scopeMode === "off" && personalTenantId) {
    return {
      ok: true,
      tenantId: personalTenantId,
      source: "personal-fallback",
    };
  }
  return { ok: false, reason: "no-tenant" };
}

/**
 * The same decision, for any tenant-scoped WRITE reached over a
 * cookie-authenticated path rather than a Bearer JWT (entity create — the
 * Bearer routes take the tenant from `auth.activeTenantId` instead).
 *
 * Exported under a neutral alias so a non-media caller does not have to read
 * as media code: one decision, one place to change it, one test suite.
 */
export const resolveWriteTenantId = resolveMediaTenantId;
