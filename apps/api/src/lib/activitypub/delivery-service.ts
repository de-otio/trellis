/**
 * ActivityPub Delivery Service
 *
 * Handles delivery of activities to actor inboxes using Fedify.
 */

import type { Post, PrismaClient, User } from "@prisma/client";
import type { Env } from "../../env.js";
import { type ActivityStreamsActivity } from "./activity-service.js";
import { ActorService } from "./actor.js";
import { UserActorDispatcher } from "./dispatchers/user-actor.js";
import { getActivityPubBaseUrl } from "./fedify/context.js";
import { Logger } from "../logger.js";
import { deliverActivityWithFedify } from "./services/fedify-delivery.js";

/**
 * Service for delivering ActivityPub activities to recipients
 */
export class DeliveryService {
  /**
   * Get followers of a user (for followers-only posts)
   */
  static async getFollowers(
    prisma: PrismaClient,
    userId: string,
  ): Promise<User[]> {
    // TODO: redesign - use GraphService
    return [] as User[];
  }

  /**
   * Get friends of a user (for friends-only posts)
   */
  static async getFriends(
    prisma: PrismaClient,
    userId: string,
  ): Promise<User[]> {
    // Get user's actor URI
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { actorUri: true },
    });

    if (!user || !user.actorUri) {
      return [];
    }

    // TODO: redesign - use GraphService
    return [] as User[];
  }

  /**
   * Get members of a group (for group posts)
   */
  static async getGroupMembers(
    prisma: PrismaClient,
    groupId: string,
  ): Promise<User[]> {
    const members = await prisma.groupMember.findMany({
      where: {
        groupId,
      },
      select: {
        actorUri: true,
      },
    });

    // Resolve member actor URIs to users
    const users: User[] = [];
    for (const member of members) {
      const user = await prisma.user.findUnique({
        where: { actorUri: member.actorUri },
      });
      if (user) {
        users.push(user);
      }
    }

    return users;
  }

  /**
   * Get recipients for a post based on audience targeting
   */
  static async getRecipients(
    prisma: PrismaClient,
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
  ): Promise<User[]> {
    const recipients: User[] = [];
    const actorId = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );

    // Check if post is in a group
    if (post.groupId) {
      // Group post: deliver to all group members
      const groupMembers = await this.getGroupMembers(prisma, post.groupId);
      recipients.push(...groupMembers);
      // Return early - group posts only go to members
      return Array.from(new Map(recipients.map((u) => [u.id, u])).values());
    }

    // Handle 'to' field (primary audience)
    if (post.to) {
      const toAudience = Array.isArray(post.to) ? post.to : [post.to];

      for (const target of toAudience) {
        if (typeof target !== "string") continue;

        if (target === "https://www.w3.org/ns/activitystreams#Public") {
          // Public: deliver to all followers
          const followers = await this.getFollowers(prisma, author.id);
          recipients.push(...followers);
        } else if (target.endsWith("/followers")) {
          // Followers-only: deliver to followers
          // Check if this is a group (groups use /groups/:groupId/followers for members)
          if (target.includes("/groups/")) {
            // Group post: deliver to group members
            const groupId = target.split("/groups/")[1].split("/")[0];
            const groupMembers = await this.getGroupMembers(prisma, groupId);
            recipients.push(...groupMembers);
          } else if (target.startsWith(actorId)) {
            // User or dog profile followers
            const followers = await this.getFollowers(prisma, author.id);
            recipients.push(...followers);
          }
        } else if (target.endsWith("/friends")) {
          // Friends-only: deliver to friends
          if (target.startsWith(actorId)) {
            const friends = await this.getFriends(prisma, author.id);
            recipients.push(...friends);
          }
        } else if (target.includes("/audiences/")) {
          // Custom audience: resolve collection
          const { CustomAudienceService } = await import("./audience-service.js");
          const memberActorUris = await CustomAudienceService.resolveCollection(
            prisma,
            target,
            env,
            requestUrl,
          );

          // Resolve actor URIs to users
          for (const actorUri of memberActorUris) {
            const user = await this.resolveActorUri(prisma, actorUri, env);
            if (user) {
              recipients.push(user);
            }
          }
        } else {
          // Remote actor or collection - resolve via Fedify
          const user = await this.resolveActorUri(prisma, target, env);
          if (user) {
            recipients.push(user);
          }
        }
      }
    }

    // Handle 'bto' field (blind recipients for private posts)
    if (post.bto) {
      const btoRecipients = Array.isArray(post.bto) ? post.bto : [post.bto];
      for (const recipientUri of btoRecipients) {
        if (typeof recipientUri !== "string") continue;

        // Resolve actor URI to user
        const user = await this.resolveActorUri(prisma, recipientUri, env);
        if (user) {
          recipients.push(user);
        }
      }
    }

    // Remove duplicates
    const uniqueRecipients = Array.from(
      new Map(recipients.map((u) => [u.id, u])).values(),
    );

    return uniqueRecipients;
  }

  /**
   * Resolve actor URI to User
   * Returns null if actor is remote or not found
   */
  static async resolveActorUri(
    prisma: PrismaClient,
    actorUri: string,
    env: Env,
  ): Promise<User | null> {
    // Check if this is a local actor
    const baseUrl = getActivityPubBaseUrl(env);
    if (!actorUri.startsWith(baseUrl)) {
      // Remote actor - Fedify will handle fetching
      // For now, return null (remote actors handled separately)
      return null;
    }

    // Extract username from URI (format: https://example.com/users/{username})
    const match = actorUri.match(/\/users\/([^\/]+)/);
    if (!match) {
      return null;
    }

    const username = decodeURIComponent(match[1]);

    // Find user by username
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        actorUri: true,
        inboxUrl: true,
        suspended: true,
        deletionConfirmedAt: true,
      },
    });

    // Only return if user exists, has ActivityPub fields, and is not suspended/deleted
    if (
      user &&
      user.actorUri &&
      user.inboxUrl &&
      !user.suspended &&
      !user.deletionConfirmedAt
    ) {
      return user as User;
    }

    return null;
  }

  /**
   * Deliver activity to a recipient's inbox
   */
  static async deliverToInbox(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    recipient: User,
    env: Env,
    senderActorUri: string,
    logger?: Logger,
  ): Promise<void> {
    if (!recipient.inboxUrl || !recipient.actorUri) {
      if (logger) {
        logger.warn(
          `[DeliveryService] Recipient ${recipient.id} does not have ActivityPub fields set`,
        );
      }
      return;
    }

    // Use Fedify delivery service
    const success = await deliverActivityWithFedify(
      activity,
      recipient.inboxUrl,
      senderActorUri,
      env,
    );

    if (!success && logger) {
      logger.error(
        `[DeliveryService] Failed to deliver activity to ${recipient.actorUri}`,
      );
    }
  }

  /**
   * Deliver post activity to all recipients
   */
  static async deliverPost(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
    logger?: Logger,
  ): Promise<void> {
    // Get recipients based on audience
    const recipients = await this.getRecipients(
      prisma,
      post,
      author,
      env,
      requestUrl,
    );

    if (logger) {
      logger.info(
        `[DeliveryService] Delivering post ${post.id} to ${recipients.length} recipients`,
      );
    }

    // Get sender actor URI
    const senderActorUri = ActorService.getActorUri(author, env, requestUrl);

    // Deliver to each recipient using Fedify
    const deliveryPromises = recipients.map((recipient) =>
      this.deliverToInbox(
        prisma,
        activity,
        recipient,
        env,
        senderActorUri,
        logger,
      ).catch((error) => {
        if (logger) {
          logger.error(
            `[DeliveryService] Failed to deliver to ${recipient.id}:`,
            error,
          );
        }
        // Continue with other deliveries even if one fails
      }),
    );

    await Promise.allSettled(deliveryPromises);
  }
}
