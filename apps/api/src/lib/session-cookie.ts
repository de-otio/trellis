/**
 * Session Management
 *
 * Handles encrypted cookie-based session storage for authentication.
 *
 * Crypto is delegated to `@de-otio/saas-foundation/session`'s
 * `SessionCookie` (AES-256-GCM, 96-bit random IV, PBKDF2-SHA256 with
 * the OWASP-2023 600k-iteration minimum). The envelope format is
 * base64([IV || ciphertext+tag]) — identical in shape to the previous
 * hand-rolled implementation, only the derived key is stronger.
 *
 * This module is a thin trellis-flavoured wrapper: it preserves the
 * `SessionManager` public surface (so the ~60 call sites only change
 * their import path), owns the trellis `Session` shape + custom-claim
 * validation (foundation is payload-agnostic), and keeps the AUTH-5
 * token-revocation blocklist (which has no foundation equivalent).
 */

import type { AgeTier } from "@prisma/client";
import {
  MIN_SALT_LENGTH,
  MIN_SECRET_LENGTH,
  SessionCookie,
  parseCookieHeader,
  serializeSetCookie,
} from "@de-otio/saas-foundation/session";
import { getLogger } from "./logger.js";
import { CUID_RE } from "./auth/cuid.js";
import type { ScopeSet } from "./auth/scopes.js";
import type { Env } from "../env.js";

export type UserRole =
  | "END_USER"
  | "B2B_PARTNER"
  | "PARTNER_ADMIN"
  | "INTERNAL"
  | "CONTENT_CREATOR"
  | "SUPER_ADMIN";

export interface Session {
  userId: string; // Supabase Auth user_id (UUID)
  email: string;
  role?: UserRole; // Optional role for SSO users
  expiresAt: number;
  csrfToken?: string; // CSRF token for state-changing requests (Double Submit Cookie pattern)
  csrfTokenCreatedAt?: number; // Timestamp when CSRF token was generated (for rotation)
  csrfTokenNeedsRotation?: boolean; // Flag set when CSRF token is older than 24 hours
  lastActivityAt?: number; // Last activity timestamp for inactivity timeout
  sessionType?: "user" | "sso" | "dashboard"; // Session type for timeout calculation
  dataRegion: string; // User's data region (EU, US, CN) - REQUIRED for data residency compliance

  // PREPARATORY: Border Safety Mode - Profile context support
  // Profile context for future dual-account support (primary vs decoy profiles)
  // Currently always 'primary' - dormant until Border Safety Mode is implemented
  // FUTURE USE: When Border Safety Mode is enabled, users can have 'primary' and 'decoy' contexts
  // with different data visibility and access controls
  profileContext: "primary" | "decoy"; // Required

  // Optional context ID for future multi-context support
  // FUTURE USE: Unique identifier for this specific context session
  // Allows tracking which context a user is currently using
  contextId?: string;

  // MFA verification flag (AUTH-1)
  // Set to true after successful TOTP or backup code verification
  mfaVerified?: boolean;

  // T9b-d: timestamp of the most recent MFA verification, used for
  // step-up checks on sensitive flows (e.g. agent authorization).
  mfaVerifiedAt?: number;

  // Age tier for child safety feature gating (Safer Social Design)
  ageTier?: AgeTier;

  // SEC L2 — per-user session epoch, sealed into the payload.
  //
  // Stamped at seal time (`setSession`) with `Date.now()`. `revokeAllSessions`
  // writes a newer epoch to the blocklist KV under `sessionepoch:{userId}`;
  // `getSession` rejects any sealed session whose `sessionEpoch` is older than
  // the stored one. That is the "revoke all sessions" primitive — without it,
  // the only way to kill every session was rotating SESSION_SECRET, which kills
  // *everyone's*.
  //
  // Doubles as the issue-time fallback for the inactivity check when a payload
  // carries no `lastActivityAt` (Phase 8).
  sessionEpoch?: number;

  // O-1 / 05a: the caller's verified active tenant.
  //
  // Populated ONLY from a verified Cognito JWT (getSession Strategy 1a), where
  // `custom:activeTenantId` was signed by Cognito and written by the
  // pre-token-generation Lambda after an ACTIVE-membership check. It is
  // deliberately NEVER read from the decrypted cookie/localStorage payload
  // (`narrowSession`/`narrowSessionForAuthHeader` strip it) and NEVER written
  // into sealed material (`encryptSession` strips it) — so a stale or
  // client-tampered tenant can never ride a 90-day cookie. The extension route
  // wrapper is the sole consumer: it mints this into a branded `TenantId`.
  //
  // Freshness is a security property here (scope, not just identity): trusting
  // it only from a ≤1h token is what keeps a removed-from-tenant user from
  // retaining scoped access for a cookie lifetime.
  activeTenantId?: string;

  // ── Principal (plan 034 lane A) ────────────────────────────────────────
  //
  // Both are stamped at *read* time by `getSession` and are in
  // SEAL_FORBIDDEN_FIELDS — they are never written into sealed material and
  // never trusted from it. The reasoning is `activeTenantId`'s, verbatim:
  // freshness is a security property for scope-shaped data. A sealed scope
  // set would survive its own revocation for up to the 90-day cookie
  // lifetime, which is the exact failure the seal strip exists to prevent.

