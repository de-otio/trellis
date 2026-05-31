/**
 * Invitation Handler
 *
 * Handles user-to-user invitations for invitation-only sign-up mode.
 * Users can create invitation codes that others can use to sign up.
 */

import { createPrisma } from "../db.js";
import type { Env } from "../env.js";
import { FeatureToggleService } from "./feature-toggle-service.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { RateLimiter } from "./rate-limit.js";
import { SecurityHeaders } from "./security-headers.js";
import { Session, SessionManager } from "./session-cookie.js";

/**
 * Invitation Handler class
 */
export class InvitationHandler {
  private sessionManager: SessionManager;
  private securityHeaders: SecurityHeaders;
  private rateLimiter: RateLimiter;
  private logger: Logger;

  constructor(env?: LoggerEnv) {
    this.sessionManager = new SessionManager();
    this.securityHeaders = new SecurityHeaders();
    this.rateLimiter = new RateLimiter();
    this.logger = getLogger();
  }

  /**
   * Generate a cryptographically secure session token for tracking who scanned an invitation
   * SECURITY: Uses crypto.getRandomValues() for CSPRNG to prevent spoofing
   */
  private generateSessionToken(): string {
    // Generate 32 random bytes (256 bits of entropy)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    // Convert to base64url for URL-safe encoding
    // Use base64url encoding (RFC 4648) which is safe for URLs
    // Cloudflare Workers support btoa, but we'll use a more compatible approach
    let base64 = "";
    for (let i = 0; i < randomBytes.length; i += 3) {
      const a = randomBytes[i];
      const b = randomBytes[i + 1] || 0;
      const c = randomBytes[i + 2] || 0;
      const bitmap = (a << 16) | (b << 8) | c;
      base64 += String.fromCharCode(
        (bitmap >> 18) & 63,
        (bitmap >> 12) & 63,
        (bitmap >> 6) & 63,
        bitmap & 63,
      );
    }
    // Convert to base64 and then to base64url
    // Cloudflare Workers always have btoa available
    const base64String = btoa(base64);
    const base64url = base64String
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    return `inv_${base64url}`;
  }

  /**
   * Store session token in KV for validation during signup
   * Key: invitation-session:{code}, Value: { token, email?, expiresAt }
   * TTL: 1 hour (3600 seconds)
   */
  private async storeSessionToken(
    code: string,
    token: string,
    email: string | undefined,
    env: Env,
  ): Promise<void> {
    if (!env.INVITATIONS_KV) {
      // If KV not available, we can't store tokens - this is a fallback scenario
      this.logger.warn(
        "[InvitationHandler] INVITATIONS_KV not available, cannot store session token",
      );
      return;
    }

    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour from now
    const key = `invitation-session:${code.toUpperCase()}`;
    const value = JSON.stringify({
      token,
      email: email || null,
      expiresAt: expiresAt.toISOString(),
    });

    await env.INVITATIONS_KV.put(key, value, {
      expirationTtl: 3600, // 1 hour
    });
  }

