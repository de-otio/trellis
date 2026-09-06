/**
 * MFA Routes (AUTH-1)
 *
 * Endpoints for MFA enrollment, verification, and status.
 */

import { z } from "zod";
import { createPrisma } from "../../db.js";
import { resolveKeyring } from "../at-rest-secret.js";
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

const FinalizeEnrollmentSchema = z.object({
  secret: z.string().min(16).max(64),
  backupCodes: z.array(z.string()).min(1).max(20),
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

        const res = securityHeaders.createSecureResponse(
          JSON.stringify({
            otpauthUri: enrollment.otpauthUri,
            secret: enrollment.secret,
            backupCodes: enrollment.backupCodes,
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

        const result = await mfaHandler.finalizeEnrollment(
          prisma,
          session.userId,
          parsed.data.secret,
          parsed.data.backupCodes,
          parsed.data.verificationCode,
          keyring,
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
        const updatedSessionData = JSON.stringify(updatedSession);
        const sessionSalt = (env as any).SESSION_SALT as string | undefined;
        const encryptedSession = await sessionManager.encryptSession(
          updatedSessionData,
          sessionSecret,
          sessionSalt,
        );

        const res = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );

        // Set updated session cookie
        res.headers.set(
          "Set-Cookie",
          `trellis_session=${encryptedSession}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
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