  /**
   * The third-party client acting on the user's behalf. Absent means
   * first-party — a cookie or localStorage session is the human's own, with
   * no client in between, so nothing populates this today.
   */
  clientId?: string;

  /**
   * What this session was granted. Every path in `getSession` stamps `"*"`:
   * a session that survived decryption is by construction first-party and
   * unscoped. It is deliberately not "the set of all core scopes" — a
   * first-party session must keep passing when a new scope is defined.
   */
  scopes?: ScopeSet;
}

/** Minimum session-secret length. Mirrors foundation's MIN_SECRET_LENGTH. */
const SESSION_SECRET_MIN_LENGTH = MIN_SECRET_LENGTH;

/**
 * Session fields that must NEVER be persisted in sealed material (cookie /
 * localStorage token). Trusted only from a freshly-verified JWT per request.
 * See the `Session.activeTenantId` doc and `encryptSession`'s `[SR:H3]` note.
 *
 * Plan 034 lane A adds the principal fields on the same argument: a grant is
 * scope-shaped data whose freshness is a security property. Sealing `scopes`
 * into a 90-day cookie would let a revoked grant keep working for the cookie's
 * lifetime, and sealing `clientId` would let a decrypted payload *claim* to be
 * a third-party client. Both are stamped per request instead, from the
 * freshly-authenticated credential.
 */
const SEAL_FORBIDDEN_FIELDS = ["activeTenantId", "clientId", "scopes"] as const;

/**
 * Remove {@link SEAL_FORBIDDEN_FIELDS} from a to-be-sealed JSON payload string.
 *
 * Operates on the JSON string `encryptSession` receives. If the payload does not
 * parse as a JSON object (no current caller — every seal path stringifies a
 * `Session`), it is returned unchanged: the strip is a session-scope invariant,
 * not a general transform, and must not corrupt a non-session payload.
 */
function prepareSealPayload(data: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return data;
  }
  const obj = parsed as Record<string, unknown>;
  let mutated = false;
  for (const field of SEAL_FORBIDDEN_FIELDS) {
    if (field in obj) {
      delete obj[field];
      mutated = true;
    }
  }

  // SEC L2 / Phase 8: stamp the seal-time epoch here — the single seal
  // chokepoint — so EVERY sealed session carries one, no matter which call
  // site produced it. Two properties depend on it:
  //   1. `revokeAllSessions` can invalidate everything sealed before a given
  //      instant (`isEpochStale`).
  //   2. The inactivity check has an issue-time fallback when the payload has
  //      no `lastActivityAt` (`isInactive`), instead of silently skipping.
  // Only stamped for session-shaped payloads (`userId` present) so this stays a
  // session invariant, not a general JSON transform.
  if (typeof obj.userId === "string" && typeof obj.sessionEpoch !== "number") {
    obj.sessionEpoch = Date.now();
    mutated = true;
  }

  return mutated ? JSON.stringify(obj) : data;
}

/**
 * Build the cache key for a derived `SessionCookie`. Keyed by the
 * exact secret/fallback/salt triple so two distinct secrets never
 * collide on a cached key.
 */
function cacheKey(
  primary: string,
  fallback: string | undefined,
  salt: string,
): string {
  return JSON.stringify([primary, fallback ?? null, salt]);
}

/**
 * MODULE-scope cache of foundation `SessionCookie` instances, keyed by
 * the exact secret/fallback/salt triple.
 *
 * Why module scope: `new SessionManager()` happens per request (~160
 * call sites), so an instance-level cache never got a warm hit — every
 * cookie-authenticated request re-paid the full 600k-iteration PBKDF2
 * (~100–250 ms CPU), and twice on the primary+fallback rotation path.
 * `SessionCookie` caches its derived AES keys lazily on the instance,
 * so sharing the instance across requests means the KDF runs once per
 * distinct secret triple per process, not once per request.
 *
 * Rotation correctness: the cache key includes the primary secret, the
 * fallback secret, AND the salt. When the secret rotates (new primary;
 * old primary demoted to fallback), the triple changes, so a fresh
 * `SessionCookie` is constructed and both new keys are derived — a
 * stale pre-rotation instance can never be served for the
 * post-rotation config, and the pre-rotation entry is never looked up
 * again (evicted by the size cap below).
 *
 * Bounded (infinite-loop-prevention rule): a real process only ever
 * sees a handful of triples (one per encrypt/decrypt secret config),
 * but tests pass many distinct secrets — the cap keeps the map from
 * growing without bound. Eviction is insertion-order (Map iteration
 * order = FIFO) and always safe: an evicted triple simply re-derives
 * on next use.
 *
 * No crypto parameter changes here: iteration count (600k), key size,
 * and cipher are owned by foundation's `SessionCookie` and untouched.
 */
const MAX_CACHED_COOKIES = 32;
const moduleCookieCache = new Map<string, SessionCookie>();

/**
 * Test-only: clear the module-scope `SessionCookie` cache so KDF-count
 * assertions and benchmarks start cold. Not part of the public API.
 * @internal
 */
export function __clearSessionCookieCacheForTesting(): void {
  moduleCookieCache.clear();
}

