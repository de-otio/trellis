import type { KVNamespace } from "../types/cloudflare-compat.js";
/**
 * Enhanced User Account Deletion Handler
 *
 * Implements all security recommendations:
 * - Grace period (7 days soft delete before hard delete)
 * - Rate limiting (via DynamoDB-backed KV)
 * - Confirmation code validation (6-digit code stored in DynamoDB with 24h TTL)
 * - Scheduled cleanup via nightly cron
 */

import { Session } from "./session-cookie.js";
import { createPrisma } from "../db.js";
import { createEmailProvider } from "./email-provider.js";

import { getLogger, Logger, type LoggerEnv } from "./logger.js";
import { invalidateClaimsForUserId } from "./auth/claims-invalidation.js";
import * as crypto from "node:crypto";

export interface Env {
  DATABASE_URL: string;
  DELETE_JOBS_KV?: KVNamespace;
  RESEND_API_KEY?: string;
  EMAIL_SERVICE?: "resend" | "alibaba-directmail" | "tencent-ses" | "aws-ses";
  FROM_EMAIL?: string;
  APP_URL?: string;
  RATE_LIMIT_KV?: KVNamespace;
}

export interface DeletionRequest {
  userId: string;
  email: string;
  confirmationCode?: string; // For 2FA/confirmation
}

export interface DeletionJob {
  jobId: string;
  userId: string;
  email: string;
  status:
    | "pending"
    | "confirmed"
    | "scheduled"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";
  createdAt: string;
  confirmedAt?: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  itemsDeleted?: {
    posts: number;
    comments: number;
    reactions: number;
    mediaReferences: number;
    mediaFiles: number;
  };
}

export class UserDeletionHandlerEnhanced {
  private readonly GRACE_PERIOD_DAYS = 7;
  private readonly DELETION_RATE_LIMIT = 3; // 3 requests per hour
  private readonly DELETION_RATE_WINDOW = 3600; // 1 hour in seconds

