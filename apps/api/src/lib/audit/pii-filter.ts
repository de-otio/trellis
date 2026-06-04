/**
 * PII Filter for Audit Payloads
 *
 * Allowlist-based field filter. Any key not on the allowlist is replaced
 * with the literal string "<redacted>" and a drop counter is incremented.
 * Claim *names* are fine to store; claim *values* must never appear.
 */

/**
 * Per-key allowlist for audit metadata. Anything outside this set is
 * replaced with "<redacted>". Migrated here from the now-deleted
 * `event-types.ts` (phase 1.C.2) so the allowlist lives next to the
 * filter that consumes it.
 *
 * Claim *names* are fine to store; claim *values* must never appear.
 */
export const PII_ALLOWED_FIELDS = new Set<string>([
  "tenantId",
  "actorUserId",
  "targetUserId",
  "targetType",
  "oldRole",
  "newRole",
  "domain",
  "idpStatus",
  "idpKind",
  "issuer",
  "idpGroup",
  "role",
  "source",
  "reason",
  "verificationMethod",
  "changedAttributes",
  "sourceIp",
  "agentSessionId",
  "slug",
  "displayName",
  "type",
  "agentLabel",
  "userAgent",
  // G4 MEDIUM-6/N2: `deviceCodeHash` was previously written into
  // AUTH_AGENT_SESSION_APPROVED audit payloads and could act as a
  // confirmation oracle if a raw device_code ever leaked elsewhere.
  // Kept OFF the allow-list so a future regression that re-adds the
  // field would fail the audit-emit allow-list check.
  "refreshJti",
  "cognitoUserId",
  // Region codes are NOT PII (US/EU/CN); they are data-residency
  // compliance signals carried by the data-lifecycle audit events.
  // Added in phase 1.C.2 so the data-router region context survives
  // the allowlist instead of being redacted away. See migration note.
  "region",
  "dataRegion",
  "requestedRegion",
  "actualDataRegion",
  // Feature-toggle audit fields (feature_toggle.changed events).
  // key is a system identifier (no PII); oldEnabled/newEnabled are booleans;
  // changedBy carries the admin's USER ID (never email — see convention doc).
  "key",
  "oldEnabled",
  "newEnabled",
  "changedBy",
]);

export interface FilterResult {
  filtered: Record<string, unknown>;
  droppedCount: number;
}

/**
 * Redact IPv4 to /24 and IPv6 to /64 for GDPR-compliant storage.
 * "1.2.3.4" → "1.2.3.0/24", "2001:db8::1" → "2001:db8::/64"
 */
export function anonymizeIp(ip: string): string {
  if (!ip || ip === "unknown") return ip;

  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }

  if (ip.includes(":")) {
    const parts = ip.split(":");
    const prefix = parts.slice(0, 4).join(":");
    return `${prefix}::/64`;
  }

  return ip;
}

/**
 * Filter a raw payload object against the PII allowlist.
 * Returns the cleaned object and the number of dropped fields.
 */
export function filterPayload(
  payload: Record<string, unknown>,
  allowedFields: Set<string> = PII_ALLOWED_FIELDS,
): FilterResult {
  const filtered: Record<string, unknown> = {};
  let droppedCount = 0;

  for (const [key, value] of Object.entries(payload)) {
    if (allowedFields.has(key)) {
      filtered[key] = value;
    } else {
      filtered[key] = "<redacted>";
      droppedCount++;
    }
  }

  return { filtered, droppedCount };
}