/**
 * Get (or lazily construct + cache) the foundation `SessionCookie` for
 * a given secret/fallback/salt triple, from the module-scope cache.
 *
 * Construction and cache insertion are fully synchronous, so two
 * concurrent requests for the same triple cannot race into two
 * derivations: whichever call runs first inserts the instance, and the
 * (lazy, promise-cached) key derivation inside `SessionCookie` is then
 * shared by all callers.
 *
 * `salt` is REQUIRED (trellis fails closed without it, mirroring
 * foundation's MIN_SALT_LENGTH constraint).
 */
function getModuleCookie(
  primarySecret: string,
  salt: string | undefined,
  fallbackSecret?: string,
): SessionCookie {
  // SESSION_SALT is required — fail-closed if not provided.
  if (!salt) {
    throw new Error(
      "SESSION_SALT environment variable is required. " +
        "Set a unique, random salt value in your environment configuration.",
    );
  }
  const key = cacheKey(primarySecret, fallbackSecret, salt);
  let cookie = moduleCookieCache.get(key);
  if (!cookie) {
    cookie = new SessionCookie({
      primarySecret,
      ...(fallbackSecret !== undefined ? { fallbackSecret } : {}),
      salt,
    });
    if (moduleCookieCache.size >= MAX_CACHED_COOKIES) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = moduleCookieCache.keys().next().value;
      if (oldest !== undefined) moduleCookieCache.delete(oldest);
    }
    moduleCookieCache.set(key, cookie);
  }
  return cookie;
}

/**
 * SEC L2 — the blocklist KV surface `SessionManager` needs.
 *
 * `revokeSession` has always written `blocked:{sha256(rawToken)}` here; the
 * reader added in this change uses the SAME key format (see
 * `blocklistKeyForToken`). `get` is added to the shape so the read is typed.
 */
interface SessionBlocklistKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts: { expirationTtl: number },
  ): Promise<unknown>;
}

/** Key format for a revoked raw token. MUST match `revokeSession`'s writer. */
function blocklistKeyForToken(tokenHash: string): string {
  return `blocked:${tokenHash}`;
}

/** Key format for a user's session epoch ("revoke all sessions"). */
function sessionEpochKey(userId: string): string {
  return `sessionepoch:${userId}`;
}

/** TTL for blocklist + epoch entries: the maximum cookie lifetime (90 days). */
const BLOCKLIST_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * The blocklist binding, resolved separately for reads and writes.
 *
 * Reader and writer are resolved independently because the two capabilities are
 * independently optional in practice: a deployment (or a test double) may bind
 * a put-only store. A missing READER must not be mistaken for "not blocked" any
 * more than it must be mistaken for an outage — see `isTokenRevoked`.
 */
function getBlocklistReader(
  env: { [key: string]: any } | undefined,
): Pick<SessionBlocklistKv, "get"> | undefined {
  const kv = env?.SESSION_BLOCKLIST_KV as SessionBlocklistKv | undefined;
  return kv && typeof kv.get === "function" ? kv : undefined;
}

function getBlocklistWriter(
  env: { [key: string]: any } | undefined,
): Pick<SessionBlocklistKv, "put"> | undefined {
  const kv = env?.SESSION_BLOCKLIST_KV as SessionBlocklistKv | undefined;
  return kv && typeof kv.put === "function" ? kv : undefined;
}

/**
 * Session Manager class for handling encrypted sessions.
 */
export class SessionManager {
  private static readonly COOKIE_NAME = "trellis_session";
  public hadLegacySessionCookie = false;
  public hadInvalidSessionCookie = false;

  /**
   * Get the foundation `SessionCookie` for a secret/fallback/salt
   * triple. Delegates to the module-scope cache (see
   * `moduleCookieCache` above) so the derived AES key is reused across
   * requests even though `SessionManager` itself is constructed
   * per-request.
   */
  private getCookie(
    primarySecret: string,
    salt: string | undefined,
    fallbackSecret?: string,
  ): SessionCookie {
    return getModuleCookie(primarySecret, salt, fallbackSecret);
  }

  /**
   * Get session configuration from environment
   */
  private async getSessionConfig(env: { [key: string]: any }) {
    // Import dynamically to avoid circular dependencies
    const { getSessionConfig } = await import("./session-config.js");
    return getSessionConfig(env);
  }

  /**
   * Encrypt session data using foundation's AES-256-GCM SessionCookie.
   *
   * `salt` is required (mirrors foundation MIN_SALT_LENGTH); omitting
   * it fails closed with a SESSION_SALT error.
   *
   * O-1 / 05a `[SR:H3]`: this is the single seal chokepoint (every seal path —
   * `setSession`, and the CSRF/MFA re-seal sites — routes its payload through
   * here), so it is also the single place that guarantees `activeTenantId` is
   * never persisted in sealed material. A JWT-derived `Session` carries a
   * trusted `activeTenantId`; if that object is fed back into a 90-day cookie /
   * localStorage token (as the CSRF-refresh and MFA-verify handlers do), the
   * tenant would outlive the ≤1h token it was verified from — letting a user
   * removed from a tenant keep minting a scoped handle for it. Stripping here
   * enforces "verified-per-request only" for every caller, present and future,
   * instead of relying on each seal site to remember.
   */
  async encryptSession(
    data: string,
    secret: string,
    salt?: string,
  ): Promise<string> {
    return this.getCookie(secret, salt).seal(prepareSealPayload(data));
  }

