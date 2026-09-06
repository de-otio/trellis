/**
 * Data Router Module
 *
 * Routes data operations to region-specific databases and enforces data residency.
 *
 * Security: All operations validate region and enforce strict region boundaries.
 *
 * Performance: Uses cached database connections (via createPrismaForRegion).
 */

import type { Prisma, SyntheticSourceType, UserRole } from "@prisma/client";
import { createPrismaForRegion, type EnvWithDb } from "../db.js";
import {
  TrellisAuditLogger,
  type TrellisAuditLoggerEnv,
} from "./audit-composer.js";
import type { DatabaseWrapperEnv } from "./database-wrapper.js";
import { getWrappedDatabase } from "./database-wrapper-helper.js";
import { emitDomainEvent } from "./events/emit.js";
import { getIPAddress } from "./ip-scrubber.js";
import { getLogger, Logger } from "./logger.js";
import { mintTenantId } from "./mint-tenant-id.js";
import { deriveUniqueHandle } from "./user/derive-handle.js";
import { isValidRegion, type Region } from "./region-detection.js";

/**
 * Thrown when a request would read `dataRegion` data from a different
 * `requestedRegion` without recorded cross-region consent. Carries the two
 * regions and a stable `code` so callers (and tests) can branch on it without
 * string-matching the message.
 */
export class CrossRegionAccessError extends Error {
  readonly code = "CROSS_REGION_ACCESS_REQUIRES_CONSENT" as const;
  constructor(
    public readonly dataRegion: string,
    public readonly requestedRegion: string,
  ) {
    super(
      `CROSS_REGION_ACCESS_REQUIRES_CONSENT: Cannot access ${dataRegion} data from ${requestedRegion} region`,
    );
    this.name = "CrossRegionAccessError";
  }
}

/**
 * Environment interface for data router
 */
export interface DataRouterEnv extends EnvWithDb, TrellisAuditLoggerEnv {
  // Region detection
  DEFAULT_REGION?: string;
  // Optional: Database wrapper environment (for monitoring)
  LOG_LEVEL?: string;
  // CI detection (populated from process.env by buildEnv() in env.ts) — used
  // to relax timeouts for slower CI database connections.
  CI?: string;
  GITHUB_ACTIONS?: string;
}

/**
 * Input for creating a user
 */
export interface CreateUserInput {
  id: string;
  email: string;
  role?: UserRole;
  username?: string;
  [key: string]: unknown;
}

/**
 * Data Router class for region-aware data operations
 *
 * Security: All operations validate region and enforce dataRegion matching.
 *
 * Audit: All operations are logged for compliance and security monitoring.
 */
export class DataRouter {
  private static auditLogger?: TrellisAuditLogger;

  /**
   * Get or create audit logger instance
   */
  private static getAuditLogger(
    env: DataRouterEnv,
    requestId?: string,
  ): TrellisAuditLogger {
    if (!this.auditLogger) {
      this.auditLogger = new TrellisAuditLogger(env);
    }
    if (requestId) {
      return this.auditLogger.withRequestId(requestId);
    }
    return this.auditLogger;
  }
  /**
   * Validate region access for data operations
   *
   * Security: Ensures dataRegion matches requested region to prevent cross-region data access.
   *
   * @param dataRegion - Region where data is stored (from database)
   * @param requestedRegion - Region where request originated
   * @param userId - Optional user ID for audit logging
   * @param env - Environment variables
   * @param request - Optional request object for audit logging
   * @param requestId - Optional request ID for audit log correlation
   * @throws Error if dataRegion doesn't match requested region
   */
  /**
   * Check if user has consented to cross-region access
   */
  static async checkCrossRegionConsent(
    userId: string,
    dataRegion: string,
    accessRegion: Region,
    env: DataRouterEnv,
  ): Promise<boolean> {
    try {
      const db = this.getDatabaseForRegion(accessRegion, env);
      // Consent history is append-only: the CURRENT cross-region decision is
      // the single `active` row for this (user, dataRegion, accessRegion).
      // (The raw partial unique index `consent_cross_region_key` guarantees at
      // most one active CROSS_REGION row per triple.)
      const consent = await db.consent.findFirst({
        where: {
          userId,
          purpose: "CROSS_REGION",
          dataRegion,
          accessRegion,
          active: true,
        },
      });

      return consent?.consented === true && consent.withdrawnAt === null;
    } catch (error) {
      getLogger().warn(
        "[DataRouter] Error checking cross-region consent:",
        error,
      );
      return false;
    }
  }

