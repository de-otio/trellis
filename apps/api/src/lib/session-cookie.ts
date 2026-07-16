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
}

/** Minimum session-secret length. Mirrors foundation's MIN_SECRET_LENGTH. */
const SESSION_SECRET_MIN_LENGTH = MIN_SECRET_LENGTH;

/**
 * Session fields that must NEVER be persisted in sealed material (cookie /
 * localStorage token). Trusted only from a freshly-verified JWT per request.
 * See the `Session.activeTenantId` doc and `encryptSession`'s `[SR:H3]` note.
 */
const SEAL_FORBIDDEN_FIELDS = ["activeTenantId"] as const;

/**
 * Remove {@link SEAL_FORBIDDEN_FIELDS} from a to-be-sealed JSON payload string.
 *
 * Operates on the JSON string `encryptSession` receives. If the payload does not
 * parse as a JSON object (no current caller — every seal path stringifies a
 * `Session`), it is returned unchanged: the strip is a session-scope invariant,
 * not a general transform, and must not corrupt a non-session payload.
 */
function stripSealForbiddenFields(data: string): string {
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
    return this.getCookie(secret, salt).seal(stripSealForbiddenFields(data));
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
      return session as unknown as Session;
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
          const { verifyCognitoJwt } = await import("./auth/cognito-jwt.js");
          const claims = await verifyCognitoJwt(token);
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
          const activeTenantId =
            typeof rawActiveTenant === "string" &&
            rawActiveTenant !== "" &&
            CUID_RE.test(rawActiveTenant)
              ? rawActiveTenant
              : undefined;
          return {
            // Prefer the cuid in `custom:userId` (the DB `User.id`, written by
            // pre-token-generation) over the Cognito `sub`. The app looks up the
            // session user via `where: { id: session.userId }`, so the raw `sub`
            // (a UUID) misses the cuid-keyed row — which broke media uploads
            // ("Tenant resolution failed"). This mirrors the route-helpers fix;
            // SessionManager.getSession is the Bearer path the media routes use.
            userId: claims["custom:userId"] || claims.sub,
            email: claims.email || claims.username,
            role: (claimsRecord["custom:role"] as UserRole) || "END_USER",
            expiresAt,
            dataRegion:
              (claimsRecord["custom:dataRegion"] as string) || "EU",
            profileContext: "primary",
            ageTier:
              (claimsRecord["custom:ageTier"] as AgeTier) || "ADULT",
            ...(activeTenantId ? { activeTenantId } : {}),
          } satisfies Session;
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

      // Check inactivity timeout if configured
      if (env && session.lastActivityAt) {
        const config = await this.getSessionConfig(env);
        if (config.inactivityTimeoutMinutes > 0) {
          const inactivityTimeout = config.inactivityTimeoutMinutes * 60 * 1000;
          const timeSinceLastActivity = now - session.lastActivityAt;
          if (timeSinceLastActivity > inactivityTimeout) {
            logger.debug("[SessionManager] Session expired due to inactivity");
            return null;
          }
        }
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
      return session as unknown as Session;
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
    const kvStore = (env as { SESSION_BLOCKLIST_KV?: { put: (key: string, value: string, opts: { expirationTtl: number }) => Promise<unknown> } }).SESSION_BLOCKLIST_KV;
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
    // Store with TTL matching max session lifetime (90 days)
    await kvStore.put(`blocked:${tokenHash}`, "1", {
      expirationTtl: 90 * 24 * 60 * 60,
    });
  }
}

// Re-export foundation constants for callers that referenced the
// trellis minimums (kept for parity; foundation owns the canonical values).
export { MIN_SECRET_LENGTH, MIN_SALT_LENGTH };