  /**
   * Decrypt session data. Returns null on any decryption failure
   * (bad MAC, wrong key, malformed input).
   */
  async decryptSession(
    encryptedData: string,
    secret: string,
    salt?: string,
  ): Promise<string | null> {
    try {
      return await this.getCookie(secret, salt).unseal(encryptedData);
    } catch {
      // getCookie throws only on missing salt; treat as decryption failure.
      return null;
    }
  }

  /**
   * Validate and narrow a decrypted/parsed payload into a trellis
   * `Session`. Returns null (and sets `hadInvalidSessionCookie`) when
   * the payload is not a valid Supabase session, or is a legacy
   * BlueSky/AT-Protocol session.
   */
  private narrowSession(parsed: unknown): Session | null {
    if (typeof parsed !== "object" || parsed === null) {
      this.hadInvalidSessionCookie = true;
      return null;
    }
    const session = parsed as Record<string, unknown>;

    // Detect BlueSky/AT Protocol session (legacy, from before Supabase migration)
    if (
      session.did ||
      session.handle ||
      session.accessJwt ||
      session.refreshJwt
    ) {
      this.hadInvalidSessionCookie = true;
      return null;
    }

    // Validate Supabase session structure
    if (
      typeof session.userId === "string" &&
      session.userId &&
      typeof session.email === "string" &&
      session.email
    ) {
      // O-1 / 05a `[SR:H3]`: the cast below passes the whole decrypted JSON
      // through at runtime, so any `activeTenantId` present in the sealed
      // payload would become a trusted tenant. It must only ever come from a
      // freshly-verified JWT (Strategy 1a). Strip it here so the sealed-cookie
      // path can never supply one — defense-in-depth behind `encryptSession`'s
      // seal-time strip.
      for (const field of SEAL_FORBIDDEN_FIELDS) delete session[field];
      // Plan 034 lane A: stamp the principal AFTER the strip, so a sealed
      // payload can neither supply a `clientId` nor widen/narrow `scopes`.
      // A cookie session is first-party and unscoped, always.
      return { ...(session as unknown as Session), scopes: "*" };
    }

    this.hadInvalidSessionCookie = true;
    return null;
  }

  /**
   * Get session from request
   * Checks Authorization header first (for localStorage token), then falls back to cookie
   * Checks expiration and inactivity timeout
   *
   * Supports dual-secret rotation: tries primary secret first, then fallback secret
   * This enables zero-downtime secret rotation without invalidating existing sessions
   */
  async getSession(
    request: Request,
    secret: string,
    env?: { [key: string]: any },
  ): Promise<Session | null> {
    const logger = getLogger();
    const salt = env?.SESSION_SALT as string | undefined;
    const fallbackSecret = env?.SESSION_SECRET_FALLBACK as string | undefined;

    // Validate secret is provided and is a string
    logger.debug("[SessionManager] getSession entry");
    if (!secret || typeof secret !== "string" || secret.length === 0) {
      logger.error("[SessionManager] Invalid secret provided");
      return null;
    }

    // S1.3 — Enforce session secret minimum 32 characters. Checked here
    // (rather than relying on SessionCookie's constructor throw) so a
    // short secret deterministically yields null instead of an exception.
    if (secret.length < SESSION_SECRET_MIN_LENGTH) {
      logger.error(
        "[SessionManager] Session secret too short (must be >= 32 characters)",
      );
      return null;
    }

    this.hadLegacySessionCookie = false;
    this.hadInvalidSessionCookie = false;

    // Strategy 1: Check Authorization header first
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7); // Remove "Bearer " prefix

