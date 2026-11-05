/**
 * MFA Routes (AUTH-1)
 *
 * Endpoints for MFA enrollment, verification, and status.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createPrisma } from "../../db.js";
import {
  openSecret,
  resolveKeyring,
  sealSecret,
  type Keyring,
} from "../at-rest-secret.js";
import { CorsHandler } from "../cors-handler.js";
import { getLogger, Logger } from "../logger.js";
import { MfaHandler } from "../mfa/mfa-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { trustedClientIp } from "../net/trusted-client-ip.js";
import { RateLimiter } from "../rate-limit.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Env } from "../../env.js";
import type { Route } from "./types.js";

/**
 * Verification-attempt throttle (DP-2).
 *
 * A six-digit TOTP with a ±1-step window is three valid codes in a million;
 * unthrottled, the second factor falls to ~3×10⁵ POSTs from whoever holds the
 * first (a session). Both `/verify` and `/enroll/finalize` count attempts —
 * failed AND successful, so the budget is spent before the code is checked
 * and a slow-drip attacker cannot probe for free.
 *
 * Two buckets: per user (the session's user — a stolen session IS the user)
 * and per trusted client IP (so one address cannot spread attempts across
 * accounts). Thresholds are runtime config with defaults, never constants
 * (AGENTS.md §7 threshold-secrecy rule).
 */
const DEFAULT_MFA_MAX_ATTEMPTS = 5;
const DEFAULT_MFA_MAX_ATTEMPTS_PER_IP = 20;
const DEFAULT_MFA_WINDOW_SECONDS = 300;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Resolve the throttle from env, falling back to the defaults above. */
export function mfaAttemptLimits(env: Env): {
  perUser: number;
  perIp: number;
  windowSeconds: number;
} {
  return {
    perUser: positiveInt(env.MFA_VERIFY_MAX_ATTEMPTS, DEFAULT_MFA_MAX_ATTEMPTS),
    perIp: positiveInt(
      env.MFA_VERIFY_MAX_ATTEMPTS_PER_IP,
      DEFAULT_MFA_MAX_ATTEMPTS_PER_IP,
    ),
    windowSeconds: positiveInt(
      env.MFA_VERIFY_WINDOW_SECONDS,
      DEFAULT_MFA_WINDOW_SECONDS,
    ),
  };
}

/**
 * Consume one attempt from both buckets. Returns the 429 to send, or null.
 *
 * The IP bucket is keyed on `trustedClientIp` rather than the limiter's own
 * raw-header fallback, so a spoofed X-Forwarded-For cannot mint fresh buckets
 * when no trusted proxy is configured. It rides in the limiter's `sessionId`
 * slot purely as a key component — there is no session semantics to it.
 */
async function consumeMfaAttempt(
  rateLimiter: RateLimiter,
  env: Env,
  request: Request,
  endpoint: string,
  userId: string,
): Promise<Response | null> {
  const { perUser, perIp, windowSeconds } = mfaAttemptLimits(env);

  const perUserLimited = await rateLimiter.applyRateLimitKV(
    env as any,
    request,
    `${endpoint}:user`,
    perUser,
    windowSeconds,
    undefined,
    undefined,
    userId,
  );
  if (perUserLimited) return perUserLimited;

  return rateLimiter.applyRateLimitKV(
    env as any,
    request,
    `${endpoint}:ip`,
    perIp,
    windowSeconds,
    `ip:${trustedClientIp(request, env as any)}`,
  );
}

const BeginEnrollmentSchema = z.object({});

/**
 * Enrollment binding (L14).
 *
 * `enroll/begin` mints the secret and backup codes but stores nothing, so
 * `enroll/finalize` used to accept whatever secret/backup codes the client
 * sent — a client-chosen TOTP seed. The binding is a stateless, AEAD-sealed
 * ticket (sealed under the "mfa" keyring, so it needs no new table or key)
 * carrying {user, secret, backup codes, issue time, expiry}. `finalize`
 * requires it and takes the secret/codes FROM the ticket; a client-supplied
 * secret/backupCodes is optional and, if present, must equal the ticket's.
 * Single use is enforced against the enrollment row (see
 * `MfaHandler.finalizeEnrollment`). The TTL is runtime config.
 */
const ENROLL_TICKET_TAG = "mfa-enroll-v1";
const DEFAULT_MFA_ENROLL_TTL_SECONDS = 600;

