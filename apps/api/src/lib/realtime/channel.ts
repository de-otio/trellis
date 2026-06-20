// CONTRACT: stable — coordinate changes. See types.ts banner.
//
// Channel naming + the subscription authorization boundary. Per §2.1/§2.2 of
// the frozen contract, the canonical path is produced ONLY by `channelName()`
// and parsed ONLY by `parseChannel()`; `authorizeSubscription()` is THE
// security boundary — identity comes from a VerifiedIdentity (Cognito claims),
// never an ambient Session and never a client-asserted path.

import type {
  Channel,
  ChannelKind,
  ScopeType,
  VerifiedIdentity,
} from "./types.js";

/** Canonical path grammar: /{kind}/{tenantId}/{scopeType}/{scopeId}. */
const VALID_KINDS: ReadonlySet<ChannelKind> = new Set<ChannelKind>([
  "wakeup",
  "setting_sync",
  "safety",
  "message",
  "thread",
]);

const VALID_SCOPE_TYPES: ReadonlySet<ScopeType> = new Set<ScopeType>([
  "user",
  "conversation",
  "thread",
]);

/** A path segment may not be empty and may not contain a path separator. */
function isValidSegment(s: string): boolean {
  return s.length > 0 && !s.includes("/");
}

/**
 * Produce the canonical channel path. This is the ONLY way a channel string is
 * minted server-side; the Skybber `@skybber/realtime-channels` parser must
 * round-trip this output.
 */
export function channelName(c: Channel): string {
  if (!VALID_KINDS.has(c.kind)) {
    throw new Error(`channelName: invalid kind "${String(c.kind)}"`);
  }
  if (!VALID_SCOPE_TYPES.has(c.scopeType)) {
    throw new Error(`channelName: invalid scopeType "${String(c.scopeType)}"`);
  }
  if (!isValidSegment(c.tenantId) || !isValidSegment(c.scopeId)) {
    throw new Error("channelName: tenantId/scopeId must be non-empty, no slash");
  }
  return `/${c.kind}/${c.tenantId}/${c.scopeType}/${c.scopeId}`;
}

/**
 * Parse a canonical channel path. Returns `null` on ANY malformed input — a
 * leading-slash-less path, wrong arity, unknown kind/scopeType, or an empty
 * segment.
 */
export function parseChannel(path: string): Channel | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  // Drop the leading "" produced by the leading slash; require exactly 4 parts.
  const parts = path.split("/");
  if (parts.length !== 5 || parts[0] !== "") return null;
  const [, kind, tenantId, scopeType, scopeId] = parts;
  if (!VALID_KINDS.has(kind as ChannelKind)) return null;
  if (!VALID_SCOPE_TYPES.has(scopeType as ScopeType)) return null;
  if (!isValidSegment(tenantId) || !isValidSegment(scopeId)) return null;
  return {
    kind: kind as ChannelKind,
    tenantId,
    scopeType: scopeType as ScopeType,
    scopeId,
  };
}

/**
 * Build a user-scoped channel (v1: the only scope). `kind` is constrained to
 * the v1 user-scoped kinds; `message`/`thread` are deferred and excluded.
 */
export function channelFor(
  kind: Exclude<ChannelKind, "message" | "thread">,
  scope: { tenantId: string; userId: string },
): Channel {
  return {
    kind,
    tenantId: scope.tenantId,
    scopeType: "user",
    scopeId: scope.userId,
  };
}

/**
 * THE security boundary. The channel is a client *assertion* this checks
 * against a server-verified identity.
 *
 * ALLOW iff `c.tenantId === id.tenantId` AND
 *   scopeType "user"             -> `c.scopeId === id.userId`
 *   scopeType conversation/thread -> membership(id.userId, c.scopeId) [v1: false]
 *
 * End-user PUBLISH is ALWAYS denied elsewhere (publish is server-only via IAM);
 * this function governs SUBSCRIBE only.
 */
export function authorizeSubscription(
  id: VerifiedIdentity,
  c: Channel,
): boolean {
  if (c.tenantId !== id.tenantId) return false;
  if (c.scopeType === "user") {
    return c.scopeId === id.userId;
  }
  // conversation / thread membership — DEFERRED in v1, deny.
  return false;
}