  /**
   * Request account deletion (step 1: initial request)
   * Sets grace period and requires confirmation
   */
  async requestDeletion(
    session: Session,
    env: Env,
  ): Promise<{
    success: boolean;
    message: string;
    scheduledAt?: string;
    confirmationRequired?: boolean;
  }> {
    const db = createPrisma(env);

    // Check rate limit
    const rateLimitKey = `ratelimit:delete-account:user:${session.userId}`;
    if (env.RATE_LIMIT_KV) {
      const rateLimit = await this.checkRateLimitKV(
        rateLimitKey,
        env.RATE_LIMIT_KV,
      );
      if (!rateLimit.allowed) {
        throw new Error(
          `Rate limit exceeded. Please try again after ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`,
        );
      }
    }

    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        email: true,
        suspended: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
        deletionConfirmedAt: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Check if deletion already requested
    if (user.deletionRequestedAt) {
      if (user.deletionConfirmedAt) {
        // Already confirmed, return scheduled time
        return {
          success: true,
          message: "Deletion already confirmed and scheduled",
          scheduledAt: user.deletionScheduledAt?.toISOString(),
        };
      }
      // Requested but not confirmed
      return {
        success: false,
        message: "Deletion already requested. Please confirm to proceed.",
        confirmationRequired: true,
      };
    }

    // Storing the confirmation code must not be optional. A skipped write
    // emails a code that nothing can ever validate, and since confirmDeletion
    // now fails closed, the account would be left suspended with
    // `deletionRequestedAt` set — which makes every retry take the "already
    // requested, please confirm" branch above. That is a lockout, not a
    // degradation.
    //
    // Checked BEFORE the row is touched, so an unavailable store leaves the
    // account exactly as it was.
    if (!env.DELETE_JOBS_KV) {
      getLogger().error(
        "[UserDeletion] DELETE_JOBS_KV binding is missing — refusing the request rather than suspending the account with an unusable code.",
      );
      throw new Error(
        "Deletion requests are unavailable. Please try again later.",
      );
    }

    // Set grace period: request deletion, schedule hard delete in 7 days
    const now = new Date();
    const scheduledAt = new Date(
      now.getTime() + this.GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );

    await db.user.update({
      where: { id: session.userId },
      data: {
        deletionRequestedAt: now,
        deletionScheduledAt: scheduledAt,
        suspended: true, // Suspend immediately
        suspendedAt: now,
        suspendedReason:
          "User requested account deletion - grace period active",
      },
    });

    // SEC (claims-cache freshness audit): this is a SUSPENSION path, and a
    // pre-token-generation cache HIT skips the RDS suspension check entirely.
    // Without this the account is suspended in Postgres yet keeps minting
    // fully-privileged JWTs for up to one cache TTL (~1h) — the exact gap the
    // "G2 finding H3" note in the Lambda warns about. This call site was
    // missing it.
    await invalidateClaimsForUserId(db, session.userId, "user.deletion_request");

    // Generate 6-digit confirmation code and store with 24h TTL.
    const confirmationCode = crypto.randomInt(100000, 999999).toString();
    try {
      await env.DELETE_JOBS_KV.put(
        `deletion-confirm:${session.userId}`,
        JSON.stringify({ code: confirmationCode, createdAt: now.toISOString() }),
        { expirationTtl: 86400 }, // 24 hours
      );
    } catch (error) {
      // The row is already marked. There is no transaction spanning Postgres
      // and the KV store, so undo the mark by hand — otherwise the user is
      // suspended, unable to confirm, and unable to re-request.
      getLogger().error(
        "[UserDeletion] Failed to store the confirmation code — reverting the deletion request so the account is not stranded.",
        error,
      );
      await db.user.update({
        where: { id: session.userId },
        data: {
          deletionRequestedAt: null,
          deletionScheduledAt: null,
          suspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      });
      throw new Error(
        "Deletion requests are unavailable. Please try again later.",
      );
    }

    // Send confirmation email with code
    await this.sendDeletionConfirmationRequestEmail(
      user.email,
      scheduledAt,
      confirmationCode,
      env,
    );

    return {
      success: true,
      message:
        "Deletion requested. Please check your email to confirm. You have 7 days to cancel.",
      scheduledAt: scheduledAt.toISOString(),
      confirmationRequired: true,
    };
  }

  /**
   * Confirm account deletion (step 2: user confirms via email link)
   */
  async confirmDeletion(
    userId: string,
    confirmationCode: string,
    env: Env,
  ): Promise<{ success: boolean; message: string; scheduledAt: string }> {
    const db = createPrisma(env);

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
        deletionConfirmedAt: true,
      },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.deletionRequestedAt) {
      throw new Error("No deletion request found");
    }

    if (user.deletionConfirmedAt) {
      return {
        success: true,
        message: "Deletion already confirmed",
        scheduledAt: user.deletionScheduledAt!.toISOString(),
      };
    }

    // Validate the emailed confirmation code.
    //
    // This used to be wrapped in `if (env.DELETE_JOBS_KV)`, which made the
    // check itself OPTIONAL: with no binding the whole block was skipped and
    // the deletion was confirmed with no code validated at all. The email step
    // exists to prove mailbox control before an irreversible action, so
    // skipping it is not a degradation — it removes the second factor.
    //
    // Fail closed instead. A store we cannot read cannot confirm a code, and
    // "cannot confirm" must never resolve to "confirmed".
    if (!env.DELETE_JOBS_KV) {
      getLogger().error(
        "[UserDeletion] SECURITY: DELETE_JOBS_KV binding is missing — refusing to confirm deletion without validating the emailed code.",
      );
      throw new Error(
        "Deletion confirmation is unavailable. Please try again later.",
      );
    }

    const stored = await env.DELETE_JOBS_KV.get(`deletion-confirm:${userId}`);
    if (!stored) {
      throw new Error("Confirmation code expired or not found. Please request deletion again.");
    }
    const { code } = JSON.parse(stored) as { code: string };
    if (code !== confirmationCode) {
      throw new Error("Invalid confirmation code");
    }
    // One-time use: delete after successful validation
    await env.DELETE_JOBS_KV.delete(`deletion-confirm:${userId}`);