/** Resolve the enrollment-ticket lifetime (env, then process.env, then default). */
export function mfaEnrollTtlSeconds(env: Env): number {
  return positiveInt(
    (env as unknown as Record<string, string | undefined>).MFA_ENROLL_TTL_SECONDS ??
      process.env.MFA_ENROLL_TTL_SECONDS,
    DEFAULT_MFA_ENROLL_TTL_SECONDS,
  );
}

interface EnrollmentTicket {
  readonly secret: string;
  readonly backupCodes: readonly string[];
  readonly issuedAt: number;
}

async function sealEnrollmentTicket(
  keyring: Keyring,
  userId: string,
  secret: string,
  backupCodes: readonly string[],
  now: number,
  ttlSeconds: number,
): Promise<string> {
  return sealSecret(
    JSON.stringify({
      t: ENROLL_TICKET_TAG,
      u: userId,
      s: secret,
      b: backupCodes,
      i: now,
      e: now + ttlSeconds * 1000,
    }),
    keyring,
  );
}

/** Open a ticket for `userId`; null on any tamper, wrong user, wrong shape or expiry. */
async function openEnrollmentTicket(
  keyring: Keyring,
  token: string,
  userId: string,
  now: number,
): Promise<EnrollmentTicket | null> {
  let payload: any;
  try {
    payload = JSON.parse(await openSecret(token, keyring));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.t !== ENROLL_TICKET_TAG ||
    payload.u !== userId ||
    typeof payload.s !== "string" ||
    !Array.isArray(payload.b) ||
    !payload.b.every((c: unknown) => typeof c === "string") ||
    typeof payload.i !== "number" ||
    typeof payload.e !== "number" ||
    payload.e <= now
  ) {
    return null;
  }
  return { secret: payload.s, backupCodes: payload.b, issuedAt: payload.i };
}