  static validateRegionAccess(
    dataRegion: string | null | undefined,
    requestedRegion: Region,
    userId: string | undefined,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
  ): void {
    if (!dataRegion) {
      // Log missing dataRegion as security issue
      try {
        const auditLogger = this.getAuditLogger(env, requestId);
        auditLogger
          .log(
            {
              type: "authorization",
              action: "DATA_REGION_MISSING",
              resource: "unknown",
              userId,
              region: requestedRegion,
              ipAddress: request ? getIPAddress(request) : undefined,
              userAgent: request?.headers.get("User-Agent") || undefined,
              severity: "high",
              success: false,
              metadata: {
                requestedRegion,
                error: "dataRegion not set",
              },
            },
            env,
          )
          .catch((err) => {
            getLogger().warn(
              "[DataRouter] Audit logging failed:",
              err,
            );
          });
      } catch (auditError) {
        getLogger().warn(
          "[DataRouter] Audit logging failed for missing dataRegion:",
          auditError,
        );
      }

      throw new Error("Data residency violation: dataRegion not set");
    }

    if (dataRegion !== requestedRegion) {
      // Log security violation
      try {
        const auditLogger = this.getAuditLogger(env, requestId);
        auditLogger
          .log(
            {
              type: "authorization",
              action: "CROSS_REGION_DATA_ACCESS_BLOCKED",
              resource: "unknown",
              userId,
              region: requestedRegion,
              dataRegion,
              ipAddress: request ? getIPAddress(request) : undefined,
              userAgent: request?.headers.get("User-Agent") || undefined,
              severity: "high",
              success: false,
              metadata: {
                requestedRegion,
                actualDataRegion: dataRegion,
                requiresConsent: true,
              },
            },
            env,
          )
          .catch((err) => {
            getLogger().warn(
              "[DataRouter] Audit logging failed:",
              err,
            );
          });
      } catch (auditError) {
        getLogger().warn(
          "[DataRouter] Audit logging failed for cross-region access:",
          auditError,
        );
      }

      // Throw error with specific code that frontend can detect
      throw new CrossRegionAccessError(dataRegion, requestedRegion);
    }
  }

  /**
   * Validate region access with consent check (async version)
   * Use this when you need to check for existing consent
   */
  static async validateRegionAccessWithConsent(
    dataRegion: string | null | undefined,
    requestedRegion: Region,
    userId: string | undefined,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
  ): Promise<void> {
    if (!dataRegion) {
      throw new Error("Data residency violation: dataRegion not set");
    }

    if (dataRegion !== requestedRegion) {
      // Check for existing consent
      if (userId) {
        const hasConsent = await this.checkCrossRegionConsent(
          userId,
          dataRegion,
          requestedRegion,
          env,
        );
        if (hasConsent) {
          // Log consent-based access
          try {
            const auditLogger = this.getAuditLogger(env, requestId);
            auditLogger
              .log(
                {
                  type: "authorization",
                  action: "CROSS_REGION_DATA_ACCESS_ALLOWED_WITH_CONSENT",
                  resource: "unknown",
                  userId,
                  region: requestedRegion,
                  dataRegion,
                  ipAddress: request ? getIPAddress(request) : undefined,
                  userAgent: request?.headers.get("User-Agent") || undefined,
                  severity: "medium",
                  success: true,
                  metadata: {
                    requestedRegion,
                    actualDataRegion: dataRegion,
                    consentBased: true,
                  },
                },
                env,
              )
              .catch((err) => {
                getLogger().warn(
                  "[DataRouter] Audit logging failed:",
                  err,
                );
              });
          } catch (auditError) {
            getLogger().warn(
              "[DataRouter] Audit logging failed:",
              auditError,
            );
          }
          return; // Access allowed with consent
        }
      }

      // No consent, throw error
      this.validateRegionAccess(
        dataRegion,
        requestedRegion,
        userId,
        env,
        request,
        requestId,
      );
    }
  }

  /**
   * Get database client for a specific region
   *
   * Performance: Uses createPrismaForRegion for database connection pooling and caching.
   *
   * If request and userId are provided, returns a wrapped client with monitoring and rate limiting.
   * Otherwise, returns an unwrapped client (for backward compatibility).
   *
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object (if provided, enables monitoring and rate limiting)
   * @param userId - Optional user ID (if provided, enables per-user rate limiting)
   * @returns Prisma client for the region
   * @throws Error if region is invalid
   */
  static getDatabaseForRegion(
    region: string,
    env: DataRouterEnv,
    request?: Request,
    userId?: string,
  ): ReturnType<typeof createPrismaForRegion> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // If request is provided, return wrapped client with monitoring
    if (request) {
      return getWrappedDatabase(
        region,
        env as DatabaseWrapperEnv,
        request,
        userId,
      ) as ReturnType<typeof createPrismaForRegion>;
    }