    await db.user.update({
      where: { id: userId },
      data: {
        deletionConfirmedAt: new Date(),
      },
    });

    // Send confirmation email
    await this.sendDeletionConfirmedEmail(
      user.email,
      user.deletionScheduledAt!,
      env,
    );

    return {
      success: true,
      message:
        "Deletion confirmed. Your account will be permanently deleted on the scheduled date.",
      scheduledAt: user.deletionScheduledAt!.toISOString(),
    };
  }

  /**
   * Cancel account deletion (within grace period)
   */
  async cancelDeletion(
    session: Session,
    env: Env,
  ): Promise<{ success: boolean; message: string }> {
    const db = createPrisma(env);

    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        email: true,
        deletionRequestedAt: true,
        deletionScheduledAt: true,
      },
    });

    if (!user || !user.deletionRequestedAt) {
      throw new Error("No deletion request found to cancel");
    }

    // Check if grace period has passed
    if (user.deletionScheduledAt && new Date() >= user.deletionScheduledAt) {
      throw new Error(
        "Grace period has expired. Deletion cannot be cancelled.",
      );
    }

    await db.user.update({
      where: { id: session.userId },
      data: {
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionConfirmedAt: null,
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
      },
    });

    await this.sendDeletionCancelledEmail(user.email, env);

    return {
      success: true,
      message:
        "Account deletion has been cancelled. Your account is now active.",
    };
  }

  /**
   * Check rate limit using KV
   */
  private async checkRateLimitKV(
    key: string,
    kv: KVNamespace,
  ): Promise<{ allowed: boolean; retryAfter: number }> {
    const stored = await kv.get(key);
    const now = Date.now();

    if (!stored) {
      await kv.put(
        key,
        JSON.stringify({
          count: 1,
          resetAt: now + this.DELETION_RATE_WINDOW * 1000,
        }),
        {
          expirationTtl: this.DELETION_RATE_WINDOW,
        },
      );
      return { allowed: true, retryAfter: 0 };
    }

    const data = JSON.parse(stored) as { count: number; resetAt: number };

    if (data.resetAt < now) {
      // Reset window
      await kv.put(
        key,
        JSON.stringify({
          count: 1,
          resetAt: now + this.DELETION_RATE_WINDOW * 1000,
        }),
        {
          expirationTtl: this.DELETION_RATE_WINDOW,
        },
      );
      return { allowed: true, retryAfter: 0 };
    }

    if (data.count >= this.DELETION_RATE_LIMIT) {
      return {
        allowed: false,
        retryAfter: Math.ceil((data.resetAt - now) / 1000),
      };
    }

    // Increment count
    data.count++;
    const ttlRemaining = Math.ceil((data.resetAt - now) / 1000);
    // KV requires minimum 60 seconds TTL
    await kv.put(key, JSON.stringify(data), {
      expirationTtl: Math.max(60, ttlRemaining),
    });

    return { allowed: true, retryAfter: 0 };
  }

  /**
   * Send deletion confirmation request email
   */
  private async sendDeletionConfirmationRequestEmail(
    email: string,
    scheduledAt: Date,
    confirmationCode: string,
    env: Env,
  ): Promise<void> {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;

    try {
      const emailProvider = createEmailProvider({
        provider: env.EMAIL_SERVICE || "resend",
        resendApiKey: env.RESEND_API_KEY,
      });

      await emailProvider.sendEmail({
        to: email,
        from: env.FROM_EMAIL,
        subject: "Confirm Your Trellis Account Deletion",
        html: `
          <h2>Account Deletion Request</h2>
          <p>You have requested to delete your Trellis account.</p>
          <p><strong>Your account will be permanently deleted on: ${scheduledAt.toLocaleDateString()}</strong></p>
          <p>Your confirmation code is: <strong>${confirmationCode}</strong></p>
          <p>Enter this code in the app to confirm your deletion request. The code expires in 24 hours.</p>
          <p>If you did not request this deletion, you can ignore this email or cancel the deletion from your account settings.</p>
          <p><strong>You have 7 days to cancel before the deletion becomes permanent.</strong></p>
        `,
        text: `
Account Deletion Request

You have requested to delete your Trellis account.

Your account will be permanently deleted on: ${scheduledAt.toLocaleDateString()}

Your confirmation code is: ${confirmationCode}

Enter this code in the app to confirm your deletion request. The code expires in 24 hours.

If you did not request this deletion, you can ignore this email or cancel the deletion from your account settings.

You have 7 days to cancel before the deletion becomes permanent.
        `,
      });
    } catch (error) {
      getLogger().error(
        "[UserDeletionHandler] Failed to send confirmation email:",
        error,
      );
    }
  }

  /**
   * Send deletion confirmed email
   */
  private async sendDeletionConfirmedEmail(
    email: string,
    scheduledAt: Date,
    env: Env,
  ): Promise<void> {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;

    try {
      const emailProvider = createEmailProvider({
        provider: env.EMAIL_SERVICE || "resend",
        resendApiKey: env.RESEND_API_KEY,
      });

      await emailProvider.sendEmail({
        to: email,
        from: env.FROM_EMAIL,
        subject: "Account Deletion Confirmed",
        html: `
          <h2>Deletion Confirmed</h2>
          <p>Your account deletion has been confirmed.</p>
          <p><strong>Your account will be permanently deleted on: ${scheduledAt.toLocaleDateString()}</strong></p>
          <p>You can still cancel this deletion from your account settings until the scheduled date.</p>
        `,
        text: `
Deletion Confirmed

Your account deletion has been confirmed.

Your account will be permanently deleted on: ${scheduledAt.toLocaleDateString()}

You can still cancel this deletion from your account settings until the scheduled date.
        `,
      });
    } catch (error) {
      getLogger().error(
        "[UserDeletionHandler] Failed to send confirmed email:",
        error,
      );
    }
  }

  /**
   * Send deletion cancelled email
   */
  private async sendDeletionCancelledEmail(
    email: string,
    env: Env,
  ): Promise<void> {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;

    try {
      const emailProvider = createEmailProvider({
        provider: env.EMAIL_SERVICE || "resend",
        resendApiKey: env.RESEND_API_KEY,
      });

      await emailProvider.sendEmail({
        to: email,
        from: env.FROM_EMAIL,
        subject: "Account Deletion Cancelled",
        html: `
          <h2>Deletion Cancelled</h2>
          <p>Your account deletion has been cancelled.</p>
          <p>Your account is now active and you can continue using Trellis.</p>
        `,
        text: `
Deletion Cancelled

Your account deletion has been cancelled.

Your account is now active and you can continue using Trellis.
        `,
      });
    } catch (error) {
      getLogger().error(
        "[UserDeletionHandler] Failed to send cancelled email:",
        error,
      );
    }
  }

  /**
   * Send deletion complete email
   */
  private async sendDeletionCompleteEmail(
    email: string,
    itemsDeleted: DeletionJob["itemsDeleted"],
    env: Env,
  ): Promise<void> {
    if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return;

    try {
      const emailProvider = createEmailProvider({
        provider: env.EMAIL_SERVICE || "resend",
        resendApiKey: env.RESEND_API_KEY,
      });

      const summary = itemsDeleted
        ? `\n\nSummary of deleted data:\n- Posts: ${itemsDeleted.posts}\n- Comments: ${itemsDeleted.comments}\n- Reactions: ${itemsDeleted.reactions}\n- Media files: ${itemsDeleted.mediaFiles}`
        : "";

      await emailProvider.sendEmail({
        to: email,
        from: env.FROM_EMAIL,
        subject: "Your Trellis account has been deleted",
        html: `
          <h2>Account Deletion Complete</h2>
          <p>Your Trellis account and all associated data have been permanently deleted.</p>
          ${summary}
        `,
        text: `
Account Deletion Complete

Your Trellis account and all associated data have been permanently deleted.${summary}
        `,
      });
    } catch (error) {
      getLogger().error(
        "[UserDeletionHandler] Failed to send completion email:",
        error,
      );
    }
  }
}
