// Pure functional-core unit — no I/O, no AWS SDK, no network, no Date.now.
// T16: per-tenant storage-quota resolution (override ?? env default).

import type { QuotaLimits } from "./quota-types.js";

/**
 * The per-tenant quota override columns (Tenant.storageQuotaBytes /
 * Tenant.storageQuotaObjects). NULL means "no override — use the platform
 * default from Env.media.uploadQuota" (the SSM-fed free-tier value; never a
 * compiled literal). Prisma surfaces BigInt columns as `bigint`; the shape
 * also admits `number` so fakes/tests and future non-Prisma callers work.
 */
export interface TenantQuotaOverride {
  readonly storageQuotaBytes: bigint | number | null;
  readonly storageQuotaObjects: number | null;
}

/**
 * Resolve the EFFECTIVE quota limits for a tenant:
 *
 *   effectiveMaxBytes   = tenant.storageQuotaBytes   ?? defaults.maxBytes
 *   effectiveMaxObjects = tenant.storageQuotaObjects ?? defaults.maxObjects
 *
 * FAIL-CLOSED contract: this function performs NO validation beyond the
 * numeric conversion — a present-but-broken override (NaN after conversion,
 * negative, a BigInt beyond Number.MAX_SAFE_INTEGER collapsing to a non-finite
 * value) flows through to {@link checkUploadQuota}, which denies on any
 * non-finite limit and on any state that exceeds a nonsensical (e.g. negative)
 * limit. A bad override therefore DENIES uploads for that tenant (surfacing
 * the config error) instead of silently widening to the default.
 *
 * `override` may be null/undefined (tenant row missing or columns unselected)
 * — that resolves to the defaults, exactly like per-column NULLs.
 */
export function resolveQuotaLimits(
  override: TenantQuotaOverride | null | undefined,
  defaults: QuotaLimits,
): QuotaLimits {
  const bytesOverride = override?.storageQuotaBytes ?? null;
  const objectsOverride = override?.storageQuotaObjects ?? null;
  return {
    maxBytes: bytesOverride === null ? defaults.maxBytes : Number(bytesOverride),
    maxObjects: objectsOverride === null ? defaults.maxObjects : objectsOverride,
  };
}