    // Otherwise, return unwrapped client (backward compatibility)
    // Get region-specific database connection
    // Uses existing createPrismaForRegion which handles connection string selection
    return createPrismaForRegion(region, env);
  }

  /**
   * Create a user in the region-specific database
   *
   * Security: Enforces region validation and dataRegion matching.
   *
   * Audit: Logs user creation for compliance.
   *
   * @param userData - User data to create
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object for audit logging (IP, user agent)
   * @param requestId - Optional request ID for audit log correlation
   * @returns Created user
   * @throws Error if region is invalid or dataRegion mismatch
   */
  static async createUser(
    userData: CreateUserInput,
    region: string,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
  ): Promise<{
    id: string;
    email: string;
    region: string;
    dataRegion: string | null;
    [key: string]: unknown;
  }> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // OPTIMIZATION: For test users, use executeWithRetry with appropriate timeout
    // In CI, database connections can be slower, so we use slightly longer timeouts
    const isTestUser =
      userData.email?.includes("@test.example.com") ||
      userData.email?.includes("test-");

    // Detect CI environment for timeout adjustment
    const isCI = env.CI === "true" || env.GITHUB_ACTIONS === "true";

    // OPTIMIZATION: For test users, use aggressive timeouts since they should be fast
    // Test users are created frequently in tests and should complete quickly
    // In CI, database connections can take longer due to network latency
    // CRITICAL FIX: Increased timeouts based on Cloudflare logs analysis
    // Logs showed 108 query timeouts - 500-800ms is too aggressive
    // Queries are taking 800ms+ under load, causing premature timeouts
    // Use 3s timeout for test users in CI (allows for database connection + query + retry)
    // Use 2s timeout locally (gives queries enough time to complete)
    const testUserTimeoutMs = isCI ? 3000 : 2000;
    const testUserRetryTimeoutMs = isCI ? 1000 : 500;
    // Allow 1 retry in CI for transient connection issues, no retries locally for speed
    const testUserMaxRetries = isCI ? 1 : 0;

    // Use executeWithRetry for proper timeout protection (connection + query)
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const logger = getLogger();
    const dbWriteStartTime = Date.now();
    const user = await sharedDatabaseConnectionManager.executeWithRetry(
      region,
      env,
      async (db) => {
        // S-CP2: handle is non-null + unique. Derive one unless the caller
        // supplied it, so this provisioning path upholds the invariant too.
        const handle =
          (typeof userData.handle === "string" && userData.handle) ||
          (await deriveUniqueHandle(db, userData.email, userData.id));
        // OPTIMIZATION: For test users, try create first (faster than upsert)
        // If user already exists, fall back to upsert
        // This optimizes the common case where test users are new
        if (isTestUser) {
          try {
            return await db.user.create({
              data: {
                ...userData,
                handle,
                region,
                dataRegion: region, // CRITICAL: Must match region
              },
            });
          } catch (createError: any) {
            // If user already exists (unique constraint violation), use upsert
            // This handles cross-region test scenarios where user might exist in different region
            if (
              createError.code === "P2002" ||
              createError.message?.includes("Unique constraint")
            ) {
              logger.debug(
                "[DataRouter] Test user already exists, using upsert",
                { userId: userData.id },
              );
              // Fall through to upsert
            } else {
              // Re-throw other errors
              throw createError;
            }
          }
        }

        // Use upsert for production users or when test user already exists
        // This prevents unique constraint violations when user ID is globally unique
        // CRITICAL: Set region and dataRegion to match
        // dataRegion must match region for compliance
        return await db.user.upsert({
          where: { id: userData.id },
          create: {
            ...userData,
            handle,
            region,
            dataRegion: region, // CRITICAL: Must match region
          },
          update: {
            // Update email if provided and different
            email: userData.email,
            // For test users, allow region/dataRegion update to handle cross-region test scenarios
            // For production users, preserve their region (compliance requirement)
            ...(isTestUser
              ? {
                  region,
                  dataRegion: region, // Update to match requested region for test users
                }
              : {
                  // Don't update region/dataRegion on existing users (preserve their region)
                }),
          },
        });
      },
      {
        timeoutMs: isTestUser ? testUserTimeoutMs : 3000, // 2s in CI / 1s locally for test users, 3s for real users
        retryTimeoutMs: isTestUser ? testUserRetryTimeoutMs : 1000, // 1s in CI / 0.5s locally for test users, 1s for real users
        maxRetries: isTestUser ? testUserMaxRetries : 1, // 1 retry in CI / 0 retries locally for test users, 1 retry for real users
        context: {
          operation: "createUser",
          userId: userData.id,
          isTestUser,
          isCI,
        },
      },
    );
    const dbWriteDuration = Date.now() - dbWriteStartTime;
    logger.debug("[UserCreation] Database write completed", {
      duration: dbWriteDuration,
      userId: user.id,
      region,
      isTestUser,
    });

    // CRITICAL: Verify dataRegion was set correctly
    if (user.dataRegion !== region) {
      throw new Error(
        `Data region mismatch: expected ${region}, got ${user.dataRegion}`,
      );
    }

    // Audit log: User creation (don't fail operation if audit logging fails)
    // Use fire-and-forget for test user creation to avoid blocking on slow audit logging
    // Note: isTestUser is already determined above for database optimization
    if (!isTestUser) {
      try {
        const auditLogger = this.getAuditLogger(env, requestId);
        // Fire and forget - don't await to avoid blocking user creation
        auditLogger
          .logUserAction(
            {
              action: "user_created",
              resource: "user",
              resourceId: user.id,
              userId: user.id, // User creating themselves
              region: region as Region,
              dataRegion: user.dataRegion || region,
              ipAddress: request ? getIPAddress(request) : undefined,
              userAgent: request?.headers.get("User-Agent") || undefined,
              success: true,
            },
            env,
          )
          .catch((auditError) => {
            // Don't fail the operation if audit logging fails
            // Error is already logged by AuditLogger
            getLogger().warn(
              "[DataRouter] Audit logging failed for user creation:",
              auditError,
            );
          });
      } catch (auditError) {
        // Don't fail the operation if audit logging fails
        getLogger().warn(
          "[DataRouter] Audit logging setup failed for user creation:",
          auditError,
        );
      }
    }

    return user;
  }

  /**
   * Get a user from the region-specific database
   *
   * Security: Validates region and verifies dataRegion matches requested region.
   *
   * Audit: Logs data access for compliance.
   *
   * @param userId - User ID
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object for audit logging (IP, user agent)
   * @param requestId - Optional request ID for audit log correlation
   * @param requestingUserId - Optional ID of user making the request (for audit)
   * @returns User or null if not found
   * @throws Error if region is invalid or dataRegion mismatch detected
   */
  static async getUser(
    userId: string,
    region: string,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
    requestingUserId?: string,
  ): Promise<{
    id: string;
    email: string;
    region: string;
    dataRegion: string | null;
    [key: string]: unknown;
  } | null> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // Get region-specific database (with monitoring/rate limiting if request provided)
    const db = this.getDatabaseForRegion(region, env, request, userId);

    // Find user in region-specific database
    const user = await db.user.findUnique({
      where: { id: userId },
    });

    // CRITICAL: Verify dataRegion matches requested region
    // This is defense in depth - routing should prevent this, but we check anyway
    if (user && user.dataRegion && user.dataRegion !== region) {
      // Log security violation and return null (don't expose cross-region data)
      try {
        const auditLogger = this.getAuditLogger(env, requestId);
        await auditLogger.log(
          {
            type: "authorization",
            action: "CROSS_REGION_DATA_ACCESS_BLOCKED",
            resource: "user",
            resourceId: userId,
            userId: requestingUserId,
            region: region as Region,
            dataRegion: user.dataRegion,
            ipAddress: request ? getIPAddress(request) : undefined,
            userAgent: request?.headers.get("User-Agent") || undefined,
            severity: "high",
            success: false,
            metadata: {
              requestedRegion: region,
              actualDataRegion: user.dataRegion,
            },
          },
          env,
        );
      } catch (auditError) {
        getLogger().warn(
          "[DataRouter] Audit logging failed for cross-region access:",
          auditError,
        );
      }

      // Return null instead of throwing (don't expose cross-region data)
      return null;
    }

    // Audit log: Data access (don't fail operation if audit logging fails)
    try {
      const auditLogger = this.getAuditLogger(env, requestId);
      await auditLogger.logDataAccess(
        {
          action: "user_accessed",
          resource: "user",
          resourceId: userId,
          userId: requestingUserId,
          region: region as Region,
          dataRegion: user?.dataRegion || region,
          ipAddress: request ? getIPAddress(request) : undefined,
          userAgent: request?.headers.get("User-Agent") || undefined,
          success: user !== null,
        },
        env,
      );
    } catch (auditError) {
      // Don't fail the operation if audit logging fails
      getLogger().warn(
        "[DataRouter] Audit logging failed for user access:",
        auditError,
      );
    }

    return user;
  }

  /**
   * Update a user in the region-specific database
   *
   * Security: Validates region and ensures dataRegion cannot be changed.
   *
   * Audit: Logs user update for compliance.
   *
   * @param userId - User ID
   * @param updateData - Data to update
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object for audit logging (IP, user agent)
   * @param requestId - Optional request ID for audit log correlation
   * @param requestingUserId - Optional ID of user making the request (for audit)
   * @returns Updated user
   * @throws Error if region is invalid or dataRegion mismatch
   */
  static async updateUser(
    userId: string,
    updateData: Partial<CreateUserInput>,
    region: string,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
    requestingUserId?: string,
  ): Promise<{
    id: string;
    email: string;
    region: string;
    dataRegion: string | null;
    [key: string]: unknown;
  }> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // CRITICAL: Prevent dataRegion from being changed
    // dataRegion is immutable - it tracks where data is stored for compliance
    if ("dataRegion" in updateData) {
      throw new Error(
        "dataRegion cannot be changed - it is immutable for compliance",
      );
    }

    // Get region-specific database (with monitoring/rate limiting if request provided)
    const db = this.getDatabaseForRegion(region, env, request, userId);

    // Update user
    const user = await db.user.update({
      where: { id: userId },
      data: updateData,
    });

    // CRITICAL: Verify dataRegion still matches region using validation middleware
    this.validateRegionAccess(
      user.dataRegion,
      region as Region,
      requestingUserId || userId,
      env,
      request,
      requestId,
    );

    // Audit log: User update (don't fail operation if audit logging fails)
    try {
      const auditLogger = this.getAuditLogger(env, requestId);
      await auditLogger.logUserAction(
        {
          action: "user_updated",
          resource: "user",
          resourceId: userId,
          userId: requestingUserId || userId,
          region: region as Region,
          dataRegion: user.dataRegion || region,
          ipAddress: request ? getIPAddress(request) : undefined,
          userAgent: request?.headers.get("User-Agent") || undefined,
          metadata: {
            updatedFields: Object.keys(updateData),
          },
          success: true,
        },
        env,
      );
    } catch (auditError) {
      // Don't fail the operation if audit logging fails
      getLogger().warn(
        "[DataRouter] Audit logging failed for user update:",
        auditError,
      );
    }

    return user;
  }

  /**
   * Create a post in the region-specific database
   *
   * Security: Enforces region validation and dataRegion matching.
   *
   * Audit: Logs post creation for compliance.
   *
   * @param postData - Post data to create
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object for audit logging (IP, user agent)
   * @param requestId - Optional request ID for audit log correlation
   * @returns Created post
   * @throws Error if region is invalid
   */
  static async createPost(
    postData: {
      authorId: string;
      text: string;
      radius?: string; // PostRadius: WHISPER | NORMAL | LOUD | SHOUT (schema default NORMAL). NOT a visibility column.
      tenantId: string; // Tenancy: active tenant the post belongs to (NON-NULL in schema)
      entityRefs?: string[];
      geoData?: unknown;
      // Media attachments. `sourceType` is the author's Art. 50 provenance
      // declaration for THAT attachment; it lands on the PostMedia join row, not
      // on the shared MediaFile (which is deduped within-tenant).
      media?: Array<{
        id: string;
        alt?: string;
        sourceType?: SyntheticSourceType;
      }>;
      [key: string]: unknown;
    },
    region: string,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
    session?: { userId: string; email: string }, // For entity tagging validation
  ): Promise<{
    id: string;
    authorId: string;
    dataRegion: string | null;
    [key: string]: unknown;
  }> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // Get region-specific database (with monitoring/rate limiting if request provided)
    // For transactions, we need the unwrapped Prisma client to avoid Symbol serialization issues
    // Prisma's transaction timeout mechanism tries to serialize the callback, and Proxies contain Symbols
    const wrappedDb = this.getDatabaseForRegion(
      region,
      env,
      request,
      postData.authorId,
    );
    // Get unwrapped Prisma client for transactions to avoid Proxy Symbol serialization
    const { getUnwrappedDatabase } = await import("./database-wrapper-helper.js");
    const db = request ? getUnwrappedDatabase(region, env) : wrappedDb;

    // Extract entityRefs (will be handled separately in transaction)
    const entityRefs = postData.entityRefs || [];

    // Extract media (will be handled separately in transaction)
    const media = postData.media || [];

    // Sanitize data to ensure only serializable values are passed to Prisma
    // This prevents Symbol serialization errors
    // Only include known, safe fields that Prisma expects
    const sanitizedPostData: Record<string, any> = {
      authorId: String(postData.authorId),
      text: String(postData.text),
    };

    // Posting radius (how far content radiates on the social graph). Optional:
    // when omitted, the create is left to the schema default (NORMAL). Only a
    // provided value enters the allowlist, as a plain string.
    if (postData.radius !== undefined && postData.radius !== null) {
      sanitizedPostData.radius = String(postData.radius);
    }

    // Art. 50 provenance of the post TEXT. Enters the allowlist as a plain
    // string, like radius. When omitted the column takes its schema default
    // (UNKNOWN) — which is NOT "human-created".
    if (
      postData.textSourceType !== undefined &&
      postData.textSourceType !== null
    ) {
      sanitizedPostData.textSourceType = String(postData.textSourceType);
    }

    // Only include optional fields if they exist and are serializable
    if (postData.geoData !== undefined && postData.geoData !== null) {
      try {
        // Ensure geoData is serializable (JSON round-trip test)
        const serialized = JSON.parse(JSON.stringify(postData.geoData));
        sanitizedPostData.geoData = serialized;
      } catch (e) {
        getLogger().warn(
          "[DataRouter] geoData is not serializable, skipping:",
          e,
        );
      }
    }

    if (
      postData.contentWarnings !== undefined &&
      Array.isArray(postData.contentWarnings)
    ) {
      // Ensure all array items are strings
      sanitizedPostData.contentWarnings = postData.contentWarnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => String(item));
    }

    // Feed-declutter denormalization: resolve the authoring tenant's root
    // PlatformCategory code (if it has declared a classification) and stamp it
    // onto the post so circle/glance feeds can filter by org category without a
    // join on the hot path. Resolved HERE — outside the transaction, at the
    // point tenantId is known — so only a plain string ever enters the
    // allowlist below (never a Prisma proxy that would trip the transaction
    // callback's Symbol serialization). Best-effort: this denormalized filter
    // column is non-essential, so a lookup failure must never block the post
    // write — mirror the audit-log "don't fail the operation" policy and leave
    // the column null (it can be backfilled) rather than throwing.
    try {
      const classification = await db.tenantClassification.findUnique({
        where: { tenantId: String(postData.tenantId) },
        select: { categoryId: true },
      });
      if (classification?.categoryId) {
        const categories = await db.platformCategory.findMany({
          select: { id: true, code: true, parentCategoryId: true },
        });
        const { resolveRootCategoryCode } = await import(
          "./org-category/tree.js"
        );
        const rootCode = resolveRootCategoryCode(
          classification.categoryId,
          categories,
        );
        if (rootCode !== null) {
          // Add to the allowlist as a plain string (same pattern as geoData /
          // contentWarnings above) — createData copies it below.
          sanitizedPostData.authorOrgRootCategoryCode = String(rootCode);
        }
      }
    } catch (orgCodeError) {
      getLogger().warn(
        "[DataRouter] Failed to resolve authorOrgRootCategoryCode (non-fatal, leaving null):",
        orgCodeError,
      );
    }

    // Brand the authoring tenant for the outbox write below. Minted HERE,
    // outside the transaction callback, for the same reason the org-category
    // lookup above is: only plain values may cross into the callback, and
    // minting is the one place an invalid tenant id is rejected — better to
    // fail before opening a transaction than to abort one.
    const eventTenantId = mintTenantId(String(postData.tenantId), "session");

    // Use transaction to ensure atomicity
    const result = await db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Validate entity tagging permissions within transaction (if entities provided and session available)
        if (entityRefs.length > 0 && session) {
          const { validateEntityTagging } = await import(
            "./entity-tagging-validator.js"
          );

          // Validate using transaction client to ensure consistency.
          // String() the userId to avoid Symbol serialization issues when
          // Prisma serializes the transaction callback.
          await validateEntityTagging(
            String(session.userId),
            entityRefs,
            tx,
            // The post's tenant — the same value stamped onto the row below.
            // The friendship half of the tagging check is tenant-scoped
            // (lib/friend-ids.ts), so it must be resolved in this tenant.
            String(postData.tenantId),
          );
        }

        // CRITICAL: Set dataRegion to match region
        // Explicitly construct data object to avoid Symbol serialization issues
        const createData: Prisma.PostUncheckedCreateInput = {
          authorId: sanitizedPostData.authorId,
          text: sanitizedPostData.text,
          tenantId: String(postData.tenantId), // Tenancy: stamp active tenant (NON-NULL)
          dataRegion: region, // CRITICAL: Must match region
        };

        // Posting radius — only set when provided; otherwise the column takes
        // its schema default (NORMAL). There is no `visibility` column.
        if (sanitizedPostData.radius !== undefined) {
          createData.radius = sanitizedPostData.radius;
        }

        // Only add optional fields if they exist
        if (sanitizedPostData.geoData !== undefined) {
          createData.geoData = sanitizedPostData.geoData;
        }
        if (sanitizedPostData.contentWarnings !== undefined) {
          createData.contentWarnings = sanitizedPostData.contentWarnings;
        }
        // Feed-declutter denorm column — added via the same known-safe-field
        // allowlist as geoData/contentWarnings (never by spreading postData), so
        // no Prisma proxy/Symbol can enter the transaction callback's data.
        if (sanitizedPostData.authorOrgRootCategoryCode !== undefined) {
          createData.authorOrgRootCategoryCode =
            sanitizedPostData.authorOrgRootCategoryCode;
        }
        // Art. 50 text provenance — same known-safe-field allowlist. `basis` is
        // minted here, server-side; the client may declare WHAT, never HOW WE
        // KNOW (see createPostSchema.provenance).
        if (sanitizedPostData.textSourceType !== undefined) {
          createData.textSourceType = sanitizedPostData.textSourceType;
          createData.textBasis = "AUTHOR_DECLARED";
        }

        const post = await tx.post.create({
          data: createData,
        });

        // CRITICAL: Verify dataRegion was set correctly
        if (post.dataRegion !== region) {
          throw new Error(
            `Data region mismatch: expected ${region}, got ${post.dataRegion}`,
          );
        }

        // Domain event, IN THIS TRANSACTION (plan 034 lane E). Emitted HERE
        // — straight after the post row exists and before the tagging and
        // media writes below — rather than at the end of the callback, so
        // that a failure in any of them aborts the event with the post. An
        // outbox row for a post that does not exist is worse than no row, so
        // unlike the audit log further down this is NOT best-effort: it
        // throws, and the throw is the point.
        //
        // Payload is ids and changed field names only: `fields` lists the
        // columns this create set, never their values, so the post's text
        // never reaches the outbox.
        await emitDomainEvent(tx, {
          type: "post.published",
          tenantId: eventTenantId,
          subjectKind: "post",
          subjectId: post.id,
          payload: {
            postId: post.id,
            authorId: String(sanitizedPostData.authorId),
            fields: Object.keys(createData).sort(),
            entityIds: entityRefs.map((id) => String(id)),
            mediaIds: media.map((m) => String(m.id)),
          },
        });

        // Create PostEntity records if entities are tagged
        //
        // PRE-EXISTING BUG, found while removing `tx: any` for this cast-cleanup
        // pass (not fixed here — that would be a behavior change, out of scope):
        // there is no `postEntity` model. The schema's post/entity join table is
        // `PostSubject` (`postId`/`entityId` columns, `@@map("post_subjects")`) —
        // `tx.postEntity` is `undefined` on a real Prisma client, so this throws
        // inside the transaction for every post created with tagged entities.
        // The unit test mocking this call (`data-router.test.ts`) also mocks a
        // `postEntity` delegate, which is why it doesn't catch this. Load-bearing
        // `as any` kept here ONLY to preserve exact current (broken) behavior
        // pending a dedicated fix.
        if (entityRefs.length > 0) {
          await (tx as any).postEntity.createMany({
            data: entityRefs.map((entityId) => ({
              postId: post.id,
              entityId,
            })),
            skipDuplicates: true, // Handle race conditions
          });
        }

        // Create PostMedia records if media are attached
        if (media.length > 0) {
          await tx.postMedia.createMany({
            data: media.map((m, index) => ({
              // PostMedia inherits the owning post's tenant.
              tenantId: post.tenantId,
              postId: post.id,
              mediaId: m.id,
              alt: m.alt || "",
              order: index,
              // Art. 50: the author's declaration for THIS attachment. `basis`
              // is minted here, server-side — never accepted from the client
              // (see createPostSchema.provenance). Omitted declaration stays at
              // the schema default UNKNOWN, which is NOT "human".
              ...(m.sourceType
                ? {
                    declaredSourceType: m.sourceType,
                    declaredBasis: "AUTHOR_DECLARED",
                  }
                : {}),
            })),
            skipDuplicates: true, // Handle race conditions
          });

          // Mark these files as attached, clearing any stale orphan flag.
          // This is the authoritative source of truth: once a PostMedia record
          // exists, the file is attached regardless of whether completeSession()
          // was called by the client.
          await tx.mediaFile.updateMany({
            where: { id: { in: media.map((m) => m.id) } },
            data: {
              attachedToPost: true,
              orphanedAt: null,
            },
          });
        }

        return post;
      },
      {
        timeout: 3000, // 3 second timeout - fail fast if database is slow
      },
    );

    // Audit log: Post creation (don't fail operation if audit logging fails)
    try {
      const auditLogger = this.getAuditLogger(env, requestId);
      await auditLogger.logUserAction(
        {
          action: "post_created",
          resource: "post",
          resourceId: result.id,
          userId: postData.authorId,
          region: region as Region,
          dataRegion: result.dataRegion || region,
          ipAddress: request ? getIPAddress(request) : undefined,
          userAgent: request?.headers.get("User-Agent") || undefined,
          metadata: {
            radius: postData.radius ?? "NORMAL",
            hasGeoData: !!postData.geoData,
            entityCount: entityRefs.length,
          },
          success: true,
        },
        env,
      );
    } catch (auditError) {
      // Don't fail the operation if audit logging fails
      getLogger().warn(
        "[DataRouter] Audit logging failed for post creation:",
        auditError,
      );
    }

    return result;
  }

  /**
   * Get a post from the region-specific database
   *
   * Security: Validates region and verifies dataRegion matches requested region.
   *
   * Audit: Logs data access for compliance.
   *
   * @param postId - Post ID
   * @param region - Region code ('US', 'EU', 'CN')
   * @param env - Environment variables
   * @param request - Optional request object for audit logging (IP, user agent)
   * @param requestId - Optional request ID for audit log correlation
   * @param requestingUserId - Optional ID of user making the request (for audit)
   * @returns Post or null if not found
   * @throws Error if region is invalid or dataRegion mismatch detected
   */
  static async getPost(
    postId: string,
    region: string,
    env: DataRouterEnv,
    request?: Request,
    requestId?: string,
    requestingUserId?: string,
  ): Promise<{
    id: string;
    authorId: string;
    dataRegion: string | null;
    [key: string]: unknown;
  } | null> {
    // CRITICAL: Validate region before routing
    if (!isValidRegion(region)) {
      throw new Error(`Invalid region: ${region}. Valid regions: US, EU, CN`);
    }

    // Get region-specific database (with monitoring if request provided)
    const db = this.getDatabaseForRegion(
      region,
      env,
      request,
      requestingUserId,
    );

    // Find post in region-specific database
    const post = await db.post.findUnique({
      where: { id: postId },
    });

    // CRITICAL: Verify dataRegion matches requested region
    if (post && post.dataRegion && post.dataRegion !== region) {
      // Log security violation and return null (don't expose cross-region data)
      try {
        const auditLogger = this.getAuditLogger(env, requestId);
        await auditLogger.log(
          {
            type: "authorization",
            action: "CROSS_REGION_DATA_ACCESS_BLOCKED",
            resource: "post",
            resourceId: postId,
            userId: requestingUserId,
            region: region as Region,
            dataRegion: post.dataRegion,
            ipAddress: request ? getIPAddress(request) : undefined,
            userAgent: request?.headers.get("User-Agent") || undefined,
            severity: "high",
            success: false,
            metadata: {
              requestedRegion: region,
              actualDataRegion: post.dataRegion,
            },
          },
          env,
        );
      } catch (auditError) {
        getLogger().warn(
          "[DataRouter] Audit logging failed for cross-region access:",
          auditError,
        );
      }

      // Return null instead of throwing (don't expose cross-region data)
      return null;
    }

    // Audit log: Data access (don't fail operation if audit logging fails)
    try {
      const auditLogger = this.getAuditLogger(env, requestId);
      await auditLogger.logDataAccess(
        {
          action: "post_accessed",
          resource: "post",
          resourceId: postId,
          userId: requestingUserId,
          region: region as Region,
          dataRegion: post?.dataRegion || region,
          ipAddress: request ? getIPAddress(request) : undefined,
          userAgent: request?.headers.get("User-Agent") || undefined,
          success: post !== null,
        },
        env,
      );
    } catch (auditError) {
      // Don't fail the operation if audit logging fails
      getLogger().warn(
        "[DataRouter] Audit logging failed for post access:",
        auditError,
      );
    }

    return post;
  }
}
