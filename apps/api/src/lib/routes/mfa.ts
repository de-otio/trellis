/**
 * MFA Routes (AUTH-1)
 *
 * Endpoints for MFA enrollment, verification, and status.
 */

import { z } from "zod";
import { createPrisma } from "../../db.js";
import { CorsHandler } from "../cors-handler.js";
import { getLogger, Logger } from "../logger.js";
import { MfaHandler } from "../mfa/mfa-handler.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import type { Route } from "./types.js";

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
        const encryptionKey = sessionSecret; // Reuse session secret for MFA encryption

        const result = await mfaHandler.finalizeEnrollment(
          prisma,
          session.userId,
          parsed.data.secret,
          parsed.data.backupCodes,
          parsed.data.verificationCode,
          encryptionKey,
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
        let verified = false;

        if (parsed.data.type === "backup") {
          verified = await mfaHandler.verifyBackupCode(
            prisma,
            session.userId,
            parsed.data.code,
          );
        } else {
          verified = await mfaHandler.verifyCode(
            prisma,
            session.userId,
            parsed.data.code,
            sessionSecret,
          );
        }

        if (!verified) {
          const res = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid code" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
          return CorsHandler.addCorsHeaders(res, request, env);
        }

        // Update session with mfaVerified flag
        session.mfaVerified = true;
        session.mfaVerifiedAt = Date.now();
        const updatedSessionData = JSON.stringify(session);
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