      // Strategy 1a: If the token looks like a JWT (3 dot-separated parts), try Cognito verification
      if (token.split(".").length === 3) {
        try {
          const { verifyLegacyCognitoClaims } = await import("./auth/cognito-jwt.js");
          const claims = await verifyLegacyCognitoClaims(token);
          logger.debug("[SessionManager] Cognito JWT verified", {
            sub: claims.sub,
            username: claims.username,
          });
          // S1.7 — Use JWT exp claim for session expiration, capped at 1 hour
          let expiresAt = Date.now() + 3600_000;
          try {
            const jwtPayload = JSON.parse(
              Buffer.from(token.split(".")[1], "base64url").toString(),
            ) as { exp?: number };
            if (jwtPayload.exp) {
              expiresAt = Math.min(jwtPayload.exp * 1000, Date.now() + 3600_000);
            }
          } catch {
            // If JWT payload parsing fails, use default 1 hour expiration
          }

          const claimsRecord = claims as unknown as Record<string, unknown>;
          // O-1 / 05a: surface the already-verified active-tenant claim. The JWT
          // was just cryptographically verified above, so this is zero extra
          // crypto. Validate it against the same cuid shape the JWT auth
          // middleware applies (auth-middleware.ts:50) and normalize the
          // empty-string claim pre-token-generation writes for a user with no
          // active membership to `undefined` — otherwise `"" ?? fallback` would
          // short-circuit the wrapper's personal-tenant fallback. A malformed
          // claim is dropped (undefined), never trusted.
          const rawActiveTenant = claimsRecord["custom:activeTenantId"];
          let activeTenantId =
            typeof rawActiveTenant === "string" &&
            rawActiveTenant !== "" &&
            CUID_RE.test(rawActiveTenant)
              ? rawActiveTenant
              : undefined;

          // `userId` MUST be the DB cuid (`User.id`): every handler looks the
          // session user up with `where: { id: session.userId }`. Cognito's
          // pre-token-generation Lambda writes it into `custom:userId`;
          // Keycloak has no such hook, and its realm protocol mappers emit
          // their own claim names, so a verified Keycloak token carries no
          // usable cuid here at all.
          //
          // VALIDATE, don't trust: this used to be
          // `claims["custom:userId"] || claims.sub`, and the `sub` fallback is
          // what seated an IdP UUID as the user id — "User not found" (404) on
          // every one of the ~46 getSession call sites, and the original
          // "Tenant resolution failed" on media upload.
          const rawUserId = claimsRecord["custom:userId"];
          let userId =
            typeof rawUserId === "string" && CUID_RE.test(rawUserId)
              ? rawUserId
              : undefined;
          let role = claimsRecord["custom:role"] as UserRole | undefined;

          if (!userId || !activeTenantId) {
            // The same server-side resolution `auth-middleware.ts` performs
            // (claims cache → DB by `sub` → first-contact provisioning). WS-0
            // wired it into that path only, leaving this one — the two Bearer
            // paths disagreed, which is the whole defect. Imported lazily so
            // the DB/provisioning graph stays off the cold path, and a no-op
            // returning null unless IDENTITY_PROVIDER=keycloak, so Cognito
            // behaviour is unchanged apart from the fail-closed check below.
            if (env) {
              try {
                const { resolveJitClaims } = await import(
                  "./identity/jit-claims.js"
                );
                const jit = await resolveJitClaims(
                  {
                    sub: claims.sub,
                    username: claims.username,
                    ...(claims.email !== undefined
                      ? { email: claims.email }
                      : {}),
                  },
                  env as unknown as Env,
                );
                if (jit) {
                  if (!userId && CUID_RE.test(jit.userId)) userId = jit.userId;
                  if (!activeTenantId && CUID_RE.test(jit.activeTenantId)) {
                    activeTenantId = jit.activeTenantId;
                  }
                  if (!role && jit.globalRole) role = jit.globalRole as UserRole;
                }
              } catch (jitErr) {
                // Fail closed via the guard below — never widen access.
                logger.warn(
                  "[SessionManager] JIT claim resolution failed",
                  jitErr,
                );
              }
            }
          }

          // Fail closed, matching `auth-middleware.ts`. A verified token that
          // resolves to no trellis user is a 401, not a session carrying a
          // foreign identifier that 404s deeper in the stack.
          if (!userId) {
            logger.warn(
              "[SessionManager] Verified token yielded no trellis user id",
              { sub: claims.sub },
            );
            return null;
          }

          const jwtSession: Session = {
            userId,
            email: claims.email || claims.username,
            role: role || "END_USER",
            expiresAt,
            dataRegion:
              (claimsRecord["custom:dataRegion"] as string) || "EU",
            profileContext: "primary",
            ageTier:
              (claimsRecord["custom:ageTier"] as AgeTier) || "ADULT",
            ...(activeTenantId ? { activeTenantId } : {}),
            // Plan 034 lane A: a verified Bearer JWT on this path is the
            // human's own token — first-party, unscoped. No `scope`/`scp`/
            // `azp` claim is read from the IdP (see auth-middleware.ts for
            // why); a narrowed grant will come from the trellis authorization
            // server in Phase 1, not from a new claim here.
            scopes: "*",
          };

          // SEC L2: the JWT is verified — now check revocation. `revokeSession`
          // hashes whatever raw token sat in the Authorization header, so a
          // logged-out bearer JWT is on the blocklist under the same key. The
          // epoch check applies too: "revoke all sessions" must cut short-lived
          // tokens as well as 90-day cookies.
          if (await this.isSealedSessionRevoked(token, jwtSession, env)) {
            logger.debug("[SessionManager] Bearer JWT session revoked");
            return null;
          }

          return jwtSession;
        } catch (jwtErr) {
          logger.debug(
            "[SessionManager] Cognito JWT verification failed, trying encrypted session",
            jwtErr,
          );
          // Fall through to encrypted session approach
        }
      }

      // Strategy 1b: Try to decrypt as encrypted session token (localStorage approach)
      const plaintext = await this.unsealWithRotation(
        token,
        secret,
        salt,
        fallbackSecret,
      );