/** Constant-time string equality (digests first, so length is not leaked). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

function safeEqualList(a: readonly string[], b: readonly string[]): boolean {
  let ok = a.length === b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    ok = safeEqual(a[i] ?? "", b[i] ?? "") && ok;
  }
  return ok;
}

const FinalizeEnrollmentSchema = z.object({
  enrollmentToken: z.string().min(1).max(8192),
  // Optional echoes of what begin issued; verified against the ticket, never trusted.
  secret: z.string().min(16).max(64).optional(),
  backupCodes: z.array(z.string()).min(1).max(20).optional(),
  verificationCode: z.string().length(6).regex(/^\d{6}$/),
});

const VerifyCodeSchema = z.object({
  code: z.string().min(6).max(12), // TOTP (6) or backup code (9 with dash)
  type: z.enum(["totp", "backup"]).default("totp"),
});

export const mfaRoutes: Route[] = [
  // GET /api/mfa/status - Get MFA enrollment status
  {
    path: "/api/mfa/status",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      try {
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );
        if (!session) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const prisma = createPrisma(env);
        const mfaHandler = new MfaHandler(env);
        const status = await mfaHandler.getStatus(
          prisma,
          session.userId,
          session.role,
        );

        const res = securityHeaders.createSecureResponse(
          JSON.stringify(status),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      } catch (error: any) {
        logger.error("[MFA] Status check failed:", error);
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get MFA enrollment status",
  },

  // POST /api/mfa/enroll/begin - Begin MFA enrollment
  {
    path: "/api/mfa/enroll/begin",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      try {
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );
        if (!session) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const mfaHandler = new MfaHandler(env);
        const enrollment = await mfaHandler.beginEnrollment(session.email);

        const ttlSeconds = mfaEnrollTtlSeconds(env);
        const enrollmentToken = await sealEnrollmentTicket(
          resolveKeyring(env, "mfa"),
          session.userId,
          enrollment.secret,
          enrollment.backupCodes,
          Date.now(),
          ttlSeconds,
        );

        const res = securityHeaders.createSecureResponse(
          JSON.stringify({
            otpauthUri: enrollment.otpauthUri,
            secret: enrollment.secret,
            backupCodes: enrollment.backupCodes,
            enrollmentToken,
            enrollmentTokenExpiresInSeconds: ttlSeconds,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      } catch (error: any) {
        logger.error("[MFA] Begin enrollment failed:", error);
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Begin MFA enrollment",
  },

  // POST /api/mfa/enroll/finalize - Finalize MFA enrollment
  {
    path: "/api/mfa/enroll/finalize",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      try {
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );
        if (!session) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const limited = await consumeMfaAttempt(
          new RateLimiter(),
          env,
          request,
          "/api/mfa/enroll/finalize",
          session.userId,
        );
        if (limited) {
          return CorsHandler.addCorsHeaders(
            securityHeaders.addSecurityHeaders(limited),
            request,
            env,
          );
        }

        const body = await request.json();
        const parsed = FinalizeEnrollmentSchema.safeParse(body);
        if (!parsed.success) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              details: parsed.error.issues,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const prisma = createPrisma(env);
        const mfaHandler = new MfaHandler(env);
        // MFA_ENC_KEY when provisioned, else a session-derived key — never
        // the raw session secret (DP-3).
        const keyring = resolveKeyring(env, "mfa");

        const ticket = await openEnrollmentTicket(
          keyring,
          parsed.data.enrollmentToken,
          session.userId,
          Date.now(),
        );
        if (!ticket) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid or expired enrollment session" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }
        // A client-supplied secret/backup-code list is accepted only if it is
        // exactly what begin issued for this user.
        if (
          (parsed.data.secret !== undefined &&
            !safeEqual(parsed.data.secret, ticket.secret)) ||
          (parsed.data.backupCodes !== undefined &&
            !safeEqualList(parsed.data.backupCodes, ticket.backupCodes))
        ) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Enrollment data does not match enrollment session" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const result = await mfaHandler.finalizeEnrollment(
          prisma,
          session.userId,
          ticket.secret,
          [...ticket.backupCodes],
          parsed.data.verificationCode,
          keyring,
          ticket.issuedAt,
        );

        if (!result.success) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: result.error }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      } catch (error: any) {
        logger.error("[MFA] Finalize enrollment failed:", error);
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Finalize MFA enrollment with verification code",
  },

  // POST /api/mfa/verify - Verify MFA code (TOTP or backup)
  {
    path: "/api/mfa/verify",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const sessionManager = new SessionManager();

      try {
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env,
        );
        if (!session) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Unauthorized" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const limited = await consumeMfaAttempt(
          new RateLimiter(),
          env,
          request,
          "/api/mfa/verify",
          session.userId,
        );
        if (limited) {
          return CorsHandler.addCorsHeaders(
            securityHeaders.addSecurityHeaders(limited),
            request,
            env,
          );
        }

        const body = await request.json();
        const parsed = VerifyCodeSchema.safeParse(body);
        if (!parsed.success) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid request",
              details: parsed.error.issues,
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        const prisma = createPrisma(env);
        const mfaHandler = new MfaHandler(env);
        const keyring = resolveKeyring(env, "mfa");
        let verified = false;

        if (parsed.data.type === "backup") {
          verified = await mfaHandler.verifyBackupCode(
            prisma,
            session.userId,
            parsed.data.code,
            keyring,
          );
        } else {
          verified = await mfaHandler.verifyCode(
            prisma,
            session.userId,
            parsed.data.code,
            keyring,
          );
        }

        if (!verified) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid code" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        // Update session with mfaVerified flag. A copy, not an in-place
        // write: under the per-request identity memo one Session object is
        // shared by every component of the request (S5,
        // lib/request-identity.ts), and mfaVerified is an authorization input
        // — one component's write must not become another's decision.
        const updatedSession = {
          ...session,
          mfaVerified: true,
          mfaVerifiedAt: Date.now(),
        };
        const baseRes = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );

        // Re-issue the session cookie through SessionManager.setSession (L14)
        // — the same seal path and the same SameSite/Secure/HttpOnly/Domain/
        // Max-Age policy as the cookie it replaces. A hand-built header with
        // different attributes (Lax, no Domain, fixed 24h) could be rejected
        // or shadowed by the original cookie, so the mfaVerified flag never
        // stuck.
        const res = await sessionManager.setSession(
          baseRes,
          updatedSession,
          sessionSecret,
          undefined,
          env as any,
        );

        return CorsHandler.addCorsHeaders(res, request, env);
      } catch (error: any) {
        logger.error("[MFA] Verification failed:", error);
        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return CorsHandler.addCorsHeaders(res, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Verify MFA code",
  },
];
