/**
 * User Routes
 *
 * - GET   /api/users/me       — the caller's resolved identity
 * - PATCH /api/user/profile   — profile management
 */

import { addCorsHeaders } from "../../worker.js";
import { authMiddleware } from "../auth/auth-middleware.js";
import { unauthorizedError } from "./errors.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { getIPAddress } from "../ip-scrubber.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { detectRegionSync, isValidRegion } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import type { Route } from "./types.js";

export const userRoutes: Route[] = [
  // ── GET /api/users/me ─────────────────────────────────────────────────────
  //
  // The caller's own identity, as the SERVER resolved it.
  //
  // Why this exists: clients used to read `custom:userId` and
  // `custom:activeTenantId` out of the ID token. That only ever worked on
  // Cognito, where a pre-token-generation Lambda wrote those claims. On any
  // other OIDC issuer the claim names are a per-deployment choice — the
  // Keycloak realm backing skybber dev maps neither — so a token-decoding
  // client silently gets null and degrades (skybber's realtime transport fell
  // back to polling with no error surfaced). Serving the identity from here
  // instead means the client depends on no claim at all and keeps working
  // across an IdP swap.
  //
  // `authMiddleware` has already resolved everything below (claims cache -> DB
  // -> first-contact provisioning), so all fields but `email` are free; `email`
  // costs one primary-key read. Cheap enough to call at startup, and the values
  // are request-fresh rather than as-old-as-the-token — which matters for
  // `activeTenantId`, since a tenant switch must not wait for a token refresh.
  {
    path: "/api/users/me",
    method: "GET",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const auth = await authMiddleware(request, env);
      if (!auth) return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));

      const { createPrisma } = await import("../../db.js");
      const db = createPrisma(env);
      const user = await db.user.findUnique({
        where: { id: auth.userId },
        select: { email: true },
      });

      // authMiddleware resolved this id against the DB, so a miss here means
      // the row vanished mid-request (deletion). Treat it as unauthenticated
      // rather than serving a half-populated identity.
      if (!user) {
        return securityHeaders.addSecurityHeaders(unauthorizedError(securityHeaders));
      }

      return securityHeaders.addSecurityHeaders(
        new Response(
          JSON.stringify({
            userId: auth.userId,
            activeTenantId: auth.activeTenantId,
            email: user.email,
            globalRole: auth.globalRole,
            tenantSlug: auth.tenantSlug,
            tenantRole: auth.tenantRole,
            handle: auth.handle,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              // Identity is per-caller and changes on tenant switch.
              "cache-control": "private, no-store",
            },
          },
        ),
      );
    },
    middleware: [corsMiddleware()],
    description: "Get the caller's resolved identity",
    // Flagged individually rather than via `markPublicSpec(userRoutes)`, which
    // would also publish `PATCH /api/user/profile`. Its sibling
    // `GET /api/users/me/tenants` is already in the curated spec (it rides
    // `tenantRoutes`), so leaving this one out would document half of the
    // identity surface — and this endpoint IS the contract that replaces
    // client-side claim decoding, so it is the half worth documenting.
    publicSpec: true,
  },
  {
    path: "/api/user/profile",
    method: "PATCH",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse request body
        const body = (await request.json()) as { stealth_mode?: boolean };
        const { stealth_mode } = body;

        // Validate input - stealth_mode must be boolean if provided
        if (stealth_mode !== undefined && typeof stealth_mode !== "boolean") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid input: stealth_mode must be a boolean",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Update user profile
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.update({
              where: { id: session.userId },
              data: {
                ...(stealth_mode !== undefined && {
                  stealthMode: stealth_mode,
                }),
              },
              select: {
                id: true,
                email: true,
                role: true,
                stealthMode: true,
                actorUri: true,
                handle: true,
                createdAt: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "updateUserProfile",
              userId: session.userId,
            },
          },
        );

        // Format response to match Flutter expectations
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            id: updatedUser.id,
            email: updatedUser.email,
            role: updatedUser.role,
            stealth_mode: updatedUser.stealthMode,
            actor_uri: updatedUser.actorUri,
            handle: updatedUser.handle,
            created_at: updatedUser.createdAt.toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[User] Error updating profile:", error);

        // Handle not found error
        if (
          error.code === "P2025" ||
          error.message?.includes("Record to update not found")
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Handle other errors
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to update profile" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update user profile settings",
  },
  {
    path: "/api/user/region-preference",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse request body
        const body = await request.json();
        const { region } = body as { region?: string };

        // Validate region
        if (!region || typeof region !== "string") {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid input: region is required and must be a string",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!isValidRegion(region)) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid region. Valid regions: US, EU, CN",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection (use detected region, not user preference)
        const detectedRegion = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Update user region preference
        // Note: We update in the detected region's database, but the user's dataRegion stays the same
        const updatedUser = await withQueryTimeoutAndRetry(
          dbManager,
          detectedRegion,
          env,
          async (db) => {
            return db.user.update({
              where: { id: session.userId },
              data: {
                region, // Update user preference
                // Note: dataRegion is NOT changed - it tracks where data is stored
              },
              select: {
                id: true,
                email: true,
                region: true,
                dataRegion: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "updateUserRegionPreference",
              userId: session.userId,
            },
          },
        );

        // PHASE 3: Invalidate region cache when user changes region preference
        // This ensures cached region data is updated immediately
        if (env.FOLLOWERS_KV) {
          try {
            // Invalidate region cache
            await env.FOLLOWERS_KV.delete(`region:${session.userId}`);
            // Invalidate validation cache (forces re-validation on next request)
            await env.FOLLOWERS_KV.delete(
              `region:validation:${session.userId}`,
            );
            logger.debug(
              "[UserRoutes] Invalidated region cache on preference change",
              {
                userId: session.userId,
                newRegion: region,
              },
            );
          } catch (error: any) {
            logger.warn("[UserRoutes] Failed to invalidate region cache", {
              userId: session.userId,
              error: error.message,
            });
            // Non-critical - cache will be updated on next request
          }
        }

        // Note: Session userRegion will be updated on next request
        // For immediate update, we could update session here, but it's not critical

        // Format response
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            region: updatedUser.region,
            data_region: updatedUser.dataRegion,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[UserRoutes] Error updating region preference:", error);
        const validator = new Validator();
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Update user region preference",
  },
  {
    path: "/api/user/cross-region-consent",
    method: "POST",
    handler: async (request, env) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse request body
        const body = (await request.json()) as {
          dataRegion: string;
          accessRegion: string;
          consented: boolean;
        };

        // Validate regions
        if (
          !isValidRegion(body.dataRegion) ||
          !isValidRegion(body.accessRegion)
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid region" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region for database connection (use accessRegion to store consent)
        const region = body.accessRegion as any;
        const dbManager = sharedDatabaseConnectionManager;

        // Get user's actual dataRegion
        const user = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.user.findUnique({
              where: { id: session.userId },
              select: { dataRegion: true },
            });
          },
          QueryTimeoutPresets.USER_FACING,
        );

        if (!user) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "User not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Verify dataRegion matches
        if (user.dataRegion !== body.dataRegion) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Data region mismatch" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Record consent — APPEND-ONLY (GDPR Art.7(1)/(3), IRB audit).
        //
        // The old code upserted a single row and set `consentedAt = consented
        // ? now : null`, which DESTROYED the original grant timestamp on
        // withdrawal. Instead we never mutate the consent decision on an
        // existing row: we supersede the current active row (active=false,
        // supersededAt=now) and INSERT a fresh row for this event. A
        // withdrawal row PRESERVES the grant's `consentedAt` (carried forward
        // from the superseded row) and records `withdrawnAt`. Full history is
        // retained; the partial unique index keys only `active` rows.
        const ipAddress = getIPAddress(request);
        const userAgent = request.headers.get("User-Agent") || undefined;
        const now = new Date();

        const { consent, previousConsented } = (await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.$transaction(async (tx: any) => {
              // Current decision for this (user, cross-region triple).
              const prior = await tx.consent.findFirst({
                where: {
                  userId: session.userId,
                  purpose: "CROSS_REGION",
                  dataRegion: body.dataRegion,
                  accessRegion: body.accessRegion,
                  active: true,
                },
              });

              // Preserve the original grant timestamp across a withdrawal: a
              // withdrawal carries forward the prior grant's consentedAt; a
              // grant stamps a fresh consentedAt.
              const consentedAt = body.consented
                ? now
                : (prior?.consentedAt ?? null);

              if (prior) {
                await tx.consent.update({
                  where: { id: prior.id },
                  data: { active: false, supersededAt: now },
                });
              }

              const created = await tx.consent.create({
                data: {
                  userId: session.userId,
                  purpose: "CROSS_REGION",
                  dataRegion: body.dataRegion,
                  accessRegion: body.accessRegion,
                  consented: body.consented,
                  consentedAt,
                  withdrawnAt: body.consented ? null : now,
                  ipAddress,
                  userAgent,
                  active: true,
                },
              });

              return {
                consent: created,
                previousConsented: prior?.consented ?? null,
              };
            });
          },
          QueryTimeoutPresets.USER_FACING,
        )) as {
          consent: {
            consented: boolean;
            dataRegion: string | null;
            accessRegion: string | null;
          };
          previousConsented: boolean | null;
        };

        // Audit the consent change (best-effort; never block the request).
        // `consent.changed` is a string literal — the named constant
        // CONSENT_CHANGED is added separately in audit-actions.ts; AuditAction
        // is an open union so the literal typechecks today.
        try {
          const { createAuditLogger } = await import("../audit-composer.js");
          createAuditLogger(env)
            .log(
              {
                type: "user_action",
                action: "consent.changed",
                resource: "consent",
                userId: session.userId,
                region: region as any,
                ipAddress,
                userAgent,
                success: true,
                metadata: {
                  purpose: "CROSS_REGION",
                  studyId: null,
                  consented: body.consented,
                  previousConsented,
                },
              },
              env,
            )
            .catch((err) => {
              logger.warn("[UserRoutes] consent audit logging failed:", err);
            });
        } catch (auditErr) {
          logger.warn("[UserRoutes] consent audit logging failed:", auditErr);
        }

        const successResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            consented: consent.consented,
            dataRegion: consent.dataRegion,
            accessRegion: consent.accessRegion,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(successResponse, request, env);
      } catch (error) {
        logger.error(
          "[UserRoutes] Error recording cross-region consent:",
          error,
        );
        const validator = new Validator();
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Record user consent for cross-region data access",
  },
];
