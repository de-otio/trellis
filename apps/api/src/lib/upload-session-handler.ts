/**
 * Upload Session Handler
 *
 * Manages upload sessions for optimistic image uploads.
 * Provides session lifecycle management: create, add media, complete, abandon.
 */

import type { Env } from "../env.js";
import { getLogger, Logger } from "./logger.js";

export interface UploadSession {
  id: string;
  userId: string;
  mediaIds: string[];
  status: "active" | "completed" | "abandoned";
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateSessionResult {
  sessionId: string;
  expiresAt: string;
}

export class UploadSessionHandler {
  private logger: Logger;

  constructor(env?: Env) {
    this.logger = env ? getLogger() : ({} as Logger);
  }

  /**
   * Create a new upload session
   * Sessions expire after 24 hours
   */
  async createSession(
    userId: string,
    region: string,
    env: Env,
  ): Promise<CreateSessionResult> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Set expiry to 24 hours from now
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const session = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.uploadSession.create({
            data: {
              userId,
              mediaIds: [],
              status: "active",
              expiresAt,
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      this.logger.info("Upload session created", {
        sessionId: session.id,
        userId,
        expiresAt: session.expiresAt.toISOString(),
      });

      return {
        sessionId: session.id,
        expiresAt: session.expiresAt.toISOString(),
      };
    } catch (error) {
      this.logger.error("Failed to create upload session", {
        userId,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Validate session exists, belongs to user, and is not expired
   */
  async validateSession(
    sessionId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<UploadSession | null> {
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      const session = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.uploadSession.findFirst({
            where: {
              id: sessionId,
              userId,
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      if (!session) {
        return null;
      }

      // Check if session is expired
      if (new Date() > session.expiresAt) {
        this.logger.warn("Upload session expired", {
          sessionId,
          userId,
          expiresAt: session.expiresAt.toISOString(),
        });
        return null;
      }

      return session as UploadSession;
    } catch (error) {
      this.logger.error("Failed to validate upload session", {
        sessionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Add media to an upload session
   */
  async addMediaToSession(
    sessionId: string,
    userId: string,
    mediaId: string,
    region: string,
    env: Env,
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Validate session
      const session = await this.validateSession(
        sessionId,
        userId,
        region,
        env,
      );
      if (!session) {
        return {
          success: false,
          error: "Session not found or expired",
        };
      }

      // Verify media exists and belongs to user
      // Note: mediaId can be either a MediaFile.id or a contentHash
      // We check both to handle the case where the media was just uploaded
      // and the MediaFile record hasn't been created yet (async reconciliation)
      const media = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.mediaFile.findFirst({
            where: {
              OR: [
                { id: mediaId, uploadedBy: userId },
                { contentHash: mediaId, uploadedBy: userId },
              ],
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      if (!media) {
        // Media not found - this is expected if the upload just completed
        // and the reconciliation queue hasn't processed it yet
        // We'll still add the mediaId to the session for tracking
        this.logger.info("Media not yet reconciled, adding to session anyway", {
          sessionId,
          userId,
          mediaId,
        });
      }

      // Add media to session's mediaIds array
      const updatedMediaIds = [...session.mediaIds, mediaId];

      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.uploadSession.update({
            where: { id: sessionId },
            data: {
              mediaIds: updatedMediaIds,
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      // Update media lastAccessedAt if it exists
      if (media) {
        await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.update({
              where: { id: media.id },
              data: {
                lastAccessedAt: new Date(),
              },
            }),
          QueryTimeoutPresets.STANDARD,
        );
      }

      this.logger.info("Media added to upload session", {
        sessionId,
        userId,
        mediaId,
        totalMedia: updatedMediaIds.length,
        mediaExists: !!media,
        duration: Date.now() - startTime,
      });

      return { success: true };
    } catch (error) {
      this.logger.error("Failed to add media to upload session", {
        sessionId,
        userId,
        mediaId,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Complete an upload session
   * Marks all media in session as attachedToPost=true
   */
  async completeSession(
    sessionId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Validate session
      const session = await this.validateSession(
        sessionId,
        userId,
        region,
        env,
      );
      if (!session) {
        return {
          success: false,
          error: "Session not found or expired",
        };
      }

      // Mark session as completed
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.uploadSession.update({
            where: { id: sessionId },
            data: {
              status: "completed",
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      // Mark all media in session as attached to post
      if (session.mediaIds.length > 0) {
        await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.updateMany({
              where: {
                id: { in: session.mediaIds },
              },
              data: {
                attachedToPost: true,
                orphanedAt: null, // Clear orphanedAt if it was set
                lastAccessedAt: new Date(),
              },
            }),
          QueryTimeoutPresets.STANDARD,
        );
      }

      this.logger.info("Upload session completed", {
        sessionId,
        userId,
        mediaCount: session.mediaIds.length,
        duration: Date.now() - startTime,
      });

      return { success: true };
    } catch (error) {
      this.logger.error("Failed to complete upload session", {
        sessionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Abandon an upload session
   * Marks all media in session as orphaned
   */
  async abandonSession(
    sessionId: string,
    userId: string,
    region: string,
    env: Env,
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const { sharedDatabaseConnectionManager } = await import(
      "./database-connection-manager.js"
    );
    const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
      "./db-query-helper.js"
    );

    try {
      // Validate session
      const session = await this.validateSession(
        sessionId,
        userId,
        region,
        env,
      );
      if (!session) {
        return {
          success: false,
          error: "Session not found or expired",
        };
      }

      // Mark session as abandoned
      await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env,
        (db) =>
          db.uploadSession.update({
            where: { id: sessionId },
            data: {
              status: "abandoned",
            },
          }),
        QueryTimeoutPresets.STANDARD,
      );

      // Mark all media in session as orphaned
      if (session.mediaIds.length > 0) {
        await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          (db) =>
            db.mediaFile.updateMany({
              where: {
                id: { in: session.mediaIds },
              },
              data: {
                orphanedAt: new Date(),
                attachedToPost: false,
                lastAccessedAt: new Date(),
              },
            }),
          QueryTimeoutPresets.STANDARD,
        );
      }

      this.logger.info("Upload session abandoned", {
        sessionId,
        userId,
        mediaCount: session.mediaIds.length,
        duration: Date.now() - startTime,
      });

      return { success: true };
    } catch (error) {
      this.logger.error("Failed to abandon upload session", {
        sessionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      });
      throw error;
    }
  }
}
