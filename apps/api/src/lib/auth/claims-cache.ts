/**
 * DynamoDB-backed claims cache for the pre-token-generation Lambda
 * (T2 — JIT provisioning).
 *
 * Storage layout (single-table on the existing `{stage}-trellis` table):
 *   pk = `claims:{cognitoSub}`
 *   sk = `meta`
 *   ttl = epoch seconds; DynamoDB-managed expiry plus a manual check on read
 *         (DDB TTL deletes lag by up to 48h, so we never trust the row's
 *         existence alone)
 *
 * Concurrency: writes use a `ConditionExpression` that the existing row's
 * `ttl` is missing or older than the incoming `ttl`. Two simultaneous
 * pre-token-gen invocations for the same user (rare, but possible during a
 * burst of token refreshes) cannot stale-overwrite a fresh entry.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

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

function pkFor(cognitoSub: string): string {
  return `claims:${cognitoSub}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class ClaimsCache {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string,
  ) {}

  /**
   * Returns cached claims if a fresh entry exists, else null. Stale rows
   * (ttl in the past) are treated as a miss; we let DDB's own TTL sweep
   * eventually delete them.
   */
  async get(cognitoSub: string): Promise<CachedClaims | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: pkFor(cognitoSub), sk: "meta" }),
      }),
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item) as Record<string, unknown>;
    const ttl = typeof item.ttl === "number" ? item.ttl : 0;
    if (!ttl || ttl <= nowSeconds()) return null;
    return {
      userId: (item.userId as string | undefined) ?? "",
      globalRole: (item.globalRole as string | undefined) ?? "",
      activeTenantId: (item.activeTenantId as string | undefined) ?? "",
      tenantSlug: (item.tenantSlug as string | undefined) ?? "",
      tenantRole: (item.tenantRole as string | undefined) ?? "",
      handle: (item.handle as string | undefined) ?? "",
    };
  }

  /**
   * Returns the user's last-known activeTenantId, regardless of TTL. Used by
   * the pre-token-generation Lambda on cache miss so a user's explicit
   * tenant-switch survives cache expiry rather than reverting to the
   * first-org-tenant heuristic.
   */
  async getActiveTenantPreference(cognitoSub: string): Promise<string | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: pkFor(cognitoSub), sk: "meta" }),
      }),
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item) as Record<string, unknown>;
    const activeTenantId = (item.activeTenantId as string | undefined) ?? "";
    return activeTenantId || null;
  }

  /**
   * Writes a cache entry. Uses a `ConditionExpression` so a stale write
   * (e.g., one that started before a newer entry was written) cannot
   * overwrite a fresher row. On collision we silently swallow the
   * conditional-check failure — the cache still holds an acceptable value.
   */
  async put(
    cognitoSub: string,
    claims: CachedClaims,
    ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS,
  ): Promise<void> {
    const expiresAt = nowSeconds() + ttlSeconds;
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall({
            pk: pkFor(cognitoSub),
            sk: "meta",
            userId: claims.userId,
            globalRole: claims.globalRole,
            activeTenantId: claims.activeTenantId,
            tenantSlug: claims.tenantSlug,
            tenantRole: claims.tenantRole,
            handle: claims.handle,
            ttl: expiresAt,
          }),
          ConditionExpression: "attribute_not_exists(#ttl) OR #ttl < :incomingTtl",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: marshall({ ":incomingTtl": expiresAt }),
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }

  /**
   * Forcibly remove a cache entry — used by admin paths (member-remove,
   * role change, OWNER transfer) to make sure the next token refresh hits
   * RDS rather than serving a stale role.
   */
  async invalidate(cognitoSub: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ pk: pkFor(cognitoSub), sk: "meta" }),
      }),
    );
  }
}

/**
 * Convenience constructor used by the Lambda handler. Reads the table name
 * from `DYNAMODB_TABLE` and the region from `AWS_REGION`. Tests construct
 * a `ClaimsCache` directly with a mock client.
 */
export function createClaimsCacheFromEnv(): ClaimsCache {
  const tableName = process.env.DYNAMODB_TABLE;
  if (!tableName) {
    throw new Error("DYNAMODB_TABLE env var is required for ClaimsCache");
  }
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  return new ClaimsCache(client, tableName);
}
