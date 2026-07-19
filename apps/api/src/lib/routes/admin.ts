/**
 * Admin Routes
 */

import { z } from "zod";
import { createPrisma } from "../../db.js";
import { addCorsHeaders } from "../../worker.js";
import { DataRouter } from "../data-router.js";
import { sharedDatabaseConnectionManager } from "../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../db-query-helper.js";
import { DomainReputationService } from "../domain-reputation-service.js";
import { FeatureToggleService } from "../feature-toggle-service.js";
import { getLogger, Logger } from "../logger.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import {
  rateLimitAdminFeatureToggleAPI,
  rateLimitFeatureToggleAPI,
} from "../middleware/feature-toggle-rate-limit.js";
import { detectRegionSync } from "../region-detection.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import {
  FeatureToggleKeySchema,
  PublicAPIQuerySchema,
} from "../validation/feature-toggle-schemas.js";
import {
  validateBody,
  validatePathParam,
  validateQuery,
  ValidationError,
} from "../validation/validate-request.js";
import { getAppVersion } from "../version.js";
import type { Route } from "./types.js";

export const adminRoutes: Route[] = [
  // Test-only endpoints (must be before wildcard routes)
  // Test-only endpoint: Create test user (dev environment only, no auth required for tests)
  {
    path: "/api/admin/test/users",
    method: "POST",
    handler: async (request, env) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // SECURITY: Only allow in dev/test environments
      // Note: env.ENVIRONMENT falls back to NODE_ENV (which is "production" in Docker),
      // so prefer env.STAGE which is explicitly set by CDK to the deployment stage.
      const environment = (
        env.STAGE ||
        env.DEPLOY_ENV ||
        "dev"
      ).toLowerCase();
      if (environment === "prod" || environment === "production") {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Forbidden: Test endpoints not available in production",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        const body = (await request.json()) as {
          email?: string;
          role?: string;
          region?: string;
          dataRegion?: string;
          id?: string;
        };

        const userId = body.id || crypto.randomUUID();
        const email =
          body.email ||
          `test-${Date.now()}-${Math.random().toString(36).substring(7)}@test.example.com`;
        const role = (body.role || "END_USER") as any;

        // OPTIMIZATION: Detect test users and skip authentication check for speed
        // Test users are identified by email pattern (@test.example.com or test- prefix)
        const isTestUser =
          email.includes("@test.example.com") || email.includes("test-");
        const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";

        // FAST PATH: For test users, use default region from env (skip region detection)
        // This avoids any region detection overhead and uses the fastest default
        const defaultRegion = (env.DEFAULT_REGION || "US") as string;
        const region = body.region || (isTestUser ? defaultRegion : "US");
        const dataRegion = body.dataRegion || region;

        // SECURITY: For non-test users or non-CI environments, check authentication
        // This is safe because:
        // 1. Only works in dev/test environments (checked above)
        // 2. Test users are identified by email pattern
        // 3. Tests need fast user creation without authentication overhead
        if (!isTestUser && !isCI) {
          const sessionManager = new SessionManager();
          const sessionSecret = env.SESSION_SECRET;
          const session = await sessionManager.getSession(
            request,
            sessionSecret,
            env as any,
          );

          if (session) {
            // Use fast query with timeout for role check (non-blocking for test user creation)

            const detectedRegion = detectRegionSync(request, env);
            const user = await withQueryTimeoutAndRetry(
              sharedDatabaseConnectionManager,
              detectedRegion,
              env,
              async (db) => {
                return await db.user.findUnique({
                  where: { id: session.userId },
                  select: { role: true },
                });
              },
              {
                ...QueryTimeoutPresets.USER_FACING, // Fast timeout (1s + 1s retry)
                defaultValue: null, // Return null on timeout (allow test user creation)
                context: {
                  operation: "checkUserRoleForTestEndpoint",
                  userId: session.userId,
                },
              },
            );

            if (!user || user.role !== "SUPER_ADMIN") {
              const errorResponse = securityHeaders.createSecureResponse(
                JSON.stringify({
                  error: "Forbidden: Super-admin access required",
                }),
                {
                  status: 403,
                  headers: { "content-type": "application/json" },
                },
              );
              return addCorsHeaders(errorResponse, request, env);
            }
          }
        }

        // OPTIMIZATION: For test users, don't pass request object to avoid any overhead
        // This ensures the fastest possible path for test user creation
        const userCreationStartTime = Date.now();

        // ✅ BEST PRACTICE: Defense-in-depth timeout wrapper
        // The database query timeout (2-3s) should be sufficient, but we add a safety net
        // to catch cases where the entire operation hangs (e.g., connection acquisition issues).
        // Calculate based on actual database timeout configuration:
        // - Local: 2s timeout, 0 retries = 2s max
        // - CI: 3s timeout, 1 retry (1s) = 4s max
        // Add 50% buffer for connection acquisition and overhead
        const dbTimeoutMs = isCI ? 3000 : 2000;
        const dbRetryTimeoutMs = isCI ? 1000 : 500;
        const dbMaxRetries = isCI ? 1 : 0;
        const maxExpectedDbTime = dbTimeoutMs + dbRetryTimeoutMs * dbMaxRetries;
        const safetyBufferMs = Math.ceil(maxExpectedDbTime * 0.5); // 50% buffer
        const TEST_USER_CREATION_TIMEOUT_MS =
          maxExpectedDbTime + safetyBufferMs;

        // Signup-metadata (P3): this dev/test-only seam creates users with no
        // real request context. It gets a `signupMethod` (COGNITO) via the
        // choke-point helper but NO fabricated IP/UA and no SecurityEvent —
        // synthetic test accounts must not pollute the signup-cohort signal.
        const { signupUserData } = await import("../signup-metadata.js");
        const signupFields = signupUserData({ method: "COGNITO" });

        const userCreationPromise = DataRouter.createUser(
          {
            id: userId,
            email,
            role,
            signupMethod: signupFields.signupMethod,
            invitationId: signupFields.invitationId,
          },
          region,
          env,
          isTestUser ? undefined : request, // Skip request for test users to avoid overhead
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Test user creation timed out after ${TEST_USER_CREATION_TIMEOUT_MS}ms. ` +
                  `Database query timeout (${dbTimeoutMs}ms) should have triggered first at <${maxExpectedDbTime}ms. ` +
                  `This indicates the database timeout mechanism may not be working correctly, ` +
                  `or there's a connection acquisition issue outside the query timeout scope.`,
              ),
            );
          }, TEST_USER_CREATION_TIMEOUT_MS);
        });

        const createdUser = await Promise.race([
          userCreationPromise,
          timeoutPromise,
        ]);

        const userCreationDuration = Date.now() - userCreationStartTime;
        logger.debug("[UserCreation] User creation completed", {
          duration: userCreationDuration,
          userId: createdUser.id,
          region,
          isTestUser,
        });

        // Create a session for the test user so tests don't need to know SESSION_SECRET
        const sessionManager = new SessionManager();
        const sessionSecret = env.SESSION_SECRET;
        const testSession: any = {
          userId: createdUser.id,
          email: createdUser.email,
          role: role,
          expiresAt: Date.now() + 3600000, // 1 hour
          dataRegion: createdUser.dataRegion || region,
          sessionType: "user",
          lastActivityAt: Date.now(),
          profileContext: "primary",
        };

        let response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            user: {
              id: createdUser.id,
              email: createdUser.email,
              role: role,
              region: createdUser.region,
              dataRegion: createdUser.dataRegion,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );

        // Set session cookie on the response
        response = await sessionManager.setSession(
          response,
          testSession,
          sessionSecret,
          undefined,
          env as any,
        );

        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin Test] Error creating test user:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: error.message || "Failed to create test user",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()], // No CSRF for test endpoints (unauthenticated in CI)
    description: "Create test user (dev environment only)",
  },

  // Test-only endpoint: Delete test user (dev environment only)
  {
    path: "/api/admin/test/users/:userId",
    method: "DELETE",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // SECURITY: Only allow in dev/test environments
      // Note: env.ENVIRONMENT falls back to NODE_ENV (which is "production" in Docker),
      // so prefer env.STAGE which is explicitly set by CDK to the deployment stage.
      const environment = (
        env.STAGE ||
        env.DEPLOY_ENV ||
        "dev"
      ).toLowerCase();
      if (environment === "prod" || environment === "production") {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Forbidden: Test endpoints not available in production",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // SECURITY: In test mode (CI), allow unauthenticated access for test user deletion
      const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";

      // Optionally check for SUPER_ADMIN in local dev (but allow unauthenticated in CI)
      if (!isCI) {
        const sessionSecret = env.SESSION_SECRET;
        const session = await sessionManager.getSession(
          request,
          sessionSecret,
          env as any,
        );

        if (session) {
          const db = createPrisma(env);
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { role: true },
          });

          if (!user || user.role !== "SUPER_ADMIN") {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error: "Forbidden: Super-admin access required",
              }),
              { status: 403, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }
        }
        // If no session in local dev, still allow (for test convenience)
      }

      // Extract userId from pathname (outside try block for error handler access)
      const userIdMatch = pathname.match(/\/api\/admin\/test\/users\/([^/]+)/);
      if (!userIdMatch) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invalid user ID" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const userId = userIdMatch[1];

      try {
        // Delete user via DataRouter (uses API's database connection)
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            const { deleteUserData, resolvePseudonymSecret } = await import(
              "../services/user-data-deletion.js"
            );
            // Fail-closed (WS-2 finding 2): an unresolvable tombstone key
            // errors this test-cleanup route rather than writing an unkeyed
            // (reversible) tombstone.
            await deleteUserData(db, userId, {
              pseudonymSecret: await resolvePseudonymSecret(),
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            timeoutMs: 5000, // 5 seconds for cleanup (more time for multiple deletes)
            retryTimeoutMs: 2000, // 2 seconds for retry
            maxRetries: 1, // Allow 1 retry for cleanup operations
          },
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            message: "Test user deleted successfully",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        // Ignore "Record to delete does not exist" errors
        if (error.message?.includes("Record to delete does not exist")) {
          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              success: true,
              message: "User already deleted or does not exist",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(response, request, env);
        }

        // Ignore foreign key constraint violations - user may have already been deleted
        // or related records may have been cleaned up by cascade deletes
        if (
          error.message?.includes("Foreign key constraint") ||
          error.message?.includes("foreign key constraint violated")
        ) {
          // Try to verify if user still exists
          try {
            const verifyRegion = detectRegionSync(request, env);
            const verifyDbManager = sharedDatabaseConnectionManager;
            const userExists = await withQueryTimeoutAndRetry(
              verifyDbManager,
              verifyRegion,
              env,
              async (db) => {
                const user = await db.user.findUnique({
                  where: { id: userId },
                  select: { id: true },
                });
                return !!user;
              },
              {
                ...QueryTimeoutPresets.STANDARD,
                defaultValue: false, // Assume deleted if query fails
              },
            );

            if (!userExists) {
              // User is already deleted, return success
              const response = securityHeaders.createSecureResponse(
                JSON.stringify({
                  success: true,
                  message:
                    "User already deleted (foreign key constraint handled)",
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
              return addCorsHeaders(response, request, env);
            }
          } catch (verifyError) {
            // If verification fails, log and continue with error response
            logger.warn(
              "[Admin Test] Error verifying user deletion:",
              verifyError,
            );
          }
        }

        logger.error("[Admin Test] Error deleting test user:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: error.message || "Failed to delete test user",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()], // No CSRF for test endpoints (unauthenticated in CI)
    description: "Delete test user (dev environment only)",
  },

  {
    path: "/api/admin/super-admin/*",
    method: "*",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Get session secret with error handling
      let sessionSecret: string;
      try {
        logger.debug("[Admin] Getting session secret...");
        sessionSecret = env.SESSION_SECRET;
        logger.debug(
          `[Admin] Session secret retrieved, type: ${typeof sessionSecret}, length: ${sessionSecret?.length ?? "N/A"}`,
        );
        if (!sessionSecret || typeof sessionSecret !== "string") {
          logger.error(
            `[Admin] Invalid session secret: ${typeof sessionSecret}, ${sessionSecret ? "present but invalid" : "missing"}`,
          );
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Server configuration error" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
        logger.debug(
          "[Admin] Session secret is valid, length:",
          sessionSecret.length,
        );
      } catch (error) {
        logger.error("[Admin] Error getting session secret:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Server configuration error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      logger.debug(
        "[Admin] Calling getSession with secret length:",
        sessionSecret.length,
      );
      const session = await sessionManager.getSession(
        request,
        sessionSecret,
        env as any,
      );
      logger.debug(
        "[Admin] getSession returned:",
        session ? "session found" : "null (unauthorized)",
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const db = createPrisma(env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true, email: true },
      });

      if (!user) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: User not found" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const isSuperAdmin = user.role === "SUPER_ADMIN";

      if (
        pathname === "/api/admin/super-admin/check" &&
        request.method === "GET"
      ) {
        logger.debug("[SuperAdmin] Check request", {
          userEmail: user.email,
          userRole: user.role,
          isSuperAdmin,
        });
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ isSuperAdmin }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }

      if (!isSuperAdmin) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Super-admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      const toggleService = new FeatureToggleService(db);

      // Get all feature toggles
      if (
        pathname === "/api/admin/super-admin/feature-toggles" &&
        request.method === "GET"
      ) {
        try {
          // Use standard timeout presets (consistent with other endpoints)
          // DatabaseConnectionManager handles connection health and stale connection cleanup

          const dbManager = sharedDatabaseConnectionManager;
          const region = detectRegionSync(request, env);

          // Use STANDARD preset (3s initial + 2s retry = 5s total)
          // This is consistent with other user-facing endpoints and well below Worker limits
          // Use defaultValue to return empty array on timeout/error (graceful degradation)
          let toggles: any[] = [];
          try {
            toggles = await withQueryTimeoutAndRetry(
              dbManager,
              region,
              env,
              async (client: any) => {
                const service = new FeatureToggleService(client);
                return await service.getAllToggles();
              },
              {
                ...QueryTimeoutPresets.STANDARD, // 1s initial, 0.5s retry (optimized)
                defaultValue: [], // Return empty array on timeout/error (graceful degradation)
                maxRetries: 1, // Only 1 retry to keep total time under 2s
                context: {
                  operation: "getAllFeatureToggles",
                  userEmail: user.email,
                },
              },
            );
            // Ensure toggles is always an array (defensive check)
            if (!Array.isArray(toggles)) {
              logger.warn(
                "[SuperAdmin] getAllToggles returned non-array, using empty array",
                { togglesType: typeof toggles },
              );
              toggles = [];
            }
          } catch (error: any) {
            // Defensive: If defaultValue wasn't returned (shouldn't happen, but be safe)
            // Log the error and use empty array as fallback
            // This should never happen if executeWithRetry is working correctly,
            // but we handle it defensively to ensure we always return a valid response
            logger.warn(
              "[SuperAdmin] Error in getAllToggles, using empty array fallback",
              {
                error: error?.message || String(error),
                errorCode: (error as any)?.code,
                errorName: (error as any)?.name,
                hasDefaultValue: true,
                // This indicates executeWithRetry didn't return defaultValue as expected
                // This is a defensive fallback to ensure graceful degradation
              },
            );
            toggles = []; // Fallback to empty array
          }

          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              toggles: toggles.map((toggle: any) => ({
                key: toggle.key,
                enabled: toggle.enabled,
                lastChanged: toggle.lastChanged?.toISOString(),
                changedBy: toggle.changedBy,
                description: toggle.description,
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(response, request, env);
        } catch (error) {
          logger.error(
            "[SuperAdmin] Error getting all feature toggles:",
            error,
          );
          logger.error(
            "[SuperAdmin] Error stack:",
            error instanceof Error ? error.stack : "No stack trace",
          );

          // Extract error details once
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const errorString = String(error).toLowerCase();

          logger.error("[SuperAdmin] Error type and message:", {
            type: typeof error,
            isError: error instanceof Error,
            message: errorMessage,
            string: errorString,
            errorCode: (error as any)?.code,
            errorName: (error as any)?.name,
          });

          // Check if it's a timeout error (including connection timeouts)
          // Also check for memory errors which can occur with stale connections
          // Also check for prepared statement errors (PgBouncer transaction mode limitation)
          // Be very permissive - if defaultValue was set, we should return it for ANY error

          // Since we configured defaultValue: [], treat ANY error as a timeout/connection issue
          // This provides graceful degradation - if the database is having issues, return empty array
          const isTimeout =
            errorMessage.includes("timeout") ||
            errorMessage.includes("exceeded") ||
            errorMessage.includes("Database query timeout") ||
            errorMessage.includes("timeout exceeded when trying to connect") ||
            errorMessage.includes("Database query failed after") ||
            errorMessage.includes("memory access out of bounds") || // PrismaPg adapter error from stale connections
            errorMessage.includes("ECONNREFUSED") ||
            errorMessage.includes("ETIMEDOUT") ||
            errorMessage.includes("ENOTFOUND") ||
            errorMessage.includes("ECONNRESET") ||
            errorMessage.includes("ENETUNREACH") ||
            errorString.includes("timeout") ||
            errorString.includes("exceeded") ||
            errorString.includes("database query failed") ||
            errorString.includes("memory access") ||
            errorString.includes("connection");

          // Check for prepared statement errors (PgBouncer transaction mode doesn't support prepared statements)
          const isPreparedStatementError =
            errorMessage.includes("prepared statement") ||
            errorMessage.includes("does not exist") ||
            errorMessage.includes("already exists") ||
            errorString.includes("prepared statement") ||
            (error as any)?.code === "26000" || // PostgreSQL error code for invalid prepared statement
            (error as any)?.code === "42P05"; // PostgreSQL error code for duplicate prepared statement

          // If it's a timeout/connection error OR any database-related error OR prepared statement error,
          // return empty array (graceful degradation)
          // This matches the defaultValue: [] behavior we configured in withQueryTimeoutAndRetry
          // The executeWithRetry should have returned defaultValue, but if it still throws,
          // we handle it here as a fallback
          // Be very permissive - ANY error from database operations should return empty array
          // Since we configured defaultValue: [], any error means the database query failed
          // Check error message, error string, and error code
          const isDatabaseError =
            isTimeout ||
            isPreparedStatementError ||
            errorMessage.includes("Database") ||
            errorMessage.includes("Prisma") ||
            errorMessage.includes("query") ||
            errorMessage.includes("connection") ||
            errorMessage.includes("timeout") ||
            errorMessage.includes("exceeded") ||
            errorMessage.includes("failed after") || // "Database query failed after X retries"
            errorString.includes("database") ||
            errorString.includes("prisma") ||
            errorString.includes("query") ||
            errorString.includes("connection") ||
            errorString.includes("timeout") ||
            errorString.includes("failed after") ||
            (error as any)?.code?.startsWith("P") || // Prisma error codes (P1001, P2021, etc.)
            (error as any)?.code?.startsWith("08") || // PostgreSQL connection error codes (08P01, etc.)
            (error as any)?.code?.startsWith("42") || // PostgreSQL syntax/state error codes (42P05, etc.)
            true; // Catch ALL errors - if defaultValue was set, any error should return it

          // Since we configured defaultValue: [] in withQueryTimeoutAndRetry,
          // ANY error from database operations should return empty array
          // This provides graceful degradation - if database is having issues, return empty array
          // The isDatabaseError check includes `true` at the end to catch ALL errors
          logger.warn(
            "[SuperAdmin] Error detected in feature toggle query, returning empty array (graceful degradation)",
            {
              errorMessage,
              isTimeout,
              isPreparedStatementError,
              isDatabaseError,
              errorCode: (error as any)?.code,
              errorName: (error as any)?.name,
            },
          );
          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              toggles: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(response, request, env);
        }
      }

      // Create a new feature toggle
      if (
        pathname === "/api/admin/super-admin/feature-toggles" &&
        request.method === "POST"
      ) {
        try {
          // Rate limit admin API
          const rateLimitResult = await rateLimitAdminFeatureToggleAPI(
            request,
            env,
            user.email,
          );

          if (!rateLimitResult || !rateLimitResult.allowed) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error: {
                  code: "RATE_LIMIT_EXCEEDED",
                  message: "Rate limit exceeded. Please try again later.",
                  retryAfter: rateLimitResult
                    ? Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
                    : 60,
                },
              }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  ...(rateLimitResult?.headers || {}),
                },
              },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          // Validate request body. P5: an optional `tenantId` makes this a
          // tenant-scoped OVERRIDE write instead of a global write.
          const CreateToggleSchema = z.object({
            key: FeatureToggleKeySchema,
            enabled: z.boolean().default(false),
            description: z.string().max(1000).optional(),
            tenantId: z.string().min(1).max(64).optional(),
          });
          const { key, enabled, description, tenantId } = validateBody(
            CreateToggleSchema,
            await request.json(),
          );

          // P5 authz: tenant-scoped writes require SUPER_ADMIN or the caller's
          // own active tenant. This route is already SUPER_ADMIN-gated above;
          // the explicit check keeps the authorization boundary fail-closed and
          // future-proof if that gate is ever relaxed.
          if (tenantId !== undefined) {
            const { canWriteTenantToggle } = await import(
              "../feature-toggle-service.js"
            );
            const allowed = canWriteTenantToggle({
              role: user.role,
              callerTenantId: undefined, // cookie-session admins carry no tenant
              targetTenantId: tenantId,
            });
            if (!allowed) {
              const errorResponse = securityHeaders.createSecureResponse(
                JSON.stringify({
                  error: "Forbidden: cross-tenant toggle write",
                }),
                {
                  status: 403,
                  headers: { "content-type": "application/json" },
                },
              );
              return addCorsHeaders(errorResponse, request, env);
            }
          }

          // Check if toggle already exists (scoped to the same tenant target).
          // Keep the global call arity unchanged (no trailing `undefined`) so
          // the global path stays byte-identical to pre-P5.
          const existing =
            tenantId === undefined
              ? await toggleService.getToggle(key)
              : await toggleService.getToggle(key, tenantId);
          if (existing) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Feature toggle already exists" }),
              { status: 409, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          // Create the toggle (global when tenantId is undefined). Preserve the
          // 5-arg global call shape; only the tenant path passes the 6th arg.
          const auditCtx = {
            userId: session.userId,
            env,
            region: detectRegionSync(request, env),
          };
          const toggle =
            tenantId === undefined
              ? await toggleService.setToggle(
                  key,
                  enabled,
                  user.email,
                  description,
                  auditCtx,
                )
              : await toggleService.setToggle(
                  key,
                  enabled,
                  user.email,
                  description,
                  auditCtx,
                  tenantId,
                );

          const responseHeaders: Record<string, string> = {
            "content-type": "application/json",
            ...rateLimitResult.headers,
          };

          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              success: true,
              toggle: {
                key: toggle.key,
                enabled: toggle.enabled,
                lastChanged: toggle.lastChanged.toISOString(),
                changedBy: toggle.changedBy,
                description: description,
              },
            }),
            { status: 201, headers: responseHeaders },
          );
          return addCorsHeaders(response, request, env);
        } catch (error: any) {
          if (error instanceof ValidationError) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: error.message }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }
          logger.error("[SuperAdmin] Error creating feature toggle:", error);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Failed to create feature toggle" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
      }

      if (
        pathname === "/api/admin/super-admin/settings" &&
        request.method === "GET"
      ) {
        try {
          const globalPublicPosting = await toggleService.getToggle(
            "global_public_posting_enabled",
          );
          const signupToggle =
            await toggleService.getToggle("user_signup_mode");
          let signupMode: "open" | "invitation_only" | "disabled" = "open";
          if (signupToggle?.description) {
            const modeMatch = signupToggle.description.match(
              /user_signup_mode:(open|invitation_only|disabled)/,
            );
            if (modeMatch) {
              signupMode = modeMatch[1] as
                | "open"
                | "invitation_only"
                | "disabled";
            }
          } else if (signupToggle?.enabled === false) {
            signupMode = "disabled";
          }

          const superAdminCount = await db.user.count({
            where: { role: "SUPER_ADMIN" },
          });

          const settings = {
            featureToggles: {
              global_public_posting_enabled: {
                enabled: globalPublicPosting?.enabled ?? false,
                lastChanged: globalPublicPosting?.lastChanged?.toISOString(),
                changedBy: globalPublicPosting?.changedBy,
              },
            },
            signupSettings: {
              mode: signupMode,
              lastChanged: signupToggle?.lastChanged?.toISOString(),
              changedBy: signupToggle?.changedBy,
            },
            systemInfo: {
              environment: env.ENVIRONMENT || "unknown",
              version: getAppVersion(env),
              superAdminCount,
            },
          };

          const response = securityHeaders.createSecureResponse(
            JSON.stringify(settings),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(response, request, env);
        } catch (error) {
          logger.error("[SuperAdmin] Error getting settings:", error);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Failed to get settings" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
      }

      const toggleUpdateMatch = pathname.match(
        /^\/api\/admin\/super-admin\/feature-toggles\/(.+)$/,
      );
      if (toggleUpdateMatch && request.method === "PUT") {
        try {
          logger.debug(
            `[Admin] PUT request for feature toggle, pathname: ${pathname}`,
          );
          logger.debug(
            `[Admin] toggleUpdateMatch: ${JSON.stringify(toggleUpdateMatch)}`,
          );
          logger.debug(
            `[Admin] user.email: ${user.email}, type: ${typeof user.email}`,
          );

          // Rate limit admin API (1000 requests/minute per user)
          // Ensure user.email is defined and is a string for rate limiting
          if (!user.email || typeof user.email !== "string") {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "User email not found or invalid" }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          const rateLimitResult = await rateLimitAdminFeatureToggleAPI(
            request,
            env,
            user.email, // Use email as user identifier for rate limiting
          );

          if (!rateLimitResult || !rateLimitResult.allowed) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error: {
                  code: "RATE_LIMIT_EXCEEDED",
                  message: "Rate limit exceeded. Please try again later.",
                  retryAfter: rateLimitResult
                    ? Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
                    : 60,
                },
              }),
              {
                status: 429,
                headers: {
                  "content-type": "application/json",
                  ...(rateLimitResult?.headers || {}),
                },
              },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          // Validate path parameter (toggle key)
          const pathParam = toggleUpdateMatch?.[1];
          if (!pathParam || typeof pathParam !== "string") {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error: "Invalid path parameter: toggle key is required",
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          let toggleKey: string;
          try {
            toggleKey = validatePathParam(FeatureToggleKeySchema, pathParam);
          } catch (error) {
            if (error instanceof ValidationError) {
              const errorResponse = securityHeaders.createSecureResponse(
                JSON.stringify(error.toResponse()),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
              return addCorsHeaders(errorResponse, request, env);
            }
            throw error;
          }

          // Validate request body
          let body: unknown;
          try {
            body = await request.json();
          } catch (error) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Invalid JSON in request body" }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          // Ensure body is an object
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Request body must be an object" }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          const UpdateToggleEnabledSchema = z.object({
            enabled: z.boolean({
              error: (issue) =>
                issue.input === undefined
                  ? "enabled is required"
                  : "enabled must be a boolean",
            }),
          });

          let enabled: boolean;
          try {
            const validated = validateBody(UpdateToggleEnabledSchema, body);
            enabled = validated.enabled;
          } catch (error) {
            if (error instanceof ValidationError) {
              const errorResponse = securityHeaders.createSecureResponse(
                JSON.stringify(error.toResponse()),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
              return addCorsHeaders(errorResponse, request, env);
            }
            // Log unexpected errors for debugging
            logger.error("[Admin] Unexpected error in body validation:", error);
            throw error;
          }

          // Use improved database connection manager with aggressive timeout handling

          const dbManager = sharedDatabaseConnectionManager;
          const region = detectRegionSync(request, env);

          // Top-level timeout wrapper to ensure we never hang for more than 3 seconds
          // This is well below Cloudflare's 30-second limit and ensures we always return a response
          // Aggressive timeout to fail fast if database is slow
          const MAX_TOTAL_TIMEOUT_MS = 3000; // 3 seconds total - fail fast
          let timeoutId: NodeJS.Timeout | null = null;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                new Error(
                  "Request timeout: Database operation exceeded maximum time limit",
                ),
              );
            }, MAX_TOTAL_TIMEOUT_MS);
          });

          let toggle;
          try {
            // Wrap the entire operation in a timeout-safe wrapper
            const dbOperation = (async () => {
              try {
                return await dbManager.executeWithRetry(
                  region,
                  env,
                  async (client: any) => {
                    // Create a temporary service instance with the client from timeout helper
                    const service = new FeatureToggleService(client);

                    // Ensure user.email is still defined (double-check before DB operation)
                    if (!user.email || typeof user.email !== "string") {
                      throw new Error(
                        "User email is required for toggle update",
                      );
                    }

                    return await service.setToggle(
                      toggleKey,
                      enabled,
                      user.email,
                      toggleKey === "global_public_posting_enabled"
                        ? "Globally enable public posting for all users"
                        : undefined,
                      {
                        userId: session.userId,
                        env,
                        region,
                      },
                    );
                  },
                  {
                    timeoutMs: 1000, // 1 second initial timeout - fail fast
                    retryTimeoutMs: 500, // 0.5 seconds retry timeout - very fast retry
                    maxRetries: 1, // Only 1 retry to keep total time under 2s
                    context: {
                      operation: "updateFeatureToggle",
                      userEmail: user.email,
                      toggleKey: toggleKey,
                    },
                  },
                );
              } catch (error: any) {
                // Re-throw with more context
                throw new Error(
                  `Database operation failed: ${error.message || String(error)}`,
                );
              }
            })();

            // Race the database operation against the top-level timeout
            // This ensures we ALWAYS return a response within 6 seconds
            toggle = await Promise.race([dbOperation, timeoutPromise]);

            // Clear timeout if operation succeeded
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          } catch (dbError: any) {
            // Clear timeout on error
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            logger.error(
              "[SuperAdmin] Database error updating feature toggle:",
              {
                error: dbError.message,
                stack: dbError.stack,
                toggleKey,
                userEmail: user.email,
                isTimeout:
                  dbError.message?.includes("timeout") ||
                  dbError.message?.includes("exceeded"),
              },
            );
            // Return a user-friendly error response instead of letting it bubble up
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error:
                  "Database operation timed out. Please try again in a moment.",
                details:
                  "The database connection is experiencing issues. This usually resolves quickly.",
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          // Add rate limit headers to successful response
          const responseHeaders: Record<string, string> = {
            "content-type": "application/json",
            ...rateLimitResult.headers,
          };

          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              success: true,
              toggle: {
                key: toggle.key,
                enabled: toggle.enabled,
                lastChanged: toggle.lastChanged.toISOString(),
                changedBy: toggle.changedBy,
              },
            }),
            { status: 200, headers: responseHeaders },
          );
          return addCorsHeaders(response, request, env);
        } catch (error) {
          // Handle validation errors
          if (error instanceof ValidationError) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify(error.toResponse()),
              {
                status: error.getStatusCode(),
                headers: { "content-type": "application/json" },
              },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          logger.error("[SuperAdmin] Error updating feature toggle:", error);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Failed to update feature toggle" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
      }

      if (
        pathname === "/api/admin/super-admin/signup-settings" &&
        request.method === "PUT"
      ) {
        try {
          const body = (await request.json()) as { mode?: string };
          const { mode } = body;

          if (
            !mode ||
            !["open", "invitation_only", "disabled"].includes(mode)
          ) {
            const errorResponse = securityHeaders.createSecureResponse(
              JSON.stringify({
                error:
                  'Invalid request: mode must be "open", "invitation_only", or "disabled"',
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
            return addCorsHeaders(errorResponse, request, env);
          }

          const enabled = mode !== "disabled";
          const description = `user_signup_mode:${mode}`;

          const toggle = await toggleService.setToggle(
            "user_signup_mode",
            enabled,
            user.email,
            description,
            {
              userId: session.userId,
              env,
              region: detectRegionSync(request, env),
            },
          );

          const response = securityHeaders.createSecureResponse(
            JSON.stringify({
              success: true,
              signupSettings: {
                mode: mode as "open" | "invitation_only" | "disabled",
                lastChanged: toggle.lastChanged.toISOString(),
                changedBy: toggle.changedBy,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(response, request, env);
        } catch (error) {
          logger.error("[SuperAdmin] Error updating sign-up settings:", error);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Failed to update sign-up settings" }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }
      }

      const errorResponse = securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      return addCorsHeaders(errorResponse, request, env);
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Super-admin routes",
  },

  {
    path: /^\/api\/feature-toggles\/(.+)$/,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const logger = getLogger();

      const securityHeaders = new SecurityHeaders(env);
      const toggleKeyMatch = pathname.match(/^\/api\/feature-toggles\/(.+)$/);
      if (!toggleKeyMatch) {
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ enabled: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      }

      try {
        // Rate limit public API (100 requests/minute per IP)
        const rateLimitResult = await rateLimitFeatureToggleAPI(request, env);

        if (!rateLimitResult || !rateLimitResult.allowed) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: {
                code: "RATE_LIMIT_EXCEEDED",
                message: "Rate limit exceeded. Please try again later.",
                retryAfter: rateLimitResult
                  ? Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
                  : 60,
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                ...(rateLimitResult?.headers || {}),
              },
            },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Validate path parameter (toggle key)
        const toggleKey = validatePathParam(
          FeatureToggleKeySchema,
          toggleKeyMatch[1],
        );

        // Validate query parameters
        const url = new URL(request.url);
        const queryParams: Record<string, string | undefined> = {};
        url.searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
        const validatedQuery = validateQuery(PublicAPIQuerySchema, queryParams);

        const db = createPrisma(env);
        const toggleService = new FeatureToggleService(db);
        const toggle = await toggleService.getToggle(toggleKey);

        if (!toggle) {
          // Add rate limit headers even for not found responses
          const responseHeaders: Record<string, string> = {
            "content-type": "application/json",
            ...rateLimitResult.headers,
          };
          const response = securityHeaders.createSecureResponse(
            JSON.stringify({ key: toggleKey, enabled: false }),
            { status: 200, headers: responseHeaders },
          );
          return addCorsHeaders(response, request, env);
        }

        // Add rate limit headers to successful response
        const responseHeaders: Record<string, string> = {
          "content-type": "application/json",
          ...rateLimitResult.headers,
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            enabled: toggle.enabled,
            key: toggle.key,
            lastChanged: toggle.lastChanged?.toISOString(),
            changedBy: toggle.changedBy,
          }),
          { status: 200, headers: responseHeaders },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error(
          `[Admin] GET handler error: ${error instanceof Error ? error.message : String(error)}`,
          {
            errorType: error?.constructor?.name,
            stack: error instanceof Error ? error.stack : "No stack",
          },
        );

        // Handle validation errors
        if (error instanceof ValidationError) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify(error.toResponse()),
            {
              status: error.getStatusCode(),
              headers: { "content-type": "application/json" },
            },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // For other errors, return 500
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Internal server error",
            message: error instanceof Error ? error.message : "Unknown error",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get feature toggle status",
  },

  {
    path: "/api/roles/metadata",
    method: "GET",
    handler: async (request, env) => {
      const logger = getLogger();

      const securityHeaders = new SecurityHeaders(env);
      try {
        const db = createPrisma(env);
        const roleMetadata = await db.roleMetadata.findMany({
          where: { isActive: true },
          orderBy: { role: "asc" },
        });

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ roles: roleMetadata }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("Error fetching role metadata:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to fetch role metadata" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "Get role metadata",
  },

  // Domain Management Endpoints
  {
    path: "/api/admin/domains",
    method: "GET",
    handler: async (request, env, { url, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse query parameters
        const queryParams = new URL(url).searchParams;
        const limit = Math.min(
          parseInt(queryParams.get("limit") || "50", 10),
          100,
        );
        const cursor = queryParams.get("cursor") || undefined;
        const status = queryParams.get("status") || undefined;
        const domainFilter = queryParams.get("domain") || undefined;
        const sortBy = queryParams.get("sortBy") || "createdAt";
        const sortOrder = queryParams.get("sortOrder") || "desc";

        // Build query
        const where: any = {};
        if (cursor) {
          where.id = { gt: cursor };
        }
        if (status) {
          where.status = status;
        }
        if (domainFilter) {
          where.domain = { contains: domainFilter, mode: "insensitive" };
        }

        // Build orderBy
        const orderBy: any = {};
        if (
          sortBy === "createdAt" ||
          sortBy === "domain" ||
          sortBy === "reputation" ||
          sortBy === "status"
        ) {
          orderBy[sortBy] = sortOrder === "asc" ? "asc" : "desc";
        } else {
          orderBy.createdAt = "desc"; // Default
        }

        // Get domains with pagination
        const domains = await db.domainReputation.findMany({
          where,
          take: limit + 1,
          orderBy,
        });

        const hasMore = domains.length > limit;
        const result = hasMore ? domains.slice(0, limit) : domains;
        const nextCursor = hasMore ? result[result.length - 1].id : undefined;

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            domains: result.map((d) => ({
              id: d.id,
              domain: d.domain,
              reputation: d.reputation,
              status: d.status,
              lastChecked: d.lastChecked.toISOString(),
              createdAt: d.createdAt.toISOString(),
              updatedAt: d.updatedAt.toISOString(),
            })),
            hasMore,
            nextCursor,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error fetching domains:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to fetch domains" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "List domains with reputation",
  },

  {
    path: /^\/api\/admin\/domains\/([^/]+)\/block$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Extract domain from path
        const match = pathname.match(/^\/api\/admin\/domains\/([^/]+)\/block$/);
        if (!match) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid URL format" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const domain = decodeURIComponent(match[1]);

        // Block domain
        const reputationService = new DomainReputationService(env);
        await reputationService.blockDomain(domain, region, env);

        logger.info(
          `[Admin] Domain blocked: ${domain} by user ${session.userId}`,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            message: `Domain ${domain} has been blocked`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error blocking domain:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to block domain" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Block a domain",
  },

  {
    path: /^\/api\/admin\/domains\/([^/]+)\/unblock$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Extract domain from path
        const match = pathname.match(
          /^\/api\/admin\/domains\/([^/]+)\/unblock$/,
        );
        if (!match) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid URL format" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const domain = decodeURIComponent(match[1]);

        // Unblock domain
        const reputationService = new DomainReputationService(env);
        await reputationService.unblockDomain(domain, region, env);

        logger.info(
          `[Admin] Domain unblocked: ${domain} by user ${session.userId}`,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            message: `Domain ${domain} has been unblocked`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error unblocking domain:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to unblock domain" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Unblock a domain",
  },

  {
    path: "/api/admin/reports",
    method: "GET",
    handler: async (request, env, { url, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse query parameters
        const queryParams = new URL(url).searchParams;
        const limit = Math.min(
          parseInt(queryParams.get("limit") || "50", 10),
          100,
        );
        const cursor = queryParams.get("cursor") || undefined;
        const status = queryParams.get("status") || undefined;
        const domain = queryParams.get("domain") || undefined;
        const sortBy = queryParams.get("sortBy") || "createdAt";
        const sortOrder = queryParams.get("sortOrder") || "desc";

        // Build query (P4: link reports now live in the generalized Report
        // model — scope to reportType LINK so account reports never leak here).
        const where: any = { reportType: "LINK" };
        if (cursor) {
          where.id = { gt: cursor };
        }
        if (status) {
          where.status = status;
        }
        if (domain) {
          where.domain = { contains: domain, mode: "insensitive" };
        }

        // Build orderBy
        const orderBy: any = {};
        if (
          sortBy === "createdAt" ||
          sortBy === "domain" ||
          sortBy === "status"
        ) {
          orderBy[sortBy] = sortOrder === "asc" ? "asc" : "desc";
        } else {
          orderBy.createdAt = "desc"; // Default
        }

        // Get reports with pagination
        const reports = await db.report.findMany({
          where,
          take: limit + 1,
          orderBy,
          include: {
            reporter: {
              select: {
                id: true,
                email: true,
              },
            },
          },
        });

        const hasMore = reports.length > limit;
        const result = hasMore ? reports.slice(0, limit) : reports;
        const nextCursor = hasMore ? result[result.length - 1].id : undefined;

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            // Response shape preserved (P4): resourceId is the reported url.
            reports: result.map((r) => ({
              id: r.id,
              userId: r.reporterUserId,
              userEmail: r.reporter.email,
              linkUrl: r.resourceId,
              domain: r.domain,
              reason: r.reason,
              status: r.status,
              createdAt: r.createdAt.toISOString(),
            })),
            hasMore,
            nextCursor,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error fetching reports:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to fetch reports" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware()],
    description: "List link reports",
  },

  {
    path: /^\/api\/admin\/reports\/([^/]+)\/review$/,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Extract reportId from path
        const match = pathname.match(
          /^\/api\/admin\/reports\/([^/]+)\/review$/,
        );
        if (!match) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid URL format" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const reportId = match[1];

        // Parse request body
        const body = (await request.json().catch(() => ({}))) as {
          action: "approve" | "reject" | "dismiss";
          notes?: string;
        };

        if (
          !body.action ||
          !["approve", "reject", "dismiss"].includes(body.action)
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid action. Must be approve, reject, or dismiss",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get report (P4: Report model, scoped to LINK so only link reports
        // are reviewable via this moderator route).
        const report = await db.report.findFirst({
          where: { id: reportId, reportType: "LINK" },
        });

        if (!report) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Report not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Update report status
        let newStatus: string;
        if (body.action === "approve") {
          newStatus = "approved";
          // If approved, update domain reputation (negative signal). domain is
          // nullable on Report; LINK reports always carry it, but guard anyway.
          if (report.domain) {
            const reputationService = new DomainReputationService(env);
            await reputationService.updateReputation(
              report.domain,
              "user_report",
              region,
              env,
            );
          }
        } else if (body.action === "reject") {
          newStatus = "rejected";
        } else {
          newStatus = "dismissed";
        }

        const updatedReport = await db.report.update({
          where: { id: reportId },
          data: {
            status: newStatus,
          },
        });

        logger.info(
          `[Admin] Report ${reportId} reviewed: ${body.action} by user ${session.userId}`,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            report: {
              id: updatedReport.id,
              status: updatedReport.status,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error reviewing report:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to review report" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Review a link report",
  },

  {
    path: "/api/admin/domains/bulk",
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();

      // Check authentication and authorization
      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env as any,
      );

      if (!session) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      // Check if user is admin
      const region = requestContext?.region || env.DEFAULT_REGION || "EU";
      const db = DataRouter.getDatabaseForRegion(region, env);
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });

      if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "INTERNAL")) {
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Forbidden: Admin access required" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }

      try {
        // Parse request body
        const body = (await request.json()) as {
          action: "block" | "unblock" | "allowlist";
          domains: string[];
        };

        if (
          !body.action ||
          !["block", "unblock", "allowlist"].includes(body.action)
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Invalid action. Must be block, unblock, or allowlist",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        if (!Array.isArray(body.domains) || body.domains.length === 0) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "domains must be a non-empty array" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Limit bulk operations to prevent abuse
        if (body.domains.length > 100) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Maximum 100 domains per bulk operation" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        const reputationService = new DomainReputationService(env);
        const results: Array<{
          domain: string;
          success: boolean;
          error?: string;
        }> = [];

        // Process each domain
        for (const domain of body.domains) {
          try {
            if (body.action === "block") {
              await reputationService.blockDomain(domain, region, env);
            } else if (body.action === "unblock") {
              await reputationService.unblockDomain(domain, region, env);
            } else {
              await reputationService.addToAllowlist(domain, region, env);
            }
            results.push({ domain, success: true });
          } catch (error: any) {
            logger.warn(
              `[Admin] Failed to ${body.action} domain ${domain}:`,
              error,
            );
            results.push({
              domain,
              success: false,
              error: error.message || "Unknown error",
            });
          }
        }

        const successCount = results.filter((r) => r.success).length;
        logger.info(
          `[Admin] Bulk ${body.action} operation: ${successCount}/${body.domains.length} successful`,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify({
            success: true,
            action: body.action,
            total: body.domains.length,
            successful: successCount,
            failed: body.domains.length - successCount,
            results,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(response, request, env);
      } catch (error: any) {
        logger.error("[Admin] Error performing bulk operation:", error);
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Failed to perform bulk operation" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Bulk domain operations (block/unblock/allowlist)",
  },
];
