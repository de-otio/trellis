/**
 * L2 — bounds on what a single inbox delivery may cost us to store.
 *
 * Inbox `Activity` rows are kept indefinitely and carry the sender's `to` / `cc`
 * / `bto` / `bcc` arrays verbatim, so an (otherwise legitimate, signed) peer
 * could park a multi-megabyte body and tens of thousands of addressees per
 * delivery. Both limits are RUNTIME config — never compiled-in thresholds — and
 * pure so the user inbox, the group inbox and the storage layer share one
 * definition.
 *
 *  - `ACTIVITYPUB_INBOX_MAX_BODY_BYTES`  (default 262144 = 256 KiB)
 *  - `ACTIVITYPUB_MAX_ADDRESSEES`        (default 100, per addressing field)
 *
 * Retention is NOT implemented here: see the L2 note in the remediation report
 * (a scheduled prune of `activities` where `inbox_actor_uri IS NOT NULL AND
 * received_at < now() - retention`, keyed by an indexed `received_at`).
 */

export const DEFAULT_INBOX_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_MAX_ADDRESSEES = 100;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Largest inbox request body accepted, in bytes. */
export function inboxMaxBodyBytes(): number {
  return positiveIntFromEnv(
    "ACTIVITYPUB_INBOX_MAX_BODY_BYTES",
    DEFAULT_INBOX_MAX_BODY_BYTES,
  );
}

/** Most entries accepted in any one of to / cc / bto / bcc. */
export function maxAddressees(): number {
  return positiveIntFromEnv(
    "ACTIVITYPUB_MAX_ADDRESSEES",
    DEFAULT_MAX_ADDRESSEES,
  );
}

/**
 * Declared `Content-Length`, when it is a well-formed number. A header that is
 * absent or malformed yields `null`; the authoritative check is on the bytes.
 */
export function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

const ADDRESSING_FIELDS = ["to", "cc", "bto", "bcc"] as const;

/**
 * Name of the first addressing field holding more than `maxAddressees()`
 * entries, or `null` when all are within bounds. A scalar counts as one entry.
 */
export function addresseeLimitViolation(activity: unknown): string | null {
  if (!activity || typeof activity !== "object") return null;
  const limit = maxAddressees();
  for (const field of ADDRESSING_FIELDS) {
    const value = (activity as Record<string, unknown>)[field];
    if (Array.isArray(value) && value.length > limit) return field;
  }
  return null;
}

/** JSON body for a 413. */
export const PAYLOAD_TOO_LARGE_BODY = JSON.stringify({
  error: "Payload too large",
});
