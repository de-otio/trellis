import type { KVNamespace, R2Bucket, CloudflareQueue } from "../types/cloudflare-compat.js";
/**
 * Friends Handler class for managing user friendships and connection codes
 *
 * This handler manages:
 * - Friend connections
 * - Temporary connection codes for QR code scanning
 * - Currently uses KV for storage, but can be extended to use database
 */


import { Session } from "./session-cookie.js";
import { createPrisma } from "../db.js";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface Friend {
  id: string; // Supabase user_id
  email: string;
  actorUri?: string; // ActivityPub actor URI
  handle?: string; // ActivityPub handle
  status: "ACCEPTED" | "PENDING";
  acceptedAt?: string;
  friendshipId?: string;
}

export interface ConnectionCode {
  code: string;
  expiresAt: string;
}

export interface Env {
  FRIENDS_KV?: KVNamespace; // Optional KV namespace for friends and connection codes
  CONNECTION_CODES_KV?: KVNamespace; // Optional KV namespace for connection codes
  DATABASE_URL?: string; // For future database integration
}

export class FriendsHandler {
  // Maximum number of friends a user can have
  private readonly MAX_FRIENDS = 500;

  /**
   * Generate a temporary, single-use connection code
   */
  async generateConnectionCode(
    session: Session,
    env: Env,
  ): Promise<ConnectionCode> {
    // Generate a secure random code (32 characters)
    const code = this.generateSecureCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now

    // Store code in KV with user's ID
    if (env.CONNECTION_CODES_KV || env.FRIENDS_KV) {
      const kv = env.CONNECTION_CODES_KV || env.FRIENDS_KV!;
      const key = `connection-code:${code}`;
      await kv.put(
        key,
        JSON.stringify({
          userId: session.userId,
          email: session.email,
          createdAt: new Date().toISOString(),
          expiresAt: expiresAt.toISOString(),
          used: false,
        }),
        {
          expirationTtl: 300, // 5 minutes in seconds
        },
      );
    }

    return {
      code,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Use a connection code to create a friendship
   */
  async useConnectionCode(
    session: Session,
    code: string,
    env: Env,
  ): Promise<{ success: boolean; friendshipId?: string }> {
    // Get code from KV
    const kv = env.CONNECTION_CODES_KV || env.FRIENDS_KV;
    if (!kv) {
      throw new Error("Connection codes storage not available");
    }

    const key = `connection-code:${code}`;
    const codeDataStr = await kv.get(key);

    if (!codeDataStr) {
      throw new Error("Invalid or expired connection code");
    }

    const codeData = JSON.parse(codeDataStr);

    // Check if code is expired
    if (new Date(codeData.expiresAt) < new Date()) {
      await kv.delete(key);
      throw new Error("Connection code has expired");
    }

    // Check if code has been used
    if (codeData.used) {
      throw new Error("Connection code has already been used");
    }

    // Check if user is trying to connect to themselves
    if (codeData.userId === session.userId) {
      throw new Error("Cannot connect to yourself");
    }

    // Mark code as used
    codeData.used = true;
    await kv.put(key, JSON.stringify(codeData), {
      expirationTtl: 300, // Keep for 5 minutes even after use for audit
    });

    // Create friendship (using KV for now, can be migrated to database later)
    const friendshipId = this.generateId();
    const friendship = {
      id: friendshipId,
      requesterId: session.userId,
      requesterEmail: session.email,
      addresseeId: codeData.userId,
      addresseeEmail: codeData.email,
      status: "ACCEPTED", // QR code connection is automatically accepted
      createdAt: new Date().toISOString(),
      acceptedAt: new Date().toISOString(),
    };

    // Store friendship in KV
    if (env.FRIENDS_KV) {
      // Store bidirectional friendships
      const requesterKey = `friendship:${session.userId}:${codeData.userId}`;
      const addresseeKey = `friendship:${codeData.userId}:${session.userId}`;

      await env.FRIENDS_KV.put(requesterKey, JSON.stringify(friendship));
      await env.FRIENDS_KV.put(
        addresseeKey,
        JSON.stringify({
          ...friendship,
          requesterId: codeData.userId,
          requesterEmail: codeData.email,
          addresseeId: session.userId,
          addresseeEmail: session.email,
        }),
      );

      // Add to friends lists
      await this.addToFriendsList(session.userId, codeData.userId, env);
      await this.addToFriendsList(codeData.userId, session.userId, env);
    }

    // TODO: Future implementation - store in database when schema is ready
    // TODO: Create bidirectional friendship records in database

    return {
      success: true,
      friendshipId,
    };
  }

  /**
   * Get user's friends list
   * Returns up to MAX_FRIENDS friends
   */
  async getFriends(
    session: Session,
    status: "ACCEPTED" | "PENDING" = "ACCEPTED",
    env: Env,
  ): Promise<Friend[]> {
    const friends: Friend[] = [];

    if (env.FRIENDS_KV) {
      // List all friendships for this user
      // Note: KV doesn't support listing by prefix efficiently, so we'll need to store a list
      // For now, we'll use a simple approach with a friends list key
      const friendsListKey = `friends-list:${session.userId}`;
      const friendsListStr = await env.FRIENDS_KV.get(friendsListKey);

      if (friendsListStr) {
        const friendsList = JSON.parse(friendsListStr);
        // Limit iteration to MAX_FRIENDS for performance
        const maxIterations = Math.min(friendsList.length, this.MAX_FRIENDS);
        for (let i = 0; i < maxIterations; i++) {
          const friendId = friendsList[i];
          const friendshipKey = `friendship:${session.userId}:${friendId}`;
          const friendshipStr = await env.FRIENDS_KV.get(friendshipKey);

          if (friendshipStr) {
            const friendship = JSON.parse(friendshipStr);
            if (friendship.status === status) {
              friends.push({
                id: friendship.addresseeId,
                email: friendship.addresseeEmail,
                status: friendship.status,
                acceptedAt: friendship.acceptedAt,
                friendshipId: friendship.id,
              });
            }
          }
        }
      }
    }

    // TODO: Future implementation - query from database when schema is ready

    return friends;
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

    const friendsListKey = `friends-list:${userId}`;
    const friendsListStr = await env.FRIENDS_KV.get(friendsListKey);
    const friendsList = friendsListStr ? JSON.parse(friendsListStr) : [];

    if (!friendsList.includes(friendId)) {
      // Check if user has reached the maximum number of friends
      if (friendsList.length >= this.MAX_FRIENDS) {
        throw new Error(
          `Maximum number of friends (${this.MAX_FRIENDS}) reached`,
        );
      }

      friendsList.push(friendId);
      await env.FRIENDS_KV.put(friendsListKey, JSON.stringify(friendsList));
    }
  }

  /**
   * Generate a secure random code
   */
  private generateSecureCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 32; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `friend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Handle GET request for friends list
   */
  async handleGetFriends(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const status = (url.searchParams.get("status") || "ACCEPTED") as
        | "ACCEPTED"
        | "PENDING";

      const friends = await this.getFriends(session, status, env);

      return new Response(JSON.stringify({ friends }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error handling get friends:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get friends list" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Handle POST request for generating connection code
   */
  async handleGenerateConnectionCode(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const connectionCode = await this.generateConnectionCode(session, env);

      return new Response(JSON.stringify(connectionCode), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error(
        "Error handling generate connection code:",
        error,
      );
      return new Response(
        JSON.stringify({
          error: error.message || "Failed to generate connection code",
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Handle POST request for using connection code
   */
  async handleConnect(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const body = (await request.json()) as { code?: string };
      const { code } = body;

      if (!code || typeof code !== "string") {
        return new Response(
          JSON.stringify({ error: "Connection code is required" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      const result = await this.useConnectionCode(session, code, env);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error: any) {
      getLogger().error("Error handling connect:", error);

      // Return 403 if maximum friends limit reached, otherwise 400
      const isLimitError = error.message?.includes("Maximum number of friends");
      const status = isLimitError ? 403 : 400;

      return new Response(
        JSON.stringify({
          error: error.message || "Failed to connect",
        }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  /**
   * Create friendship from invitation (after user confirms)
   * POST /friends/connect-from-invitation
   */
  async handleConnectFromInvitation(
    request: Request,
    session: Session,
    env: Env,
  ): Promise<Response> {
    try {
      const body = (await request.json()) as { inviterId?: string };
      const { inviterId } = body;

      if (!inviterId || typeof inviterId !== "string") {
        return new Response(
          JSON.stringify({ error: "Inviter ID is required" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Check if user is trying to connect to themselves
      if (inviterId === session.userId) {
        return new Response(
          JSON.stringify({ error: "Cannot connect to yourself" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Get inviter's email from database
      if (!env.DATABASE_URL) {
        return new Response(
          JSON.stringify({ error: "Database not configured" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
      // Get inviter with timeout/retry
      const { sharedDatabaseConnectionManager } = await import(
        "./database-connection-manager.js"
      );
      const { withQueryTimeoutAndRetry, QueryTimeoutPresets } = await import(
        "./db-query-helper.js"
      );
      const { detectRegionSync } = await import("./region-detection.js");

      const region = detectRegionSync(request as any, env as any);
      const inviter = await withQueryTimeoutAndRetry(
        sharedDatabaseConnectionManager,
        region,
        env as any,
        async (db) => {
          return await db.user.findUnique({
            where: { id: inviterId },
            select: { email: true },
          });
        },
        {
          ...QueryTimeoutPresets.USER_FACING,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "handleInvite_findInviter",
            userId: session.userId,
            inviterId,
          },
        },
      );

      if (!inviter || !inviter.email) {
        return new Response(JSON.stringify({ error: "Inviter not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // Create friendship using the same logic as useConnectionCode
      const friendshipId = this.generateId();
      const now = new Date().toISOString();

      const friendship = {
        id: friendshipId,
        requesterId: session.userId,
        requesterEmail: session.email,
        addresseeId: inviterId,
        addresseeEmail: inviter.email,
        status: "ACCEPTED" as const,
        createdAt: now,
        acceptedAt: now,
      };

      // Store bidirectional friendships in KV
      if (env.FRIENDS_KV) {
        const requesterKey = `friendship:${session.userId}:${inviterId}`;
        const addresseeKey = `friendship:${inviterId}:${session.userId}`;

        await env.FRIENDS_KV.put(requesterKey, JSON.stringify(friendship));
        await env.FRIENDS_KV.put(
          addresseeKey,
          JSON.stringify({
            ...friendship,
            requesterId: inviterId,
            requesterEmail: inviter.email,
            addresseeId: session.userId,
            addresseeEmail: session.email,
          }),
        );

        // Add to friends lists
        await this.addToFriendsList(session.userId, inviterId, env);
        await this.addToFriendsList(inviterId, session.userId, env);
      }

      return new Response(
        JSON.stringify({
          success: true,
          friendshipId,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error: any) {
      getLogger().error(
        "Error handling connect from invitation:",
        error,
      );

      // Return 403 if maximum friends limit reached, otherwise 400
      const isLimitError = error.message?.includes("Maximum number of friends");
      const status = isLimitError ? 403 : 400;

      return new Response(
        JSON.stringify({
          error: error.message || "Failed to add friend",
        }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }
}
