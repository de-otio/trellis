/**
 * Group Service
 *
 * Handles ActivityPub actor functionality for private groups.
 * Groups are ActivityPub actors (type: "Group") with their own inbox/outbox and followers collection (members).
 */

import * as crypto from "crypto";
import type {
  PrismaClient,
  Group,
  GroupMember,
  User,
  GroupPrivacy,
  GroupRole,
} from "@prisma/client";
import { ActorService } from "./actor.js";
import { KeyPairService } from "./crypto.js";
import type { Env } from "../../env.js";

export class GroupService {
  /**
   * Generate ActivityPub actor URI for a group
   */
  static generateActorUri(
    groupId: string,
    env: Env,
    requestUrl?: string,
  ): string {
    const baseUrl = ActorService.getBaseUrl(env, requestUrl);
    return `${baseUrl}/groups/${groupId}`;
  }

  /**
   * Get actor URI from group
   */
  static getActorUri(group: Group, env: Env, requestUrl?: string): string {
    if (group.actorUri) {
      return group.actorUri;
    }

    // Generate if missing
    return this.generateActorUri(group.id, env, requestUrl);
  }

  /**
   * Generate collection URLs for a group actor
   */
  static generateCollectionUrls(actorUri: string): {
    inbox: string;
    outbox: string;
    followers: string;
  } {
    return {
      inbox: `${actorUri}/inbox`,
      outbox: `${actorUri}/outbox`,
      followers: `${actorUri}/followers`,
    };
  }

  /**
   * Create a new group with ActivityPub actor
   */
  static async createGroup(
    prisma: PrismaClient,
    name: string,
    description: string | null,
    privacy: GroupPrivacy,
    creator: User,
    env: Env,
    tenantId: string,
  ): Promise<Group> {
    if (!creator.actorUri) {
      throw new Error("Creator must have an actorUri");
    }

    // Generate actor URI
    const groupId = crypto.randomUUID();
    const actorUri = this.generateActorUri(groupId, env);
    const collections = this.generateCollectionUrls(actorUri);

    // Generate key pair
    const { publicKey, privateKey } = KeyPairService.generateKeyPair();
    const encryptedPrivateKey = KeyPairService.encryptPrivateKey(
      privateKey,
      env,
    );

    // Create group in database
    const group = await prisma.group.create({
      data: {
        id: groupId,
        name,
        description,
        actorUri: actorUri,
        inboxUrl: collections.inbox,
        outboxUrl: collections.outbox,
        followersUrl: collections.followers,
        publicKey,
        privateKey: encryptedPrivateKey,
        privacy,
        tenantId,
      },
    });

    // Add creator as admin member
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        actorUri: creator.actorUri,
        role: "ADMIN",
        tenantId,
      },
    });

    return group;
  }

  /**
   * Serialize group to ActivityStreams Actor document
   */
  static async serializeActor(
    group: Group,
    env: Env,
    requestUrl?: string,
  ): Promise<object> {
    const actorUri = this.getActorUri(group, env, requestUrl);
    const collections = this.generateCollectionUrls(actorUri);

    const actorDoc: any = {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        "https://w3id.org/security/v1",
        {
          trellis: "https://example.com/ns#",
        },
      ],
      type: "Group",
      id: actorUri,
      name: group.name,
      preferredUsername: group.id,
      inbox: collections.inbox,
      outbox: collections.outbox,
      followers: collections.followers,
    };

    // Add optional fields
    if (group.description) {
      actorDoc.summary = group.description;
    }

    // Add public key if available
    if (group.publicKey) {
      actorDoc.publicKey = {
        id: `${actorUri}#main-key`,
        owner: actorUri,
        publicKeyPem: group.publicKey,
      };
    }

    // Add custom Trellis extensions
    actorDoc["trellis:privacy"] = group.privacy.toLowerCase();

    return actorDoc;
  }

  /**
   * Initialize ActivityPub fields for a group
   */
  static async initializeActorFields(
    prisma: PrismaClient,
    group: Group,
    env: Env,
  ): Promise<Group> {
    // Generate actor URI
    const actorUri = this.generateActorUri(group.id, env);
    const collections = this.generateCollectionUrls(actorUri);

    // Generate key pair
    const { publicKey, privateKey } = KeyPairService.generateKeyPair();
    const encryptedPrivateKey = KeyPairService.encryptPrivateKey(
      privateKey,
      env,
    );

    // Update group with ActivityPub fields
    return await prisma.group.update({
      where: { id: group.id },
      data: {
        actorUri: actorUri,
        inboxUrl: collections.inbox,
        outboxUrl: collections.outbox,
        followersUrl: collections.followers,
        publicKey,
        privateKey: encryptedPrivateKey,
      },
    });
  }

  /**
   * Get group by actor URI
   */
  static async getGroupByActorUri(
    prisma: PrismaClient,
    actorUri: string,
  ): Promise<Group | null> {
    return await prisma.group.findUnique({
      where: { actorUri },
    });
  }

  /**
   * Get group by ID
   */
  static async getGroupById(
    prisma: PrismaClient,
    groupId: string,
  ): Promise<Group | null> {
    return await prisma.group.findUnique({
      where: { id: groupId },
    });
  }

  /**
   * Get members of a group
   */
  static async getMembers(
    prisma: PrismaClient,
    groupId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<GroupMember[]> {
    return await prisma.groupMember.findMany({
      where: {
        groupId,
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: {
        joinedAt: "desc",
      },
    });
  }

  /**
   * Get members count
   */
  static async getMembersCount(
    prisma: PrismaClient,
    groupId: string,
  ): Promise<number> {
    return await prisma.groupMember.count({
      where: {
        groupId,
      },
    });
  }

  /**
   * Get member actor URIs (for followers collection)
   */
  static async getMemberActorUris(
    prisma: PrismaClient,
    groupId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<string[]> {
    const members = await this.getMembers(prisma, groupId, page, limit);
    return members.map((member) => member.actorUri);
  }

  /**
   * Add member to group
   */
  static async addMember(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
    tenantId: string,
    role: GroupRole = "MEMBER",
  ): Promise<GroupMember> {
    return await prisma.groupMember.create({
      data: {
        groupId,
        actorUri,
        role,
        tenantId,
      },
    });
  }

  /**
   * Remove member from group
   */
  static async removeMember(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
  ): Promise<void> {
    await prisma.groupMember.deleteMany({
      where: {
        groupId,
        actorUri,
      },
    });
  }

  /**
   * Update member role
   */
  static async updateMemberRole(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
    role: GroupRole,
  ): Promise<GroupMember> {
    return await prisma.groupMember.update({
      where: {
        groupId_actorUri: {
          groupId,
          actorUri,
        },
      },
      data: {
        role,
      },
    });
  }

  /**
   * Get member role
   */
  static async getMemberRole(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
  ): Promise<GroupRole | null> {
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_actorUri: {
          groupId,
          actorUri,
        },
      },
      select: {
        role: true,
      },
    });

    return member?.role || null;
  }

  /**
   * Check if user is member of group
   */
  static async isMember(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
  ): Promise<boolean> {
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_actorUri: {
          groupId,
          actorUri,
        },
      },
    });

    return member !== null;
  }

  /**
   * Check if user is admin or moderator
   */
  static async isAdminOrModerator(
    prisma: PrismaClient,
    groupId: string,
    actorUri: string,
  ): Promise<boolean> {
    const role = await this.getMemberRole(prisma, groupId, actorUri);
    return role === "ADMIN" || role === "MODERATOR";
  }
}
