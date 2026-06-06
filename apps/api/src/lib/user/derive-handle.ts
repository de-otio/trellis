/**
 * User handle derivation from email local-part (T2 — JIT provisioning).
 *
 * Strategy:
 *  1. Take the local-part (everything before `@`).
 *  2. Lowercase, strip any character that isn't `[a-z0-9_-]`.
 *  3. Truncate to {@link HANDLE_MAX_BASE_LENGTH} to leave room for collision
 *     suffixes ("alice2" / "alice13") within the Cognito `custom:handle`
 *     attribute ceiling of 32 chars.
 *  4. If empty after stripping (e.g., handle was all punctuation, or the
 *     email was malformed), fall back to {@link FALLBACK_HANDLE_PREFIX} +
 *     a short random suffix.
 *  5. On collision, append a numeric suffix and try again, up to
 *     {@link MAX_COLLISION_ATTEMPTS}.
 *
 * The collision-check callback is injected so this module is pure and easy
 * to test without Prisma. The lambda wires it to a `db.user.findFirst`.
 */

const HANDLE_MAX_BASE_LENGTH = 24;
const HANDLE_TOTAL_MAX = 32;
const MAX_COLLISION_ATTEMPTS = 100;
const FALLBACK_HANDLE_PREFIX = "user";

export type HandleExistsCheck = (handle: string) => Promise<boolean>;

export function normalizeHandleBase(emailOrLocalPart: string | null | undefined): string {
  if (!emailOrLocalPart) return "";
  const localPart = emailOrLocalPart.includes("@")
    ? emailOrLocalPart.split("@")[0]
    : emailOrLocalPart;
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return cleaned.slice(0, HANDLE_MAX_BASE_LENGTH);
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 9000 + 1000).toString();
}

/**
 * Derives a unique handle for a new user from their email address.
 *
 * @param email - the user's email address
 * @param exists - async callback that returns true if `handle` is already in
 *                 use by some other user. Inject the Prisma lookup here.
 */
export async function deriveHandle(
  email: string | null | undefined,
  exists: HandleExistsCheck,
): Promise<string> {
  let base = normalizeHandleBase(email);
  if (!base) {
    base = `${FALLBACK_HANDLE_PREFIX}${randomSuffix()}`.slice(0, HANDLE_MAX_BASE_LENGTH);
  }

  if (!(await exists(base))) return base;

  for (let suffix = 2; suffix <= MAX_COLLISION_ATTEMPTS; suffix++) {
    const suffixStr = String(suffix);
    const allowedBaseLen = HANDLE_TOTAL_MAX - suffixStr.length;
    const truncatedBase = base.slice(0, allowedBaseLen);
    const candidate = `${truncatedBase}${suffixStr}`;
    if (!(await exists(candidate))) return candidate;
  }

  return `${base.slice(0, HANDLE_TOTAL_MAX - 8)}${randomSuffix()}${randomSuffix().slice(0, 4)}`.slice(
    0,
    HANDLE_TOTAL_MAX,
  );
}

/** Minimal Prisma surface needed to collision-check a handle. */
type HandleCollisionDb = {
  user: {
    findFirst: (args: {
      where: Record<string, unknown>;
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

/**
 * Convenience wrapper that wires {@link deriveHandle}'s collision check to a
 * Prisma client, returning a globally-unique handle. Use this at every
 * User-creation site so the non-null + unique `handle` invariant (S-CP2) holds
 * regardless of which path provisions the user. Pass `excludeUserId` when
 * back-filling a handle onto an existing row.
 */
export async function deriveUniqueHandle(
  db: HandleCollisionDb,
  email: string | null | undefined,
  excludeUserId?: string,
): Promise<string> {
  return deriveHandle(email, async (h) => {
    const where = excludeUserId
      ? { handle: h, NOT: { id: excludeUserId } }
      : { handle: h };
    const found = await db.user.findFirst({ where, select: { id: true } });
    return !!found;
  });
}