      if (plaintext) {
        try {
          const parsed: unknown = JSON.parse(plaintext);
          const session = this.narrowSessionForAuthHeader(parsed);
          if (session) {
            const now = Date.now();
            if (session.expiresAt && session.expiresAt < now) {
              logger.debug(
                "[SessionManager] Session from Authorization header expired",
              );
              return null;
            }

            // SEC L2: blocklist + epoch on the Authorization/sealed-token path
            // too. This path was entirely unchecked; a "logged out"
            // localStorage token stayed valid for its full lifetime.
            if (await this.isSealedSessionRevoked(token, session, env)) {
              logger.debug(
                "[SessionManager] Session from Authorization header revoked",
              );
              return null;
            }

            // Phase 8: the Authorization path checked ONLY `expiresAt` — the
            // inactivity timeout was silently unenforced for every
            // localStorage-token client. Same rule as the cookie path now.
            if (await this.isInactive(session, now, env)) {
              logger.debug(
                "[SessionManager] Session from Authorization header expired due to inactivity",
              );
              return null;
            }

            session.lastActivityAt = now;
            return session;
          }
        } catch (parseError) {
          logger.debug(
            "[SessionManager] Failed to parse decrypted token from Authorization header",
            parseError,
          );
        }
      } else {
        logger.debug(
          "[SessionManager] Failed to decrypt token from Authorization header",
        );
      }
    }

    // Strategy 2: Fall back to cookie (for backward compatibility)
    const cookieHeader = request.headers.get("Cookie");
    if (!cookieHeader) {
      logger.debug("[SessionManager] No Cookie header found");
      return null;
    }

    // Parse cookie via foundation's parser (delegates to the npm `cookie` package).
    const cookies = parseCookieHeader(cookieHeader);

    const sessionToken = cookies[SessionManager.COOKIE_NAME] ?? null;
    if (!sessionToken) {
      if (cookies.session) {
        this.hadLegacySessionCookie = true;
        logger.debug(
          "[SessionManager] Legacy session cookie detected; ignoring legacy cookie name.",
        );
      }
      logger.debug("[SessionManager] No session cookie found.");
      return null;
    }

    const plaintext = await this.unsealWithRotation(
      sessionToken,
      secret,
      salt,
      fallbackSecret,
    );

    if (!plaintext) {
      logger.debug(
        "[SessionManager] Session decryption failed with both primary and fallback secrets",
      );
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(plaintext);
      const session = this.narrowSession(parsed);
      if (!session) {
        logger.error("[SessionManager] Invalid or legacy session structure");
        return null;
      }

      const now = Date.now();

      // Check expiration
      if (session.expiresAt && session.expiresAt < now) {
        logger.debug("[SessionManager] Session expired");
        return null;
      }

      // SEC L2: blocklist + epoch check on the cookie path. `revokeSession`
      // wrote `blocked:{hash}` on logout and nothing ever read it, so a stolen
      // cookie stayed valid for up to its 90-day lifetime after "logout".
      if (await this.isSealedSessionRevoked(sessionToken, session, env)) {
        logger.debug("[SessionManager] Session revoked");
        return null;
      }

      // Check inactivity timeout if configured
      if (await this.isInactive(session, now, env)) {
        logger.debug("[SessionManager] Session expired due to inactivity");
        return null;
      }

      // Update last activity timestamp
      session.lastActivityAt = now;

      return session;
    } catch (error) {
      logger.error("[SessionManager] Failed to parse session:", error);
      return null;
    }
  }

  /**
   * Narrow a payload parsed from the Authorization-header path. This
   * path historically accepted any object with userId + email and did
   * NOT set hadInvalidSessionCookie, so we keep that behaviour distinct
   * from the cookie path's narrowSession.
   */
  private narrowSessionForAuthHeader(parsed: unknown): Session | null {
    if (typeof parsed !== "object" || parsed === null) return null;
    const session = parsed as Record<string, unknown>;
    if (
      typeof session.userId === "string" &&
      session.userId &&
      typeof session.email === "string" &&
      session.email
    ) {
      // O-1 / 05a `[SR:H3]`: localStorage tokens are sealed sessions too — apply
      // the same strip as `narrowSession`. `activeTenantId` is trusted ONLY from
      // a verified JWT (Strategy 1a), never from a decrypted token payload.
      for (const field of SEAL_FORBIDDEN_FIELDS) delete session[field];
      // Plan 034 lane A: same stamp as `narrowSession` — a localStorage token
      // is a sealed session too, so its principal comes from here, not from
      // the decrypted payload.
      return { ...(session as unknown as Session), scopes: "*" };
    }
    return null;
  }

  /**
   * Decrypt a token trying the primary secret first, then the fallback
   * secret (zero-downtime rotation). Foundation's `SessionCookie`
   * already tries primary→fallback internally when both are configured
   * on one instance, so we construct a single cookie with both.
   */
  private async unsealWithRotation(
    token: string,
    secret: string,
    salt: string | undefined,
    fallbackSecret: string | undefined,
  ): Promise<string | null> {
    try {
      return await this.getCookie(secret, salt, fallbackSecret).unseal(token);
    } catch {
      // getCookie throws only on missing salt.
      return null;
    }
  }

  /**
   * Set session cookie in response (alias for setSession)
   */
  async setSessionCookie(
    response: Response,
    session: Session,
    secret: string,
    cookieDomain?: string,
    env?: { [key: string]: any },
  ): Promise<Response> {
    return this.setSession(response, session, secret, cookieDomain, env);
  }

  /**
   * Set session cookie in response
   * Uses configurable session timeout based on session type
   */
  async setSession(
    response: Response,
    session: Session,
    secret: string,
    cookieDomain?: string,
    env?: { [key: string]: any },
  ): Promise<Response> {
    const logger = getLogger();
    const salt = env?.SESSION_SALT as string | undefined;

    // SEC L2: the seal-time epoch is stamped by `prepareSealPayload` inside
    // `encryptSession` (the single seal chokepoint) — every seal site gets it,
    // not just this one.
    const encrypted = await this.encryptSession(
      JSON.stringify(session),
      secret,
      salt,
    );

    // Determine session type (default to 'user' for backward compatibility)
    const sessionType = session.sessionType || "user";

    // Calculate cookie max-age based on session type and configuration
    let cookieMaxAge: number;
    if (env) {
      const config = await this.getSessionConfig(env);
      const { calculateCookieMaxAge } = await import("./session-config.js");
      cookieMaxAge = calculateCookieMaxAge(config, sessionType);
    } else {
      // Fallback to default (90 days) if no config available
      cookieMaxAge = 90 * 24 * 60 * 60; // 90 days
    }

    // SameSite policy:
    // - localhost (no domain): SameSite=Lax (same-site requests).
    // - production (domain set): SameSite=None; Secure for cross-subdomain.
    // Secure is always set; HttpOnly is always set; Path=/.
    const isLocalhost = !cookieDomain || cookieDomain === "";
    const cookieValue = serializeSetCookie(SessionManager.COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure: true,
      sameSite: isLocalhost ? "lax" : "none",
      path: "/",
      maxAge: cookieMaxAge,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });

    logger.debug(
      "[SessionManager] Setting session cookie (length: " +
        encrypted.length +
        (cookieDomain ? ", domain: " + cookieDomain : "") +
        ")",
    );

    // Clone response to add cookie header
    const newResponse = new Response(response.body, response);
    newResponse.headers.append("Set-Cookie", cookieValue);

    return newResponse;
  }

  /**
   * Clear session cookie (alias for clearSession)
   */
  clearSessionCookie(response: Response): Response {
    return this.clearSession(response);
  }

  /**
   * Clear session cookie
   * @param response - Response to add clear cookie headers to
   * @param cookieDomain - Optional domain to clear cookie from (e.g., ".example.com" for cross-subdomain)
   */
  clearSession(response: Response, cookieDomain?: string): Response {
    const newResponse = new Response(response.body, response);

    // Consolidated cookie clearing: Max-Age=0 clears regardless of SameSite value.
    // 1. Current cookie name without domain (clears API-domain-only cookies)
    // 2. Current cookie name with domain (clears cross-subdomain cookies, if domain is set)
    // 3. Legacy cookie name without domain (backward compatibility)
    const cookieName = SessionManager.COOKIE_NAME;
    const expired = new Date(0);

    const clearAttrs = {
      httpOnly: true,
      secure: true,
      sameSite: "none" as const,
      path: "/",
      maxAge: 0,
      expires: expired,
    };

    // 1. Clear current cookie without domain
    newResponse.headers.append(
      "Set-Cookie",
      serializeSetCookie(cookieName, "", clearAttrs),
    );

    // 2. Clear current cookie with domain (if set)
    if (cookieDomain) {
      newResponse.headers.append(
        "Set-Cookie",
        serializeSetCookie(cookieName, "", { ...clearAttrs, domain: cookieDomain }),
      );
    }

    // 3. Clear legacy "session" cookie without domain (backward compatibility)
    newResponse.headers.append(
      "Set-Cookie",
      serializeSetCookie("session", "", clearAttrs),
    );

    return newResponse;
  }

  /**
   * Phase 8 — inactivity-timeout check, FAIL CLOSED on a missing timestamp.
   *
   * Previously guarded by `if (env && session.lastActivityAt)`: a sealed
   * payload that simply omitted `lastActivityAt` skipped the check entirely, so
   * the inactivity timeout was advisory — any client (or any code path that
   * sealed a session without the field) opted out of it for free.
   *
   * The effective "last seen" is `lastActivityAt`, falling back to the seal-time
   * `sessionEpoch` (stamped by `setSession`, i.e. the issue time — the plan's
   * "default missing lastActivityAt to issue time"). When NEITHER is present —
   * only possible for a cookie sealed before this change — the session is
   * treated as inactive and rejected, forcing one re-authentication rather than
   * grandfathering an unbounded-idle session.
   *
   * Returns `true` when the session must be rejected.
   */
  private async isInactive(
    session: Session,
    now: number,
    env: { [key: string]: any } | undefined,
  ): Promise<boolean> {
    if (!env) return false;
    const config = await this.getSessionConfig(env);
    if (!(config.inactivityTimeoutMinutes > 0)) return false;

    const lastSeen = session.lastActivityAt ?? session.sessionEpoch;
    if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) {
      // Fail closed: no evidence of recent activity, and no issue time.
      return true;
    }
    const inactivityTimeout = config.inactivityTimeoutMinutes * 60 * 1000;
    return now - lastSeen > inactivityTimeout;
  }

  /**
   * SEC L2 — is this raw token on the revocation blocklist?
   *
   * Returns `true` (⇒ deny) when the token is blocked OR when the check could
   * not be completed. Failing CLOSED is the point of the finding: a
   * best-effort blocklist that silently allows on a KV outage is a blocklist an
   * attacker can bypass by causing (or waiting for) an outage.
   *
   * Configuration note: when NO blocklist KV is bound at all, the check is a
   * no-op (returns `false`). That is a deployment shape — local dev and the
   * unit-test envs bind no KV — not an outage, and treating it as a denial
   * would make trellis unusable without a KV. Operators who want the strict
   * reading set `SESSION_BLOCKLIST_REQUIRED=true`, which turns a missing
   * binding into a denial as well.
   */
  private async isTokenRevoked(
    token: string,
    env: { [key: string]: any } | undefined,
  ): Promise<boolean> {
    const kv = getBlocklistReader(env);
    if (!kv) {
      if (env?.SESSION_BLOCKLIST_REQUIRED === "true") {
        getLogger().error(
          "[SessionManager] SESSION_BLOCKLIST_REQUIRED=true but no SESSION_BLOCKLIST_KV is bound; denying",
        );
        return true;
      }
      return false;
    }
    try {
      const hash = await this.hashToken(token);
      const blocked = await kv.get(blocklistKeyForToken(hash));
      return blocked !== null && blocked !== undefined;
    } catch (err) {
      // Fail CLOSED — see the doc comment above.
      getLogger().error(
        "[SessionManager] Session blocklist lookup failed; denying session",
        err,
      );
      return true;
    }
  }

  /**
   * SEC L2 — has this user's session epoch been bumped since the session was
   * sealed ("revoke all sessions")?
   *
   * Returns `true` (⇒ deny) when the sealed epoch is older than the stored one,
   * and when the lookup fails (fail closed). A sealed session predating this
   * change carries no `sessionEpoch`; it is treated as epoch 0, so any stored
   * epoch invalidates it — which is exactly the intent of a revoke-all.
   */
  private async isEpochStale(
    session: Session,
    env: { [key: string]: any } | undefined,
  ): Promise<boolean> {
    const kv = getBlocklistReader(env);
    if (!kv) return env?.SESSION_BLOCKLIST_REQUIRED === "true";
    try {
      const raw = await kv.get(sessionEpochKey(session.userId));
      if (raw === null || raw === undefined || raw === "") return false;
      const storedEpoch = Number(raw);
      if (!Number.isFinite(storedEpoch)) return false;
      return (session.sessionEpoch ?? 0) < storedEpoch;
    } catch (err) {
      getLogger().error(
        "[SessionManager] Session-epoch lookup failed; denying session",
        err,
      );
      return true;
    }
  }

  /**
   * SEC L2 — combined post-verification gate for a SEALED session (cookie or
   * localStorage token): blocklist + epoch. Returns `true` when the session
   * must be rejected.
   */
  private async isSealedSessionRevoked(
    token: string,
    session: Session,
    env: { [key: string]: any } | undefined,
  ): Promise<boolean> {
    if (await this.isTokenRevoked(token, env)) return true;
    return this.isEpochStale(session, env);
  }

  /**
   * AUTH-5: Hash a session token for blocklist storage.
   */
  private async hashToken(token: string): Promise<string> {
    const encoded = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * AUTH-5: Revoke a session token by adding it to the blocklist.
   * Call this on logout to prevent token reuse.
   *
   * No foundation equivalent exists — this composes over the trellis
   * blocklist KV store and is kept verbatim.
   */
  async revokeSession(
    request: Request,
    env: { [key: string]: any },
  ): Promise<void> {
    const kvStore = getBlocklistWriter(env);
    if (!kvStore) return; // No blocklist KV configured

    // Extract the raw token from the request
    const authHeader = request.headers.get("Authorization");
    let token: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      const cookieHeader = request.headers.get("Cookie");
      if (cookieHeader) {
        const cookies = parseCookieHeader(cookieHeader);
        token = cookies[SessionManager.COOKIE_NAME] ?? null;
      }
    }

    if (!token) return;

    const tokenHash = await this.hashToken(token);
    // Store with TTL matching max session lifetime (90 days). Key format is
    // read back by `isTokenRevoked` via `blocklistKeyForToken`.
    await kvStore.put(blocklistKeyForToken(tokenHash), "1", {
      expirationTtl: BLOCKLIST_TTL_SECONDS,
    });
  }

  /**
   * SEC L2: revoke EVERY session for a user ("log out everywhere") by bumping
   * the stored session epoch. Any sealed session whose `sessionEpoch` predates
   * the bump is rejected by `getSession`.
   *
   * Call this on password/credential change, on account suspension, and from
   * the user-facing "sign out of all devices" action. Without it the only
   * global kill switch was rotating `SESSION_SECRET`, which logs out everyone.
   *
   * Throws if the KV write fails — the caller must not report success for a
   * revocation that did not persist.
   */
  async revokeAllSessions(
    userId: string,
    env: { [key: string]: any },
  ): Promise<void> {
    const kvStore = getBlocklistWriter(env);
    if (!kvStore) {
      throw new Error(
        "revokeAllSessions requires SESSION_BLOCKLIST_KV to be configured",
      );
    }
    await kvStore.put(sessionEpochKey(userId), String(Date.now()), {
      expirationTtl: BLOCKLIST_TTL_SECONDS,
    });
  }
}

// Re-export foundation constants for callers that referenced the
// trellis minimums (kept for parity; foundation owns the canonical values).
export { MIN_SECRET_LENGTH, MIN_SALT_LENGTH };