  /**
   * Validate session token for an invitation code
   * Returns the stored email if token is valid, null otherwise
   */
  private async validateSessionToken(
    code: string,
    token: string,
    env: Env,
  ): Promise<{ valid: boolean; email?: string | null }> {
    if (!env.INVITATIONS_KV) {
      // If KV not available, we can't validate tokens - allow for backward compatibility
      this.logger.warn(
        "[InvitationHandler] INVITATIONS_KV not available, cannot validate session token",
      );
      return { valid: true }; // Allow for backward compatibility
    }

    const key = `invitation-session:${code.toUpperCase()}`;
    const stored = await env.INVITATIONS_KV.get(key);

    if (!stored) {
      return { valid: false };
    }

    try {
      const data = JSON.parse(stored);

      // Check if token matches
      if (data.token !== token) {
        return { valid: false };
      }

      // Check if expired
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        return { valid: false };
      }

      return { valid: true, email: data.email || null };
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error parsing session token data:",
        error,
      );
      return { valid: false };
    }
  }

  /**
   * Generate a cryptographically secure random invitation code
   * SECURITY: Uses crypto.getRandomValues() for CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
   * Increased length to 10 characters for better security (1.1 trillion combinations)
   */
  private generateInvitationCode(): string {
    // SECURITY: Use crypto.getRandomValues() instead of Math.random() for cryptographic security
    // Math.random() is predictable and not suitable for security-sensitive operations
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude ambiguous chars (0, O, I, 1)
    const codeLength = 10; // Increased from 8 to 10 for better security

    // Use crypto.getRandomValues for secure random generation
    const randomValues = new Uint32Array(codeLength);
    crypto.getRandomValues(randomValues);

    let code = "";
    for (let i = 0; i < codeLength; i++) {
      // Use modulo to map random value to character index
      const index = randomValues[i] % chars.length;
      code += chars[index];
    }

    return code;
  }

  /**
   * Delete expired invitations for a user
   *
   * Automatically removes invitations that have expired (expiresAt < now).
   * This keeps the database clean and ensures expired invitations don't count toward limits.
   */
  private async deleteExpiredInvitations(
    userId: string,
    env: Env,
    request?: Request,
  ): Promise<number> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const { detectRegionSync } = await import("./region-detection.js");

    const dbManager = sharedDatabaseConnectionManager;
    const regionRequest = request || new Request("https://api.example.com");
    const region = detectRegionSync(regionRequest, env);

    const now = new Date();

    const deletedCount = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (client) => {
        const result = await client.invitation.deleteMany({
          where: {
            createdBy: userId,
            used: false, // Only delete unused expired invitations
            expiresAt: {
              not: null, // Has expiration date
              lt: now, // Expired
            },
          },
        });
        return result.count;
      },
      {
        ...QueryTimeoutPresets.BACKGROUND, // Background cleanup, less urgent
        defaultValue: 0,
        context: {
          operation: "deleteExpiredInvitations",
          userId,
        },
      },
    );

    if (deletedCount > 0) {
      this.logger.info(
        `[InvitationHandler] Deleted ${deletedCount} expired invitation(s) for user ${userId}`,
      );
    }

    return deletedCount;
  }

  /**
   * Check if user has reached the limit for simultaneously open invitations
   *
   * An invitation is considered "open" if it:
   * - Has not been used (used = false)
   * - Has not expired (expiresAt is null or in the future)
   *
   * This prevents abuse while allowing users to create more invitations
   * by deleting unused ones.
   *
   * Automatically deletes expired invitations before checking the limit.
   */
  private async checkOpenInvitationLimit(
    userId: string,
    maxOpen: number,
    env: Env,
    request?: Request,
  ): Promise<{ allowed: boolean; count: number; limit: number }> {
    // First, clean up expired invitations
    await this.deleteExpiredInvitations(userId, env, request);
    // Use DatabaseConnectionManager for clear state management
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );
    const { detectRegionSync } = await import("./region-detection.js");

    // Create connection manager instance
    const dbManager = sharedDatabaseConnectionManager;
    // Use provided request or create a dummy one for region detection
    const regionRequest = request || new Request("https://api.example.com");
    const region = detectRegionSync(regionRequest, env);

    const now = new Date();

    const count = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (client) => {
        return client.invitation.count({
          where: {
            createdBy: userId,
            used: false, // Not used
            OR: [
              { expiresAt: null }, // No expiration
              { expiresAt: { gt: now } }, // Not expired yet
            ],
          },
        });
      },
      {
        ...QueryTimeoutPresets.USER_FACING,
        defaultValue: 0,
        context: {
          operation: "checkOpenInvitationLimit",
          userId,
        },
      },
    );

    return {
      allowed: count < maxOpen,
      count,
      limit: maxOpen,
    };
  }

  /**
   * Create a new invitation
   * POST /api/invitations
   *
   * Requires authentication. Users can have up to 10 simultaneously open invitations.
   * An invitation is "open" if it's not used and not expired.
   * Users can delete unused invitations to create new ones.
   * SECURITY: Checks sign-up mode - if disabled, prevents invitation creation.
   */
  async handleCreateInvitation(request: Request, env: Env): Promise<Response> {
    try {
      // Check authentication
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      if (!session) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Use DatabaseConnectionManager for all database operations with timeout protection
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { detectRegionSync } = await import("./region-detection.js");

      const dbManager = sharedDatabaseConnectionManager;
      const region = detectRegionSync(request, env);

      // SECURITY: Check sign-up mode - if disabled, prevent invitation creation
      const signupToggle = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (client) => {
          const toggleService = new FeatureToggleService(client);
          return await toggleService.getToggle("user_signup_mode");
        },
        {
          ...QueryTimeoutPresets.CRITICAL, // Critical for security checks
          defaultValue: null, // If timeout, assume open mode (fail open for availability)
          context: {
            operation: "handleCreateInvitation_checkSignupMode",
            userId: session.userId,
          },
        },
      );

      let signupMode: "open" | "invitation_only" | "disabled" = "open";
      if (signupToggle?.description) {
        const modeMatch = signupToggle.description.match(
          /user_signup_mode:(open|invitation_only|disabled)/,
        );
        if (modeMatch) {
          signupMode = modeMatch[1] as "open" | "invitation_only" | "disabled";
        }
      } else if (signupToggle?.enabled === false) {
        signupMode = "disabled";
      }

      // CRITICAL: If sign-up is disabled, prevent invitation creation
      if (signupMode === "disabled") {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Sign-up disabled",
            message:
              "User sign-up is currently disabled. Invitations cannot be created.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Check if user exists and is not suspended
      const user = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (client) => {
          return await client.user.findUnique({
            where: { id: session.userId },
            select: { suspended: true },
          });
        },
        {
          ...QueryTimeoutPresets.CRITICAL, // Critical for security checks
          defaultValue: null, // If timeout, assume user not found
          context: {
            operation: "handleCreateInvitation_checkUser",
            userId: session.userId,
          },
        },
      );

      if (!user) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "User not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      if (user.suspended) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Account suspended" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // SECURITY: Rate limit invitation creation (10 per hour per user)
      const rateLimitResult = this.rateLimiter.checkRateLimit(
        request,
        "/api/invitations",
        10, // 10 invitations
        3600, // per hour
        session.userId,
        undefined,
        session.userId,
      );

      if (!rateLimitResult.allowed) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Rate limit exceeded",
            message:
              "Too many invitation creation requests. Please try again later.",
            retryAfter: Math.ceil(
              (rateLimitResult.resetAt - Date.now()) / 1000,
            ),
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "Retry-After": Math.ceil(
                (rateLimitResult.resetAt - Date.now()) / 1000,
              ).toString(),
            },
          },
        );
      }

      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { createInvitationSchema } = await import("./schemas.js");

      const validation = await validateRequest(request, createInvitationSchema);
      if (!validation.success) {
        return this.securityHeaders.addSecurityHeaders(validation.error);
      }
      const { email, expiresInDays, recaptchaToken } = validation.data;

      // SECURITY: Verify reCAPTCHA token if provided
      if (recaptchaToken && env.RECAPTCHA_SECRET_KEY) {
        const { verifyRecaptcha } = await import("./recaptcha.js");
        const recaptchaResult = await verifyRecaptcha(
          recaptchaToken,
          env.RECAPTCHA_SECRET_KEY,
        );
        if (!recaptchaResult.valid) {
          this.logger.warn(
            "[InvitationHandler] reCAPTCHA verification failed:",
            recaptchaResult.error,
          );
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "reCAPTCHA verification failed",
              message:
                recaptchaResult.error ||
                "Please complete the reCAPTCHA verification.",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      } else if (!recaptchaToken && env.RECAPTCHA_SECRET_KEY) {
        // If reCAPTCHA is configured but token is missing, require it
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "reCAPTCHA verification required",
            message: "Please complete the reCAPTCHA verification.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Email is already validated and sanitized by Zod schema (lowercase, email format)
      // expiresInDays is validated by Zod (1-365 range, default 30)

      // Check limit for simultaneously open invitations
      const maxOpen = 10;
      const limitCheck = await this.checkOpenInvitationLimit(
        session.userId,
        maxOpen,
        env,
        request,
      );

      if (!limitCheck.allowed) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Invitation limit reached",
            message: `You have ${limitCheck.count} open invitations. The limit is ${limitCheck.limit} simultaneously open invitations. Please delete unused invitations to create new ones.`,
            count: limitCheck.count,
            limit: limitCheck.limit,
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }

      if (email) {
        // Create invitation with email
        return await this.createInvitationWithEmail(
          session.userId,
          email,
          expiresInDays,
          limitCheck,
          env,
          request,
        );
      } else {
        // Create invitation without email (limit check already done above)

        // No email restriction - create general invitation
        return await this.createInvitationWithEmail(
          session.userId,
          null,
          expiresInDays,
          limitCheck,
          env,
          request,
        );
      }
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error creating invitation:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Internal helper to create invitation (extracted for code reuse)
   */
  private async createInvitationWithEmail(
    userId: string,
    email: string | null,
    expiresInDays: number | undefined,
    limitCheck: { allowed: boolean; count: number; limit: number },
    env: Env,
    request?: Request,
  ): Promise<Response> {
    try {
      // Use DatabaseConnectionManager for timeout and retry protection
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { detectRegionSync } = await import("./region-detection.js");

      const dbManager = sharedDatabaseConnectionManager;
      const regionRequest = request || new Request("https://api.example.com");
      const region = detectRegionSync(regionRequest, env);

      // SECURITY: Generate cryptographically secure unique invitation code
      let code: string;
      let attempts = 0;
      const maxAttempts = 10;

      // Check for existing code with timeout protection
      do {
        code = this.generateInvitationCode();
        // SECURITY: Prisma uses parameterized queries - SQL injection safe
        const existing = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (client) => {
            return await client.invitation.findUnique({
              where: { code },
            });
          },
          {
            ...QueryTimeoutPresets.USER_FACING, // 3s initial, 2s retry
            defaultValue: null, // Return null on timeout (treat as not found)
            context: {
              operation: "createInvitationWithEmail_checkCode",
              userId,
            },
          },
        );
        if (!existing) break;
        attempts++;
      } while (attempts < maxAttempts);

      if (attempts >= maxAttempts) {
        // SECURITY: Don't reveal internal details - generic error
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Failed to create invitation. Please try again.",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // SECURITY: Validate and calculate expiration date
      let expiresAt: Date | null = null;
      if (expiresInDays) {
        // Already validated above (1-365 days)
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + expiresInDays);
      } else {
        // Default: 30 days
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
      }

      // SECURITY: Create invitation using Prisma (parameterized queries prevent SQL injection)
      // Use timeout protection for the create operation
      const invitation = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (client) => {
          return await client.invitation.create({
            data: {
              code,
              createdBy: userId,
              email: email, // Already sanitized (lowercase, validated)
              expiresAt,
            },
            select: {
              id: true,
              code: true,
              createdBy: true,
              email: true,
              used: true,
              usedBy: true,
              usedAt: true,
              scannedAt: true,
              expiresAt: true,
              createdAt: true,
            },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING, // 3s initial, 2s retry
          context: {
            operation: "createInvitationWithEmail_create",
            userId,
          },
        },
      );

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({
          invitation: {
            id: invitation.id,
            code: invitation.code,
            createdBy: invitation.createdBy,
            email: invitation.email,
            used: invitation.used,
            usedBy: invitation.usedBy,
            usedByEmail: null, // Not applicable for newly created invitation
            usedAt: invitation.usedAt?.toISOString(),
            scannedAt: invitation.scannedAt?.toISOString(),
            expiresAt: invitation.expiresAt?.toISOString(),
            createdAt: invitation.createdAt.toISOString(),
          },
          remainingToday: limitCheck.limit - limitCheck.count - 1,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error creating invitation:",
        error,
      );
      // SECURITY: Don't expose internal error details
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Get inviter info for friend confirmation
   * GET /api/invitations/inviter-info
   *
   * Returns the inviter information for a newly signed up user.
   */
  async handleGetInviterInfo(request: Request, env: Env): Promise<Response> {
    try {
      // Check authentication
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      if (!session) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Get inviter info from KV
      if (!env.INVITATIONS_KV) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ inviterId: null, inviterEmail: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const key = `inviter-info:${session.userId}`;
      const stored = await env.INVITATIONS_KV.get(key);

      if (!stored) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ inviterId: null, inviterEmail: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const data = JSON.parse(stored);
        // Delete after reading (one-time use)
        await env.INVITATIONS_KV.delete(key);

        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            inviterId: data.inviterId,
            inviterEmail: data.inviterEmail,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (e) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ inviterId: null, inviterEmail: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error getting inviter info:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * List user's invitations
   * GET /api/invitations
   *
   * Returns all invitations created by the authenticated user.
   */
  async handleListInvitations(request: Request, env: Env): Promise<Response> {
    let session: Session | null = null;
    try {
      // Check authentication
      session = await this.sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Use DatabaseConnectionManager for clear state management
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { detectRegionSync } = await import("./region-detection.js");

      // Create connection manager instance (manages its own pool state)
      const dbManager = sharedDatabaseConnectionManager;

      // Determine region from request
      const region = detectRegionSync(request, env);

      // Clean up expired invitations before listing
      await this.deleteExpiredInvitations(session.userId, env, request);

      // Execute query with timeout and retry logic
      // queryFn receives a fresh PrismaClient on each call (including retry)
      const invitations = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (client) => {
          // session is guaranteed to be non-null here (checked above)
          const userId = session!.userId;
          const invitations = await client.invitation.findMany({
            where: { createdBy: userId },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: {
              id: true,
              code: true,
              createdBy: true,
              email: true,
              used: true,
              usedBy: true,
              usedAt: true,
              scannedAt: true,
              expiresAt: true,
              createdAt: true,
            },
          });

          // If any invitations are used, fetch user emails separately to avoid join overhead
          const usedInvitationIds = invitations
            .filter((inv: (typeof invitations)[0]) => inv.used && inv.usedBy)
            .map((inv: (typeof invitations)[0]) => inv.usedBy!)
            .filter(
              (id: string, index: number, self: string[]) =>
                self.indexOf(id) === index,
            );

          let userEmailsMap: Record<string, string> = {};
          if (usedInvitationIds.length > 0) {
            const users = await client.user.findMany({
              where: { id: { in: usedInvitationIds } },
              select: { id: true, email: true },
            });
            userEmailsMap = Object.fromEntries(
              users.map((user: { id: string; email: string }) => [
                user.id,
                user.email,
              ]),
            );
          }

          return invitations.map((inv: (typeof invitations)[0]) => ({
            ...inv,
            user: inv.usedBy
              ? { email: userEmailsMap[inv.usedBy] || null }
              : null,
          }));
        },
        {
          ...QueryTimeoutPresets.USER_FACING, // 3s initial, 2s retry = 5s max total
          defaultValue: [], // Return empty array on timeout (graceful degradation)
          context: {
            operation: "handleListInvitations",
            userId: session.userId,
          },
        },
      );

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({
          invitations: invitations.map((inv: (typeof invitations)[0]) => ({
            id: inv.id,
            code: inv.code,
            createdBy: inv.createdBy, // User ID who created the invitation
            email: inv.email, // Email restriction (if invitation was created for specific email)
            used: inv.used,
            usedBy: inv.usedBy,
            usedByEmail: inv.user?.email || null, // Email of user who accepted the invitation
            usedAt: inv.usedAt?.toISOString(),
            scannedAt: inv.scannedAt?.toISOString() || null, // Session token scan timestamp
            expiresAt: inv.expiresAt?.toISOString(),
            createdAt: inv.createdAt.toISOString(),
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("[InvitationHandler] Error listing invitations:", {
        error: error.message,
        errorCode: error.code,
        stack: error.stack,
        userId: session?.userId,
      });

      // Provide more specific error messages for timeout scenarios
      let errorMessage = "Internal server error";
      if (error.message?.includes("timeout")) {
        errorMessage = "Request timed out. Please try again in a moment.";
      }

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Delete an invitation
   * DELETE /api/invitations/:id
   *
   * Allows the creator to delete their own invitation.
   * Cannot delete invitations that are currently being used (scanned but not yet completed signup).
   *
   * SECURITY: Only the creator can delete their own invitations.
   */
  async handleDeleteInvitation(request: Request, env: Env): Promise<Response> {
    let release: (() => Promise<void>) | undefined;
    try {
      // Check authentication
      const sessionSecret = env.SESSION_SECRET;
      const session = await this.sessionManager.getSession(
        request,
        sessionSecret,
        env,
      );
      if (!session) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      // Extract invitation ID from URL path
      const url = new URL(request.url);
      const pathParts = url.pathname.split("/");
      const invitationId = pathParts[pathParts.length - 1];

      if (!invitationId) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invitation ID is required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Get fresh database client (may have been cleared by previous operations)
      let db = createPrisma(env);
      release = db.release;

      // Find the invitation and verify ownership with timeout protection
      // Add detailed logging to diagnose where the hang occurs
      this.logger.info(
        "[InvitationHandler] Delete: Starting findUnique query",
        {
          invitationId,
          userId: session.userId,
          timestamp: new Date().toISOString(),
        },
      );

      const findStartTime = Date.now();
      const findQueryPromise = db.invitation.findUnique({
        where: { id: invitationId },
        select: {
          id: true,
          code: true,
          createdBy: true,
          used: true,
          scannedAt: true,
        },
      });

      const findTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const elapsed = Date.now() - findStartTime;
          this.logger.error("[InvitationHandler] Delete: findUnique timeout", {
            invitationId,
            elapsedMs: elapsed,
            timestamp: new Date().toISOString(),
          });
          reject(new Error(`Database query timeout after ${elapsed}ms`));
        }, 5000); // 5 seconds - very aggressive timeout for diagnosis
      });

      let invitation;
      try {
        invitation = await Promise.race([findQueryPromise, findTimeoutPromise]);
        const findElapsed = Date.now() - findStartTime;
        this.logger.info("[InvitationHandler] Delete: findUnique completed", {
          invitationId,
          elapsedMs: findElapsed,
          found: !!invitation,
        });
      } catch (findError: any) {
        this.logger.error("[InvitationHandler] Delete: findUnique failed", {
          invitationId,
          error: findError.message,
          elapsedMs: Date.now() - findStartTime,
        });

        // If findUnique times out, the connection is likely stale
        // Clear pool cache and retry once with fresh connection
        await release();
        const { sharedDatabaseConnectionManager } = await import(
          "./database-connection-manager.js"
        );
        this.logger.warn(
          "[InvitationHandler] Delete: Clearing pool cache and retrying...",
        );
        sharedDatabaseConnectionManager.clearPools();
        db = createPrisma(env);
        release = db.release;

        // Retry findUnique with fresh connection (very short timeout)
        const retryStartTime = Date.now();
        const retryPromise = db.invitation.findUnique({
          where: { id: invitationId },
          select: {
            id: true,
            code: true,
            createdBy: true,
            used: true,
            scannedAt: true,
          },
        });
        const retryTimeout = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Retry timeout"));
          }, 3000); // 3 seconds for retry
        });

        try {
          invitation = await Promise.race([retryPromise, retryTimeout]);
          this.logger.info("[InvitationHandler] Delete: Retry succeeded", {
            invitationId,
            elapsedMs: Date.now() - retryStartTime,
          });
        } catch (retryError: any) {
          this.logger.error("[InvitationHandler] Delete: Retry also failed", {
            invitationId,
            error: retryError.message,
          });
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "Database query timeout",
              message: "Unable to access invitation. Please try again.",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
      }

      if (!invitation) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Invitation not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // SECURITY: Only the creator can delete their own invitation
      if (invitation.createdBy !== session.userId) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Forbidden: You can only delete your own invitations",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      // Check if invitation is currently being used (scanned but not yet completed)
      // We should prevent deletion if someone is in the process of signing up
      if (invitation.scannedAt && !invitation.used) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "Cannot delete invitation that is currently being used",
            message:
              "This invitation has been scanned and is in the process of being used. Please wait for the signup to complete or expire.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }

      // Delete the invitation with timeout protection
      // Add detailed logging to diagnose where the hang occurs
      this.logger.info("[InvitationHandler] Delete: Starting delete query", {
        invitationId,
        timestamp: new Date().toISOString(),
      });

      const deleteStartTime = Date.now();
      const deleteQueryPromise = db.invitation.delete({
        where: { id: invitationId },
      });

      const deleteTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const elapsed = Date.now() - deleteStartTime;
          this.logger.error("[InvitationHandler] Delete: delete timeout", {
            invitationId,
            elapsedMs: elapsed,
            timestamp: new Date().toISOString(),
          });
          reject(
            new Error(
              `Database delete timeout after ${elapsed}ms - invitation may be locked by another transaction`,
            ),
          );
        }, 5000); // 5 seconds - very aggressive timeout for diagnosis
      });

      try {
        await Promise.race([deleteQueryPromise, deleteTimeoutPromise]);
        const deleteElapsed = Date.now() - deleteStartTime;
        this.logger.info("[InvitationHandler] Delete: delete completed", {
          invitationId,
          elapsedMs: deleteElapsed,
        });
      } catch (error: any) {
        // Log additional context for debugging lock contention
        const elapsed = Date.now() - deleteStartTime;
        this.logger.error("[InvitationHandler] Delete failed:", {
          invitationId,
          error: error.message,
          errorCode: error.code,
          elapsedMs: elapsed,
          hint: "This may indicate row-level lock contention, stale connection, or database issue",
        });
        throw error;
      }

      // Clean up any related KV entries (session tokens)
      if (env.INVITATIONS_KV) {
        const sessionKey = `invitation-session:${invitation.code}`;
        const codeKey = `invitation_code:${invitation.code}`;
        try {
          await env.INVITATIONS_KV.delete(sessionKey);
          // Also try to delete any email-based entries (we don't know which emails, so we can't clean those up)
          // But the session token entry is the important one
        } catch (error) {
          // KV deletion is best-effort, don't fail if it doesn't exist
          this.logger.warn(
            "[InvitationHandler] Failed to delete KV entry:",
            error,
          );
        }
      }

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({
          success: true,
          message: "Invitation deleted successfully",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error: any) {
      this.logger.error("[InvitationHandler] Error deleting invitation:", {
        error: error.message,
        errorCode: error.code,
        stack: error.stack,
      });

      // Provide more specific error messages for timeout scenarios
      let errorMessage = "Internal server error";
      if (error.message?.includes("timeout")) {
        errorMessage =
          "Delete operation timed out. The invitation may be in use by another process. Please try again in a moment.";
      } else if (error.code === "P2025") {
        // Prisma error code for record not found
        errorMessage = "Invitation not found or already deleted";
      }

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    } finally {
      if (release) {
        await release();
      }
    }
  }

  /**
   * Validate an invitation code
   * POST /api/invitations/validate
   *
   * Public endpoint to validate an invitation code before sign-up.
   * Returns whether the code is valid and can be used.
   *
   * SECURITY: Rate limited to prevent brute force attacks.
   */
  async handleValidateInvitation(
    request: Request,
    env: Env,
  ): Promise<Response> {
    try {
      // SECURITY: Rate limit validation attempts to prevent brute force (reduced to 10 per hour per IP)
      const rateLimitResult = this.rateLimiter.checkRateLimit(
        request,
        "/api/invitations/validate",
        10, // 10 validation attempts (reduced from 20)
        3600, // per hour
        undefined,
        undefined,
        undefined,
      );

      if (!rateLimitResult.allowed) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Too many validation attempts. Please try again later.",
          }),
          {
            status: 200, // Return 200 to not reveal rate limiting
            headers: {
              "content-type": "application/json",
              "Retry-After": Math.ceil(
                (rateLimitResult.resetAt - Date.now()) / 1000,
              ).toString(),
            },
          },
        );
      }

      // Validate request body with Zod schema
      const { validateRequest } = await import("./validate-request.js");
      const { validateInvitationSchema } = await import("./schemas.js");

      const validation = await validateRequest(
        request,
        validateInvitationSchema,
      );
      if (!validation.success) {
        return this.securityHeaders.addSecurityHeaders(validation.error);
      }
      const { code: sanitizedCode, email } = validation.data;

      // Code is already validated and sanitized by Zod schema (trimmed, uppercase, max 100 chars)

      const db = createPrisma(env);

      this.logger.info(
        `[InvitationHandler] Validating invitation code: ${sanitizedCode}, email: ${email || "none"}`,
      );

      // SECURITY: Check expiration BEFORE claiming to prevent wasted writes
      // First, do a quick check without locking
      const invitationCheck = await db.invitation.findUnique({
        where: { code: sanitizedCode },
        select: {
          id: true,
          used: true,
          expiresAt: true,
          email: true,
          scannedAt: true,
        },
      });

      this.logger.info(
        "[InvitationHandler] Initial invitation check result:",
        invitationCheck
          ? {
              id: invitationCheck.id,
              used: invitationCheck.used,
              scannedAt: invitationCheck.scannedAt,
              expiresAt: invitationCheck.expiresAt,
              hasEmail: !!invitationCheck.email,
            }
          : "not found",
      );

      if (!invitationCheck) {
        this.logger.warn(
          "[InvitationHandler] Invitation not found:",
          sanitizedCode,
        );
        // SECURITY: Use generic error message to prevent code enumeration
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Invalid or unavailable invitation code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Check expiration first (before claiming)
      if (invitationCheck.expiresAt && new Date() > invitationCheck.expiresAt) {
        this.logger.warn(
          `[InvitationHandler] Invitation expired: ${sanitizedCode}, expires at ${invitationCheck.expiresAt}, now ${new Date()}`,
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Invalid or unavailable invitation code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Check if already used
      if (invitationCheck.used) {
        this.logger.warn(
          "[InvitationHandler] Invitation already used:",
          sanitizedCode,
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Invalid or unavailable invitation code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // SECURITY: If invitation is email-restricted, email is REQUIRED
      if (invitationCheck.email && !email) {
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Email address is required for this invitation code",
            emailRequired: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // SECURITY: For email-restricted invitations, email is REQUIRED and must match
      // For open invitations, email is NOT collected during validation (only during signup)
      let sanitizedEmail: string | undefined = undefined;
      if (invitationCheck.email) {
        // Email-restricted invitation - email is required
        if (!email) {
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              valid: false,
              error: "Email address is required for this invitation code",
              emailRequired: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        const trimmedEmail = email.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailRegex.test(trimmedEmail) && trimmedEmail.length <= 254) {
          sanitizedEmail = trimmedEmail;
        } else {
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              valid: false,
              error: "Invalid email format",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // SECURITY: Check if email matches restriction (case-insensitive comparison)
        if (invitationCheck.email.toLowerCase() !== sanitizedEmail) {
          // SECURITY: Don't reveal the restricted email to prevent enumeration
          return this.securityHeaders.createSecureResponse(
            JSON.stringify({
              valid: false,
              error: "Invalid or unavailable invitation code",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      // For open invitations (no email restriction), we don't collect or store email during validation
      // Email will be collected and validated during actual signup

      // Check if already scanned - if so, return existing token if available
      let sessionToken: string;
      if (invitationCheck.scannedAt) {
        this.logger.info(
          "[InvitationHandler] Invitation already scanned at:",
          invitationCheck.scannedAt,
        );
        // Code was already scanned - check if we have a valid session token
        if (env.INVITATIONS_KV) {
          const key = `invitation-session:${sanitizedCode}`;
          const stored = await env.INVITATIONS_KV.get(key);
          this.logger.info(
            `[InvitationHandler] Checking KV for existing token, key: ${key}, found: ${!!stored}`,
          );
          if (stored) {
            try {
              const data = JSON.parse(stored);
              // Return existing token if valid
              if (
                data.token &&
                (!data.expiresAt || new Date(data.expiresAt) > new Date())
              ) {
                this.logger.info(
                  "[InvitationHandler] Returning existing valid token",
                );
                return this.securityHeaders.createSecureResponse(
                  JSON.stringify({
                    valid: true,
                    token: data.token,
                    emailRestricted: !!invitationCheck.email,
                    requiredEmail: invitationCheck.email || null,
                  }),
                  {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  },
                );
              } else {
                this.logger.warn(
                  "[InvitationHandler] Stored token expired or invalid",
                );
              }
            } catch (e) {
              this.logger.error(
                "[InvitationHandler] Error parsing stored token data:",
                e,
              );
              // Invalid stored data, continue to generate new token
            }
          }
        }
        // If no valid token found, code was scanned but token expired - reject
        this.logger.warn(
          "[InvitationHandler] Invitation already scanned but no valid token found, rejecting",
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Invalid or unavailable invitation code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      this.logger.info(
        "[InvitationHandler] Invitation not yet scanned, proceeding to claim",
      );

      // First time scanning - atomically claim the invitation code with SELECT FOR UPDATE
      sessionToken = this.generateSessionToken();
      const now = new Date();

      // Use transaction to prevent race conditions
      // Note: Using findUnique + update instead of $queryRaw for better compatibility
      const claimed = await db.$transaction(async (tx: any) => {
        // Find the invitation by code
        const inv = await tx.invitation.findUnique({
          where: { code: sanitizedCode },
          select: {
            id: true,
            scannedAt: true,
            scannedBy: true,
            used: true,
            expiresAt: true,
            email: true,
          },
        });

        if (!inv) {
          this.logger.warn(
            "[InvitationHandler] Invitation not found in transaction:",
            sanitizedCode,
          );
          return { success: false, reason: "not_found" };
        }

        // Check all conditions
        if (inv.used) {
          this.logger.warn(
            "[InvitationHandler] Invitation already used:",
            sanitizedCode,
          );
          return { success: false, reason: "already_used" };
        }

        if (inv.scannedAt) {
          this.logger.warn(
            `[InvitationHandler] Invitation already scanned: ${sanitizedCode}, at ${inv.scannedAt}`,
          );
          return { success: false, reason: "already_scanned" };
        }

        if (inv.expiresAt && new Date() > inv.expiresAt) {
          this.logger.warn(
            `[InvitationHandler] Invitation expired: ${sanitizedCode}, expires at ${inv.expiresAt}`,
          );
          return { success: false, reason: "expired" };
        }

        // Claim it atomically - update will fail if record doesn't exist
        // The transaction provides atomicity, and we've already checked conditions above
        try {
          const updated = await tx.invitation.update({
            where: { code: sanitizedCode },
            data: {
              scannedAt: now,
              scannedBy: sessionToken, // Store token as scannedBy for reference
            },
          });
          this.logger.info(
            `[InvitationHandler] Successfully claimed invitation: ${sanitizedCode}, scannedAt: ${updated.scannedAt}`,
          );
          return { success: true };
        } catch (error: any) {
          // If update failed (e.g., record was deleted or already updated), return failure
          // This handles race conditions where another request claimed it first
          this.logger.error(
            `[InvitationHandler] Failed to update invitation in transaction: ${sanitizedCode}, error: ${error.message}${error.code ? `, code: ${error.code}` : ""}`,
          );
          return {
            success: false,
            reason: "update_failed",
            error: error.message,
          };
        }
      });

      if (!claimed.success) {
        this.logger.error(
          `[InvitationHandler] Failed to claim invitation: ${sanitizedCode}, reason: ${(claimed as any).reason || "unknown"}${(claimed as any).error ? `, error: ${(claimed as any).error}` : ""}`,
        );
        return this.securityHeaders.createSecureResponse(
          JSON.stringify({
            valid: false,
            error: "Invalid or unavailable invitation code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Store session token in KV for validation during signup
      await this.storeSessionToken(
        sanitizedCode,
        sessionToken,
        sanitizedEmail,
        env,
      );

      return this.securityHeaders.createSecureResponse(
        JSON.stringify({
          valid: true,
          token: sessionToken,
          emailRestricted: !!invitationCheck.email,
          requiredEmail: invitationCheck.email || null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error validating invitation:",
        error,
      );
      return this.securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  /**
   * Mark an invitation as used
   * Called internally when a user signs up with an invitation code
   *
   * SECURITY: Uses database transaction to prevent race conditions (multiple signups with same code)
   *
   * Also automatically creates a friendship between the inviter and the new user.
   */
  async markInvitationAsUsed(
    code: string,
    userId: string,
    token: string | undefined,
    email: string,
    env: Env,
  ): Promise<{
    success: boolean;
    error?: string;
    inviterId?: string;
    inviterEmail?: string;
  }> {
    try {
      const db = createPrisma(env);

      // SECURITY: Sanitize code input
      const sanitizedCode = code.trim().toUpperCase();
      if (!/^[A-Z0-9]+$/.test(sanitizedCode)) {
        return { success: false, error: "Invalid invitation code format" };
      }

      // SECURITY: Validate session token if provided
      let tokenValidation: { valid: boolean; email?: string | null } | null =
        null;
      if (token) {
        tokenValidation = await this.validateSessionToken(
          sanitizedCode,
          token,
          env,
        );
        if (!tokenValidation.valid) {
          return {
            success: false,
            error:
              "Invalid or expired invitation session. Please scan the QR code again.",
          };
        }

        // Note: Email match enforcement is handled below after we check if invitation is email-restricted
        // For open invitations (no email restriction), we allow email correction to handle typos
      } else {
        // SECURITY: If no token provided, check if code was scanned (backward compatibility)
        // This allows for email-based invitations that don't go through QR scanning
        // But we should still validate that the code exists and is valid
      }

      // SECURITY: Use transaction to prevent race conditions
      // Note: Using findUnique + update instead of $queryRaw for better compatibility
      const result = await db.$transaction(async (tx: any) => {
        // Find the invitation by code
        const invitation = await tx.invitation.findUnique({
          where: { code: sanitizedCode },
          select: {
            id: true,
            createdBy: true,
            expiresAt: true,
            used: true,
            email: true,
          },
        });

        if (!invitation) {
          return { success: false, error: "Invalid invitation code" };
        }

        if (invitation.used) {
          return {
            success: false,
            error: "Invitation code has already been used",
          };
        }

        if (invitation.expiresAt && new Date() > invitation.expiresAt) {
          return { success: false, error: "Invitation code has expired" };
        }

        // SECURITY: Check email restriction if invitation is restricted
        // For email-restricted invitations, enforce exact match
        // For open invitations (no email restriction), allow email correction to handle typos
        if (
          invitation.email &&
          invitation.email.toLowerCase() !== email.toLowerCase()
        ) {
          return {
            success: false,
            error:
              "This invitation code is restricted to a different email address",
          };
        }

        // For open invitations, email is not stored in the session token during validation
        // The email provided during signup is the only email we use
        // No email validation needed for open invitations - they can use any valid email

        // Get creator information
        const creator = await tx.user.findUnique({
          where: { id: invitation.createdBy },
          select: {
            id: true,
            email: true,
          },
        });

        if (!creator) {
          return { success: false, error: "Invitation creator not found" };
        }

        // SECURITY: Atomic update - marks as used and links to user in single operation
        // The transaction provides atomicity, and we've already checked conditions above
        try {
          this.logger.info("[InvitationHandler] Marking invitation as used:", {
            invitationId: invitation.id,
            code: sanitizedCode,
            userId: userId,
            email: email,
          });

          const updated = await tx.invitation.update({
            where: { id: invitation.id },
            data: {
              used: true,
              usedBy: userId,
              usedAt: new Date(),
            },
          });

          this.logger.info(
            "[InvitationHandler] Successfully marked invitation as used:",
            {
              invitationId: updated.id,
              used: updated.used,
              usedBy: updated.usedBy,
              usedAt: updated.usedAt,
            },
          );

          return {
            success: true,
            inviterId: creator.id,
            inviterEmail: creator.email,
          };
        } catch (error: any) {
          // If update failed (e.g., record was deleted or already updated), return failure
          // This handles race conditions where another request used it first
          this.logger.error(
            "[InvitationHandler] Failed to mark invitation as used:",
            {
              invitationId: invitation.id,
              code: sanitizedCode,
              error: error.message,
              errorCode: error.code,
            },
          );
          return {
            success: false,
            error: "Invitation code has already been used",
          };
        }
      });

      if (!result.success) {
        return result;
      }

      // Don't create friendship automatically - return inviter info for frontend to prompt user
      // Friendship will be created after user confirms
      return result;
    } catch (error) {
      this.logger.error(
        "[InvitationHandler] Error marking invitation as used:",
        error,
      );
      return { success: false, error: "Internal server error" };
    }
  }

  /**
   * Create a friendship between the inviter and the new user
   * This is called automatically when an invitation is used
   */
  private async createFriendshipFromInvitation(
    inviterId: string,
    inviterEmail: string,
    newUserId: string,
    newUserEmail: string,
    env: Env,
  ): Promise<void> {
    if (!env.FRIENDS_KV) {
      this.logger.warn(
        "[InvitationHandler] FRIENDS_KV not available, skipping friendship creation",
      );
      return;
    }

    try {
      // Generate friendship ID
      const friendshipId = `friend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date().toISOString();

      // Create friendship object
      const friendship = {
        id: friendshipId,
        requesterId: newUserId,
        requesterEmail: newUserEmail,
        addresseeId: inviterId,
        addresseeEmail: inviterEmail,
        status: "ACCEPTED", // Automatically accepted since invitation was used
        createdAt: now,
        acceptedAt: now,
      };

      // Store bidirectional friendships in KV
      const requesterKey = `friendship:${newUserId}:${inviterId}`;
      const addresseeKey = `friendship:${inviterId}:${newUserId}`;

      await env.FRIENDS_KV.put(requesterKey, JSON.stringify(friendship));
      await env.FRIENDS_KV.put(
        addresseeKey,
        JSON.stringify({
          ...friendship,
          requesterId: inviterId,
          requesterEmail: inviterEmail,
          addresseeId: newUserId,
          addresseeEmail: newUserEmail,
        }),
      );

      // Add to friends lists (with MAX_FRIENDS check)
      await this.addToFriendsList(newUserId, inviterId, env);
      await this.addToFriendsList(inviterId, newUserId, env);

      this.logger.info(
        `[InvitationHandler] Created friendship between ${newUserId} and ${inviterId} from invitation`,
      );
    } catch (error: any) {
      // Log error but don't throw - friendship creation failure shouldn't prevent invitation from being marked as used
      this.logger.error(
        "[InvitationHandler] Error creating friendship from invitation:",
        error,
      );
      if (error.message?.includes("Maximum number of friends")) {
        this.logger.warn(
          `[InvitationHandler] Could not create friendship: ${error.message}`,
        );
      }
    }
  }

  /**
   * Add friend to user's friends list (helper for maintaining list)
   * Throws error if MAX_FRIENDS limit is reached
   */
  private async addToFriendsList(
    userId: string,
    friendId: string,
    env: Env,
  ): Promise<void> {
    if (!env.FRIENDS_KV) return;

    const MAX_FRIENDS = 500; // Same limit as FriendsHandler
    const friendsListKey = `friends-list:${userId}`;
    const friendsListStr = await env.FRIENDS_KV.get(friendsListKey);
    const friendsList = friendsListStr ? JSON.parse(friendsListStr) : [];

    if (!friendsList.includes(friendId)) {
      // Check if user has reached the maximum number of friends
      if (friendsList.length >= MAX_FRIENDS) {
        throw new Error(`Maximum number of friends (${MAX_FRIENDS}) reached`);
      }

      friendsList.push(friendId);
      await env.FRIENDS_KV.put(friendsListKey, JSON.stringify(friendsList));
    }
  }
}
