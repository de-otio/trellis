/**
 * Claims cache for the pre-token-generation Lambda (T2 — JIT provisioning),
 * on the `@de-otio/saas-foundation` `KvStore` port (WS-1 §3.6).
 *
 * Storage (unchanged on AWS — DynamoKvStore byte-compat layout `claims`):
 *   pk = `claims:{cognitoSub}`, sk = `meta`, ttl = epoch seconds. The port's
 *   `get` applies the same on-read expiry filter DynamoDB TTL lags behind, so a
 *   stale row never counts as a hit.
 *
 * Concurrency (F2 — TTL-monotonic freshness, NOT version-CAS): writes go through
 * `putIfFresher`, a single atomic conditional write that applies only when the
 * incoming expiry is strictly newer than the stored one. This reproduces the
 * original `attribute_not_exists(#ttl) OR #ttl < :incomingTtl` guard exactly —
 * a stale (older-expiry) write can never overwrite a fresher entry, even if it
 * carries higher-privilege claims written after a tenant-removal invalidation.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout, type KvStore } from "@de-otio/saas-foundation/kv";

export interface CachedClaims {
  /** Trellis `User.id` (cuid). May be empty string for drift sentinel. */
  userId: string;
  /** Global `UserRole` enum value. May be empty string for drift sentinel. */
  globalRole: string;
  /** `Tenant.id` of the user's currently-active tenant. */
  activeTenantId: string;
  /** `Tenant.slug` of the active tenant. */
  tenantSlug: string;
  /** `TenantRole` enum value within the active tenant. May be empty. */
  tenantRole: string;
  /** ActivityPub-style handle. May be empty. */
  handle: string;
}

export const DEFAULT_CACHE_TTL_SECONDS = 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fill missing string fields with "" (preserves the pre-port shape). */
function normalizeClaims(value: Partial<CachedClaims> | undefined): CachedClaims {
  return {
    userId: value?.userId ?? "",
    globalRole: value?.globalRole ?? "",
    activeTenantId: value?.activeTenantId ?? "",
    tenantSlug: value?.tenantSlug ?? "",
    tenantRole: value?.tenantRole ?? "",
    handle: value?.handle ?? "",
  };
}

export class ClaimsCache {
  constructor(private readonly store: KvStore) {}

  /**
   * Returns cached claims if a fresh entry exists, else null. Stale rows
   * (ttl in the past) are filtered by the port's on-read expiry check; a row
   * carrying no expiry is treated as a miss (matches the pre-port `!ttl`).
   */
  async get(cognitoSub: string): Promise<CachedClaims | null> {
    const rec = await this.store.get<Partial<CachedClaims>>(cognitoSub);
    if (rec === null || rec.expiresAt === undefined) return null;
    return normalizeClaims(rec.value);
  }

  /**
   * Returns the user's last-known activeTenantId, regardless of TTL. Used by
   * the pre-token-generation Lambda on cache miss so a user's explicit
   * tenant-switch survives cache expiry rather than reverting to the
   * first-org-tenant heuristic. Reads with `includeExpired` so an expired-
   * but-uncleaned row still yields the preference (as the raw DDB read did).
   */
  async getActiveTenantPreference(cognitoSub: string): Promise<string | null> {
    const rec = await this.store.get<Partial<CachedClaims>>(cognitoSub, { includeExpired: true });
    const activeTenantId = rec?.value.activeTenantId ?? "";
    return activeTenantId || null;
  }

  /**
   * Writes a cache entry via `putIfFresher` so a stale write (one that started
   * before a newer entry was written) cannot overwrite a fresher row. A
   * rejected (not-fresher) write is swallowed — the cache still holds an
   * acceptable value. Transient backend errors propagate (matches the original
   * rethrow of non-conditional failures).
   */
  async put(
    cognitoSub: string,
    claims: CachedClaims,
    ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
  ): Promise<void> {
    const expiresAt = nowSeconds() + ttlSeconds;
    await this.store.putIfFresher(cognitoSub, claims, { expiresAt });
  }

  /**
   * Forcibly remove a cache entry — used by admin paths (member-remove,
   * role change, OWNER transfer) to make sure the next token refresh hits
   * RDS rather than serving a stale role.
   */
  async invalidate(cognitoSub: string): Promise<void> {
    await this.store.delete(cognitoSub);
  }
}

/**
 * Convenience constructor used by the Lambda handler. Builds a DynamoKvStore
 * over the byte-compat `claims` layout (pk `claims:{sub}`, sk `meta`, ttl attr
 * `ttl`) from `DYNAMODB_TABLE` + `AWS_REGION`. Tests construct a `ClaimsCache`
 * directly with a `MemoryKvStore`. When KV_PROVIDER wiring lands (WS-1 T5) this
 * factory is replaced by the injected typed store; until then it preserves the
 * exact AWS storage behavior.
 */
export function createClaimsCacheFromEnv(): ClaimsCache {
  const tableName = process.env.DYNAMODB_TABLE;
  if (!tableName) {
    throw new Error("DYNAMODB_TABLE env var is required for ClaimsCache");
  }
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  const layout: DynamoKvLayout = {
    tableName,
    pkPrefix: "claims",
    pkSeparator: ":",
    skName: "sk",
    skValue: "meta",
    ttlAttr: "ttl",
    versionAttr: "_v",
  };
  return new ClaimsCache(new DynamoKvStore(client, layout));
}
