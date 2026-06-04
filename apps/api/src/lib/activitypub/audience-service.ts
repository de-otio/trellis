/**
 * ActivityPub Custom Audience Service
 *
 * Handles creation and management of custom audiences for fine-grained post targeting.
 * Custom audiences are ActivityStreams OrderedCollections that can be used in post `to` fields.
 */

import type { Env } from "../../env.js";
import type { User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { OrderedCollection } from "@fedify/fedify/vocab";
import { Logger } from "../logger.js";
import { getActivityPubBaseUrl } from "./fedify/context.js";
import { UserActorDispatcher } from "./dispatchers/user-actor.js";

/**
 * Service for managing custom audiences
 */
export class CustomAudienceService {
  /**
   * Generate collection URI for a custom audience
   */
  static generateCollectionUri(
    audienceId: string,
    env: Env,
    requestUrl?: string,
  ): string {
    const baseUrl = getActivityPubBaseUrl(env, requestUrl);
    return `${baseUrl}/audiences/${audienceId}`;
  }

  /**
   * Create a custom audience
   */
  static async createAudience(
    prisma: PrismaClient,
    creator: User,
    name: string,
    memberIds: string[],
    env: Env,
    requestUrl?: string,
  ): Promise<{
    id: string;
    name: string;
    creatorId: string;
    collectionId: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    // Verify creator has ActivityPub fields
    if (!creator.actorUri || !creator.publicKey) {
      throw new Error("Creator does not have ActivityPub fields set");
    }

    // Validate name
    if (!name || name.trim().length === 0) {
      throw new Error("Audience name is required");
    }

    if (name.length > 100) {
      throw new Error("Audience name must be 100 characters or less");
    }

    // Validate member IDs
    if (memberIds.length === 0) {
      throw new Error("Audience must have at least one member");
    }

    if (memberIds.length > 1000) {
      throw new Error("Audience cannot have more than 1000 members");
    }

    // Verify all members exist and have ActivityPub fields
    const members = await prisma.user.findMany({
      where: {
        id: { in: memberIds },
        actorUri: { not: null },
        publicKey: { not: null },
        suspended: false,
        deletionConfirmedAt: null, // User not deleted
      },
      select: {
        id: true,
      },
    });

    if (members.length !== memberIds.length) {
      throw new Error(
        "Some members not found or not configured for ActivityPub",
      );
    }

    // Create audience
    const audience = await prisma.customAudience.create({
      data: {
        name: name.trim(),
        creatorId: creator.id,
        collectionId: "", // Will be set after creation
      },
    });

    // Generate collection URI
    const collectionId = this.generateCollectionUri(
      audience.id,
      env,
      requestUrl,
    );

    // Update with collection ID
    const updatedAudience = await prisma.customAudience.update({
      where: { id: audience.id },
      data: { collectionId },
    });

    // Add members
    if (memberIds.length > 0) {
      await prisma.customAudienceMember.createMany({
        data: memberIds.map((memberId) => ({
          audienceId: audience.id,
          memberId,
        })),
        skipDuplicates: true,
      });
    }

    return {
      id: updatedAudience.id,
      name: updatedAudience.name,
      creatorId: updatedAudience.creatorId,
      collectionId: updatedAudience.collectionId,
      createdAt: updatedAudience.createdAt,
      updatedAt: updatedAudience.updatedAt,
    };
  }

  /**
   * Get audience members (as actor URIs)
   */
  static async getMembers(
    prisma: PrismaClient,
    audienceId: string,
    env: Env,
    requestUrl?: string,
  ): Promise<string[]> {
    const audience = await prisma.customAudience.findUnique({
      where: { id: audienceId },
      include: {
        members: {
          include: {
            member: {
              select: {
                id: true,
                actorUri: true,
                username: true,
              },
            },
          },
        },
      },
    });

    if (!audience) {
      return [];
    }

    // Convert member IDs to actor URIs
    return audience.members
      .map((m) => {
        if (!m.member.actorUri || !m.member.username) return null;
        return UserActorDispatcher.generateActorUri(m.member.username, env);
      })
      .filter((uri): uri is string => uri !== null);
  }

  /**
   * Add member to audience
   */
  static async addMember(
    prisma: PrismaClient,
    audienceId: string,
    memberId: string,
  ): Promise<void> {
    // Verify member exists and has ActivityPub fields
    const member = await prisma.user.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        actorUri: true,
        publicKey: true,
        suspended: true,
        deletionConfirmedAt: true,
      },
    });

    if (!member || !member.actorUri || !member.publicKey) {
      throw new Error("Member not found or not configured for ActivityPub");
    }

    if (member.suspended || member.deletionConfirmedAt) {
      throw new Error("Cannot add suspended or deleted user to audience");
    }

    // Add member (skip if already exists)
    await prisma.customAudienceMember
      .create({
        data: {
          audienceId,
          memberId,
        },
      })
      .catch((error: any) => {
        // Ignore unique constraint violation (member already in audience)
        if (error.code !== "P2002") {
          throw error;
        }
      });
  }

  /**
   * Remove member from audience
   */
  static async removeMember(
    prisma: PrismaClient,
    audienceId: string,
    memberId: string,
  ): Promise<void> {
    await prisma.customAudienceMember.deleteMany({
      where: {
        audienceId,
        memberId,
      },
    });
  }

  /**
   * Create Fedify OrderedCollection for a custom audience
   */
  static async createOrderedCollection(
    prisma: PrismaClient,
    audienceId: string,
    env: Env,
    requestUrl?: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<OrderedCollection> {
    const audience = await prisma.customAudience.findUnique({
      where: { id: audienceId },
      include: {
        members: {
          include: {
            member: {
              select: {
                id: true,
                actorUri: true,
                username: true,
              },
            },
          },
          orderBy: { addedAt: "asc" },
          skip: (page - 1) * limit,
          take: limit + 1,
        },
      },
    });

    if (!audience || !audience.collectionId) {
      throw new Error("Audience not found");
    }

    const totalItems = await prisma.customAudienceMember.count({
      where: { audienceId },
    });

    // Get member actor URIs
    const hasMore = audience.members.length > limit;
    const items = hasMore ? audience.members.slice(0, limit) : audience.members;
    const orderedItems = items
      .map((m) => {
        if (!m.member.actorUri || !m.member.username) return null;
        return new URL(
          UserActorDispatcher.generateActorUri(m.member.username, env),
        );
      })
      .filter((uri): uri is URL => uri !== null);

    // Create Fedify OrderedCollection
    const collection = new OrderedCollection({
      id: new URL(audience.collectionId),
      totalItems,
    });

    // Add ordered items
    (collection as any).orderedItems = orderedItems;

    // Add pagination if needed
    if (totalItems > limit) {
      const firstPageUrl = new URL(audience.collectionId);
      firstPageUrl.searchParams.set("page", "1");
      (collection as any).first = firstPageUrl;
    }

    return collection;
  }

  /**
   * Resolve audience collection URI to member actor URIs
   * Used by DeliveryService to deliver posts to custom audiences
   */
  static async resolveCollection(
    prisma: PrismaClient,
    collectionUri: string,
    env: Env,
    requestUrl?: string,
  ): Promise<string[]> {
    // Extract audience ID from URI
    const match = collectionUri.match(/\/audiences\/([^\/\?]+)/);
    if (!match) {
      return [];
    }

    const audienceId = match[1];

    // Get all members (no pagination for delivery)
    return this.getMembers(prisma, audienceId, env, requestUrl);
  }
}
