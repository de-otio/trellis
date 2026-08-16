/**
 * Fail-closed ambient-tenant guard for the Postgres graph adapter.
 *
 * ## Why this exists
 *
 * The graph modules had two different answers to "what if there is no ambient
 * tenant?":
 *
 *  - **fail-closed** — `CircleOps.requireTenant`, `DiscoveryOps`,
 *    `RelationshipOps.createRelationship`, `EntityRelationshipOps.requireTenantId`:
 *    refuse the operation.
 *  - **fail-open** — `RelationshipOps` remove/update/get/gets/getGraph,
 *    `EntityRelationshipOps.tenantScope()`, `SyncOps` remove/removeOwnership:
 *    build the `where` with `tenantId: undefined`, which Prisma **drops**, so the
 *    query silently runs across every tenant.
 *
 * The fail-open half is the defect (security review 2026-08, lane 7 HIGH-1).
 * Prisma dropping an `undefined` key is the whole problem: the code *looks*
 * scoped and is not. There is no RLS backstop today (see the opt-in RLS
 * migration under `prisma/migrations/`), so the explicit predicate is the only
 * tenant defence there is, and a caller that cannot name its tenant must be
 * refused rather than served every tenant's rows.
 *
 * ## Deployment precondition — read this before merging
 *
 * The ambient tenant is established **only when `TENANT_SCOPE_MODE !== "off"`**
 * (`app.ts`, the `runWithTenantContext` middleware), and the mode defaults to
 * `"off"`. So on a deploy with the default config every call guarded here
 * throws. That is deliberate and it is the sequencing the remediation plan
 * specifies: **L3a (set `TENANT_SCOPE_MODE=shadow`) ships before L3b (this
 * guard)**. `shadow` establishes the ambient tenant and logs divergences
 * without modifying any query, which is exactly the context these guards need.
 *
 * This is not a new class of breakage: `createRelationship` and
 * `EntityRelationshipOps.requireTenantId` have always thrown without an ambient
 * tenant, so the graph WRITE surface already required the mode to be on. This
 * change makes the READ surface agree with the write surface instead of
 * quietly serving cross-tenant rows.
 *
 * Throwing (rather than returning an empty result) keeps the failure loud: an
 * empty result is indistinguishable from "no content" and would hide a
 * misrouted call.
 */
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import { GraphAuthorizationError } from "../errors.js";

/**
 * Resolve the ambient tenant or refuse.
 *
 * @param operation `ClassName.methodName`, used in the error message so the
 *   refusing call site is identifiable from a log line alone.
 * @throws GraphAuthorizationError when no ambient tenant context is active.
 */
export function requireAmbientTenantId(operation: string) {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    throw new GraphAuthorizationError(
      `${operation}: no active tenant context — refusing to run an unscoped graph query ` +
        `(TENANT_SCOPE_MODE must not be "off"; see graph/postgres/tenant-guard.ts)`,
    );
  }
  return tenantId;
}
