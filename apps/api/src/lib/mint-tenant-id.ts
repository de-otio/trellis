/**
 * mintTenantId — the single core-private entry point for constructing a branded
 * {@link TenantId} from a raw string, tagged with its provenance.
 *
 * O-1 design §12.4 item 1. Centralising minting here (a) keeps the foundation
 * brand constructor (`tenantId`) reachable from exactly one place, and (b) gives
 * a forensic seam where the provenance of every minted tenant id can be logged.
 *
 * This module is **core-private**: it is NOT re-exported through
 * `@de-otio/trellis-extension-api`. An in-process extension must never be able
 * to import a way to forge a `TenantId` from a user-supplied string (Sec-15 /
 * confused-deputy defense).
 *
 * Phase 0 (this file) is the skeleton: signature + brand wrapping only. The
 * real provenance logging is wired by the L4 lane (`mintTenantId` impl +
 * provenance logging + erasure participation).
 */

import { tenantId, type TenantId } from "@de-otio/saas-foundation/tenant";

export type { TenantId };

/**
 * Where a tenant id was resolved from, stamped at the mint site for audit.
 *
 * - `"session"` — extracted from a verified session/JWT (`custom:activeTenantId`).
 * - `"ingress"` — resolved from an inbound request boundary (e.g. subdomain).
 * - `"job"` — derived from a row's `tenantId` inside a background job.
 */
export type TenantProvenance = "session" | "ingress" | "job";

/**
 * Construct a branded {@link TenantId} from a raw string.
 *
 * Throws `TenantIdValidationError` (from the foundation brand constructor) when
 * `raw` violates the tenant-id constraints — the mint site is the single point
 * where an invalid tenant id is rejected.
 *
 * @param raw        The unbranded tenant id string.
 * @param provenance Where the id came from — logged (L4) for forensic audit.
 */
export function mintTenantId(raw: string, provenance: TenantProvenance): TenantId {
  // Provenance is accepted and typed now; forensic logging is wired in L4.
  void provenance;
  return tenantId(raw);
}
