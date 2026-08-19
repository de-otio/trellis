/**
 * The single choke point for claims-cache invalidation.
 *
 * ## Why this module exists
 *
 * The Cognito pre-token-generation Lambda re-derives every authorization claim
 * (`custom:userId`, `custom:role`, `custom:activeTenantId`, `custom:tenantSlug`,
 * `custom:tenantRole`) from Postgres on each issuance and never reads them from
 * `event.request.userAttributes` — so the stored Cognito attributes are inert.
 * Good.
 *
 * But it reads *through* a claims cache keyed by the Cognito `sub` with a
 * ~1 hour TTL (`claims-cache.ts`), and **a cache hit skips the RDS read
 * entirely — including the suspension and tenant-status checks**
 * (`lambda/pre-token-generation.ts`, the "G2 finding H3" note). The freshness
 * of that cache is therefore the real authorization boundary: any admin path
 * that changes a user's authorization state without invalidating leaves the
 * OLD privileges mintable into brand-new JWTs for up to the TTL.
 *
 * Before this module, invalidation was open-coded per call site: two copies in
 * `user-deprovisioning.ts` and a private helper in `tenant/member-handler.ts`.
 * Two privilege-changing paths had simply been missed. Scattered duplication is
 * why — so the fix is one function, called by every mutation, plus a test that
 * fails when a new mutation site forgets it.
 *
 * ## Contract
 *
 * - Invalidation is **best effort by default**: a claims-cache outage must not
 *   block a suspension or a role change from being written to Postgres. The
 *   durable state is the DB row; the cache converges within one TTL regardless.
 *   Failures are logged, never thrown.
 * - Callers must invalidate **after** the DB write commits. Invalidating first
 *   races a concurrent token issuance that would re-populate the cache from the
 *   pre-change row.
 * - For a transfer of ownership (or any change affecting two identities),
 *   invalidate **both** subjects.
 */

import { getLogger } from "../logger.js";
import { createClaimsCacheFromEnv, type ClaimsCache } from "./claims-cache.js";

/**
 * Test seam: inject a `ClaimsCache` (e.g. one over a `MemoryKvStore`) so unit
 * tests can assert invalidation without a live KV backend. Pass `null` to
 * restore the env-resolved cache.
 * @internal
 */
let injectedCache: ClaimsCache | null = null;
export function __setClaimsCacheForInvalidationTest(
  cache: ClaimsCache | null,
): void {
  injectedCache = cache;
}

function resolveCache(): ClaimsCache {
  return injectedCache ?? createClaimsCacheFromEnv();
}

/** Minimal shape of the Prisma client this module needs. */
interface UserSubjectReader {
  user: {
    findUnique(args: {
      where: { id: string };
      select: { subject: true };
    }): Promise<{ subject: string | null } | null>;
  };
}

/**
 * Invalidate the cached claims for one or more Cognito subjects.
 *
 * Call this AFTER committing any change to a user's authorization state:
 * suspension/unsuspension, tenant-member role change, member removal, OWNER
 * transfer, global-role change, or a new tenant membership.
 *
 * `null`/`undefined`/empty subjects are skipped (a user provisioned without a
 * Cognito identity has nothing cached), and duplicates are collapsed.
 *
 * @param reason short, filterable label for the log line (e.g. `"member.remove"`)
 */
export async function invalidateClaims(
  subjects: ReadonlyArray<string | null | undefined>,
  reason: string,
): Promise<void> {
  const unique = [...new Set(subjects.filter((s): s is string => !!s))];
  if (unique.length === 0) return;

  let cache: ClaimsCache;
  try {
    cache = resolveCache();
  } catch (err) {
    getLogger().warn("[ClaimsInvalidation] Could not resolve the claims cache", {
      reason,
      error: String(err),
    });
    return;
  }

  await Promise.all(
    unique.map(async (sub) => {
      try {
        await cache.invalidate(sub);
      } catch (err) {
        // Best effort — see the contract note above. The DB row is already
        // authoritative; the cache converges within one TTL.
        getLogger().warn("[ClaimsInvalidation] Invalidation failed", {
          reason,
          error: String(err),
        });
      }
    }),
  );
}

/**
 * Look the Cognito `subject` up by trellis `User.id` and invalidate it.
 *
 * For call sites that hold a user id but not a subject. Prefer
 * {@link invalidateClaims} where the subject is already in hand — it avoids the
 * extra read, and (more importantly) lets the caller select the subject
 * *before* the mutation, which is the only way to get it for a row the
 * mutation removes.
 */
export async function invalidateClaimsForUserId(
  db: UserSubjectReader,
  userId: string,
  reason: string,
): Promise<void> {
  let subject: string | null = null;
  try {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: { subject: true },
    });
    subject = row?.subject ?? null;
  } catch (err) {
    getLogger().warn("[ClaimsInvalidation] Subject lookup failed", {
      reason,
      error: String(err),
    });
    return;
  }
  await invalidateClaims([subject], reason);
}
