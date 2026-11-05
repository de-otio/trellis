/**
 * Session / token revocation primitives — the single definition shared by the
 * sealed-session path (`session-cookie.ts`) and the bearer-JWT path
 * (`auth-middleware.ts`).
 *
 * Why this exists (M9): the blocklist (`blocked:{sha256(token)}`) and the
 * per-user epoch (`sessionepoch:{userId}`) were only ever consulted by
 * `SessionManager.getSession`. `authMiddleware` — which ~32 route files use —
 * verified the JWT and stopped, so a suspension's epoch bump and any
 * logout-by-blocklist were invisible there. Both paths now read the same keys
 * through the same functions, so a writer and a reader cannot drift apart.
 *
 * Posture, identical on both paths:
 *  - no KV bound  → nothing to check (deployment shape: local dev, unit
 *    envs), unless `SESSION_BLOCKLIST_REQUIRED=true`, which denies;
 *  - KV read fails → DENY (fail closed). A best-effort blocklist that opens on
 *    an outage is one an attacker can bypass by causing an outage.
 */

export interface SessionBlocklistKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts: { expirationTtl: number },
  ): Promise<unknown>;
}

type EnvLike = { [key: string]: any } | undefined;

/** Key format for a revoked raw token. */
export function blocklistKeyForToken(tokenHash: string): string {
  return `blocked:${tokenHash}`;
}

/** Key format for a user's session epoch ("revoke all sessions"). */
export function sessionEpochKey(userId: string): string {
  return `sessionepoch:${userId}`;
}

/** TTL for blocklist + epoch entries: the maximum cookie lifetime (90 days). */
export const BLOCKLIST_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * The blocklist binding, resolved separately for reads and writes: the two
 * capabilities are independently optional in practice (a deployment or test
 * double may bind a put-only store).
 */
export function getBlocklistReader(
  env: EnvLike,
): Pick<SessionBlocklistKv, "get"> | undefined {
  const kv = env?.SESSION_BLOCKLIST_KV as SessionBlocklistKv | undefined;
  return kv && typeof kv.get === "function" ? kv : undefined;
}

export function getBlocklistWriter(
  env: EnvLike,
): Pick<SessionBlocklistKv, "put"> | undefined {
  const kv = env?.SESSION_BLOCKLIST_KV as SessionBlocklistKv | undefined;
  return kv && typeof kv.put === "function" ? kv : undefined;
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** No reader bound: allow, unless the deployment demands a blocklist. */
function unboundVerdict(env: EnvLike): boolean {
  return env?.SESSION_BLOCKLIST_REQUIRED === "true";
}

/** Is this raw bearer token on the revocation blocklist? `true` ⇒ deny. */
export async function isRawTokenBlocked(
  token: string,
  env: EnvLike,
): Promise<boolean> {
  const kv = getBlocklistReader(env);
  if (!kv) return unboundVerdict(env);
  try {
    const blocked = await kv.get(blocklistKeyForToken(await sha256Hex(token)));
    return blocked !== null && blocked !== undefined;
  } catch {
    return true; // fail closed
  }
}

/**
 * Was a bearer JWT issued at or before the user's last "revoke all sessions"?
 * `true` ⇒ deny.
 *
 * `iat` is in SECONDS (RFC 7519) while the stored epoch is in milliseconds, so
 * a token minted in the same second as the revocation cannot be told apart
 * from one minted just before it. This rejects that ambiguous token (`<=`):
 * the cost is that a re-login inside the very second of the revocation is
 * refused once and succeeds on retry; the alternative would accept a token
 * that may predate the revocation. A token with NO `iat` is treated as
 * issued at 0, i.e. revoked by any stored epoch.
 */
export async function isBearerEpochStale(
  userId: string,
  iatSeconds: number | undefined,
  env: EnvLike,
): Promise<boolean> {
  const kv = getBlocklistReader(env);
  if (!kv) return unboundVerdict(env);
  try {
    const raw = await kv.get(sessionEpochKey(userId));
    if (raw === null || raw === undefined || raw === "") return false;
    const storedEpoch = Number(raw);
    if (!Number.isFinite(storedEpoch)) return false; // corrupt ≠ lock everyone out
    return (iatSeconds ?? 0) * 1000 <= storedEpoch;
  } catch {
    return true; // fail closed
  }
}
