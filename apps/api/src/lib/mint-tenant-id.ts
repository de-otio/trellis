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
 * Provenance is logged at every mint site (L4, this module) as
 * defense-in-depth / forensic audit trail — it is **NOT a security
 * boundary**. The boundary is the brand constructor itself (`tenantId`,
 * unreachable outside this module) plus the scoped-DB proxy (L1) that
 * enforces isolation on every op. Logging provenance lets an operator
 * reconstruct, after the fact, whether a given tenant id reached a scoped
 * op via a verified session, a request-ingress boundary, or a background
 * job row — useful for incident forensics, never load-bearing for
 * correctness.
 */

import { tenantId, type TenantId } from "@de-otio/saas-foundation/tenant";
import { getLogger } from "./logger.js";

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
 * @param provenance Where the id came from — logged for forensic audit.
 *                    NOT a security boundary (see module doc).
 */
export function mintTenantId(raw: string, provenance: TenantProvenance): TenantId {
  const branded = tenantId(raw);
  // Logged AFTER a successful brand — an invalid raw never reaches here
  // (the foundation constructor throws first), so this line only fires for
  // tenant ids that actually got minted.
  getLogger().debug("mintTenantId: tenant id minted", {
    provenance,
    tenantId: branded,
  });
  return branded;
}
