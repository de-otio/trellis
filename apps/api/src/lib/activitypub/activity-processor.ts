/**
 * Activity Processor
 *
 * Processes incoming ActivityPub activities.
 * In Phase 1, this provides a basic structure that will be extended in later phases.
 */

import type { PrismaClient, User } from "@prisma/client";
import type { ActivityStreamsActivity } from "./activity-service.js";
import { getLogger, Logger } from "../logger.js";

export interface ActivityProcessorEnv {
  LOG_LEVEL?: string;
}

export class ActivityProcessor {
  /**
   * Process incoming activity
   */
  static async processActivity(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    env: ActivityProcessorEnv,
  ): Promise<void> {
    const logger = getLogger();

    switch (activity.type) {
      case "Create":
        await this.processCreate(prisma, activity, user, logger);
        break;
      case "Follow":
        await this.processFollow(prisma, activity, user, logger);
        break;
      case "Like":
        await this.processLike(prisma, activity, user, logger);
        break;
      case "Announce":
        await this.processAnnounce(prisma, activity, user, logger);
        break;
      case "Accept":
        await this.processAccept(prisma, activity, user, logger);
        break;
      case "Reject":
        await this.processReject(prisma, activity, user, logger);
        break;
      case "Undo":
        await this.processUndo(prisma, activity, user, logger);
        break;
      default:
        logger.warn(
          `[ActivityProcessor] Unknown activity type: ${activity.type}`,
          {
            activityType: activity.type,
            actorUri:
              typeof activity.actor === "string"
                ? activity.actor
                : (activity.actor as any)?.id,
          },
        );
    }
  }

  /**
   * Process Create activity (post or DM)
   * Phase 3: Handles DMs (activities with bto but no to field)
   */
  private static async processCreate(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;

    // Check if this is a DM (has bto but no to field)
    const hasBto =
      activity.bto &&
      (Array.isArray(activity.bto) ? activity.bto.length > 0 : !!activity.bto);
    const hasTo =
      activity.to &&
      (Array.isArray(activity.to) ? activity.to.length > 0 : !!activity.to);

    if (hasBto && !hasTo) {
      // This is a direct message
      await this.processDirectMessage(prisma, activity, user, logger);
      return;
    }

    // Art. 50 inbound provenance (analysis 06 §1). Extracted HERE, at the point
    // the object arrives, because the alternative is discovering later that the
    // marking was already gone.
    //
    // There is nowhere to persist it yet — regular-post ingestion is unimplemented
    // (see the Phase 2 note below), so this feeds observability instead: it is how
    // an operator learns whether remote instances actually send markings, which is
    // the evidence needed to prioritise the store. When ingestion lands, write
    // `remoteProvenance` onto the post and persist `unrecognised` untouched.
    //
    // `unrecognised` exists so we do not become the node that destroys other
    // people's markings: there is no settled vocabulary, so other implementations
    // will use terms we have never heard of, and dropping them silently is the
    // ingest-strip mistake one layer up.
    const { provenanceFromJsonLd, unknownProvenanceProperties } = await import(
      "./provenance-jsonld.js"
    );
    const remoteObject = activity.object;
    const remoteProvenance = provenanceFromJsonLd(remoteObject);
    const unrecognised = unknownProvenanceProperties(remoteObject);

    // Regular post processing (Phase 2+)
    logger.info("[ActivityProcessor] Processing Create activity", {
      activityId: activity.id,
      actorUri,
      // A recognised inbound marking. Null when the object carried none, or
      // carried only a HUMAN_CREATED claim — which we decline to honour, because
      // a peer server can put any JSON in an object and honouring it would let a
      // hostile instance stamp "this is a real photo" onto synthetic media.
      remoteProvenance: remoteProvenance?.sourceType ?? null,
      // Key names only, never values: the values are third-party content and this
      // is a log line, not a store.
      unrecognisedProvenanceKeys: Object.keys(unrecognised),
    });
    // Phase 2: Store post in database, add to user's feed, deliver to followers
    // — and when that lands, persist remoteProvenance + unrecognised with it.
  }

  /**
   * Process direct message
   * Phase 3: Store DM in database when received in inbox
   */
  private static async processDirectMessage(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;
    const recipientActorUri = user.actorUri;

    if (!recipientActorUri) {
      logger.warn(
        "[ActivityProcessor] User does not have actorUri, cannot process DM",
      );
      return;
    }

    // Verify recipient is in bto
    const bto = Array.isArray(activity.bto)
      ? activity.bto
      : activity.bto
        ? [activity.bto]
        : [];

    if (!bto.includes(recipientActorUri)) {
      logger.warn("[ActivityProcessor] DM received but recipient not in bto", {
        activityId: activity.id,
        recipientActorUri,
        bto,
      });
      return;
    }

    // Extract object (Note)
    const object = activity.object;
    if (!object || typeof object !== "object") {
      logger.warn("[ActivityProcessor] DM activity missing object");
      return;
    }

    const objectId = (object as any).id;
    const content = (object as any).content;

    if (!objectId || !content) {
      logger.warn("[ActivityProcessor] DM object missing id or content");
      return;
    }

    // Find sender by actor URI
    const sender = await prisma.user.findFirst({
      where: { actorUri },
      select: {
        id: true,
        actorUri: true,
      },
    });

    if (!sender) {
      logger.warn("[ActivityProcessor] DM sender not found", { actorUri });
      return;
    }

    // Check if DM already exists (idempotency)
    const existingDm = await prisma.directMessage.findFirst({
      where: {
        OR: [{ activityId: activity.id }, { objectId }],
      },
    });

    if (existingDm) {
      logger.info("[ActivityProcessor] DM already exists, skipping", {
        activityId: activity.id,
        dmId: existingDm.id,
      });
      return;
    }

    // Store DM in database
    try {
      await prisma.directMessage.create({
        data: {
          senderId: sender.id,
          recipientId: user.id,
          text: content,
          objectId,
          activityId: activity.id || undefined,
          read: false,
          // Trusting the remote `published` as `createdAt` is acceptable for a
          // DM (one recipient, no shared ordering). Do NOT copy this pattern
          // into post ingestion when processCreate/processAnnounce land: the
          // feed's declared order is `createdAt DESC` (feed-pagination.ts),
          // so a remote actor choosing `published` would choose its position
          // in every follower's chronological feed — future-dating pins to
          // the top. Posts take receive time as `createdAt` and keep the
          // author's claim in `Post.published` for display.
          createdAt: activity.published
            ? new Date(activity.published)
            : new Date(),
        },
      });

      logger.info("[ActivityProcessor] DM stored successfully", {
        activityId: activity.id,
        senderId: sender.id,
        recipientId: user.id,
      });
    } catch (error: any) {
      logger.error("[ActivityProcessor] Failed to store DM", {
        error: error.message,
        activityId: activity.id,
      });
      throw error;
    }
  }

  /**
   * Process Follow activity
   * Phase 2: Handles friend requests and regular follows
   */
  private static async processFollow(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;
    const targetUri =
      typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id;

    logger.info("[ActivityProcessor] Processing Follow activity", {
      activityId: activity.id,
      actorUri,
      targetUri,
    });

    if (!actorUri || !targetUri) {
      logger.warn(
        "[ActivityProcessor] Follow activity missing actor or object",
        {
          activityId: activity.id,
        },
      );
      return;
    }

    // Check if target is the current user (friend request)
    if (user.actorUri === targetUri) {
      await this.processFriendRequest(prisma, activity, user, actorUri, logger);
      return;
    }

    // Check if target is a group (group membership request)
    const targetGroup = await prisma.group.findUnique({
      where: { actorUri: targetUri },
      select: { id: true, actorUri: true, privacy: true, tenantId: true },
    });

    if (targetGroup) {
      await this.processGroupFollow(
        prisma,
        activity,
        user,
        actorUri,
        targetGroup,
        logger,
      );
      return;
    }

    // Regular follow (user following another user or dog profile)
    await this.processRegularFollow(
      prisma,
      activity,
      user,
      actorUri,
      targetUri,
      logger,
    );
  }

  /**
   * Process friend request (Follow activity targeting current user)
   */
  private static async processFriendRequest(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    requesterActorUri: string,
    logger: Logger,
  ): Promise<void> {
    if (!user.actorUri) {
      logger.warn(
        "[ActivityProcessor] User missing actorUri, cannot process friend request",
      );
      return;
    }

    // Get requester user
    const requester = await prisma.user.findUnique({
      where: { actorUri: requesterActorUri },
    });

    if (!requester) {
      logger.warn("[ActivityProcessor] Friend request from unknown actor", {
        requesterActorUri,
      });
      return;
    }

    // Create or update friendship (PENDING)
    const { FriendshipService } = await import("./friendship-service.js");
    await FriendshipService.createFriendship(
      prisma,
      requesterActorUri,
      user.actorUri,
      "PENDING",
    );

    logger.info("[ActivityProcessor] Friend request processed", {
      requesterActorUri,
      targetActorUri: user.actorUri,
    });

    // TODO: Send Accept activity automatically or wait for user acceptance
    // For now, friendship remains PENDING until manually accepted
  }

  /**
   * Process regular follow (user following another user or entity)
   */
  private static async processRegularFollow(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    followerActorUri: string,
    targetActorUri: string,
    logger: Logger,
  ): Promise<void> {
    // Check if target is a user
    const targetUser = await prisma.user.findUnique({
      where: { actorUri: targetActorUri },
    });

    if (targetUser) {
      // User following user - create Follow relationship
      const follower = await prisma.user.findUnique({
        where: { actorUri: followerActorUri },
      });

      if (!follower) {
        logger.warn("[ActivityProcessor] Follower not found", {
          followerActorUri,
        });
        return;
      }

      // TODO: redesign - use GraphService
      ({} as any);

      logger.info("[ActivityProcessor] Follow relationship created (stubbed)", {
        followerActorUri,
        targetActorUri,
      });

      // Send Accept back to the follower (required by AP spec)
      if (targetUser.actorUri && follower.actorUri) {
        await this.sendAcceptActivity(
          prisma,
          targetUser.actorUri,
          follower.actorUri,
          activity,
          logger,
        );
      }
    } else {
      // Check if target is an entity
      const targetEntity = await prisma.entity.findFirst({
        where: { actorUri: targetActorUri },
      });

      if (targetEntity) {
        // User following entity
        const follower = await prisma.user.findUnique({
          where: { actorUri: followerActorUri },
        });

        if (!follower) {
          logger.warn("[ActivityProcessor] Follower not found", {
            followerActorUri,
          });
          return;
        }

        // TODO: redesign - use GraphService
        ({} as any);

        // Send Accept back to the follower (required by AP spec)
        if (targetEntity.actorUri && follower.actorUri) {
          await this.sendAcceptActivity(
            prisma,
            targetEntity.actorUri,
            follower.actorUri,
            activity,
            logger,
          );
        }

        logger.info(
          "[ActivityProcessor] Entity follow relationship created",
          {
            followerActorUri,
            targetActorUri,
          },
        );
      } else {
        logger.warn("[ActivityProcessor] Follow target not found", {
          targetActorUri,
        });
      }
    }
  }

  /**
   * Process group Follow activity (group membership request)
   * Phase 3: Handles users joining groups via Follow activity
   */
  private static async processGroupFollow(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    actorUri: string,
    group: { id: string; actorUri: string; privacy: string; tenantId: string },
    logger: Logger,
  ): Promise<void> {
    // Check if user is already a member
    const existingMember = await prisma.groupMember.findUnique({
      where: {
        groupId_actorUri: {
          groupId: group.id,
          actorUri,
        },
      },
    });

    if (existingMember) {
      logger.info("[ActivityProcessor] User already a group member", {
        actorUri,
        groupId: group.id,
      });
      return;
    }

    // Check group privacy settings
    if (group.privacy === "PRIVATE") {
      // For private groups, membership requires approval
      // Store as pending (we'll need to add a status field or handle via Follow/Accept pattern)
      logger.info("[ActivityProcessor] Private group membership request", {
        actorUri,
        groupId: group.id,
      });
      // For now, we'll add them as MEMBER but in production you'd want a PENDING status
      // This can be handled via Accept/Reject activities later
    }

    // Add user as group member
    try {
      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          actorUri,
          role: "MEMBER",
          tenantId: group.tenantId,
        },
      });

      logger.info("[ActivityProcessor] User added to group", {
        actorUri,
        groupId: group.id,
      });

      // Send Accept activity back to requester (group accepts the follow)
      // Note: This should be done via DeliveryService in production
      // For now, we'll just log it
      logger.info("[ActivityProcessor] Group should send Accept activity", {
        groupId: group.id,
        requesterActorUri: actorUri,
      });
    } catch (error: any) {
      logger.error("[ActivityProcessor] Failed to add user to group", {
        error: error.message,
        actorUri,
        groupId: group.id,
      });
      throw error;
    }
  }

  /**
   * Process Like activity
   * Phase 2: Handles sentiment reactions via Like activities
   */
  private static async processLike(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;
    const objectId =
      typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id;

    if (!actorUri || !objectId) {
      logger.warn("[ActivityProcessor] Like activity missing actor or object", {
        activityId: activity.id,
      });
      return;
    }

    // Extract sentiment from activity (custom property)
    const sentiment = this.extractSentimentFromActivity(activity);

    // Find the post by objectId (post URI)
    const post = await prisma.post.findFirst({
      where: {
        OR: [
          { objectId },
          { activityId: objectId },
          { id: objectId.split("/").pop() || "" }, // Fallback: try to extract ID from URI
        ],
      },
      select: {
        id: true,
        objectId: true,
        authorId: true,
        tenantId: true,
      },
    });

    if (!post) {
      logger.warn("[ActivityProcessor] Like activity target post not found", {
        activityId: activity.id,
        objectId,
      });
      return;
    }

    // Find the actor (user who liked)
    const actor = await prisma.user.findUnique({
      where: { actorUri },
      select: { id: true },
    });

    if (!actor) {
      logger.warn("[ActivityProcessor] Like activity actor not found", {
        activityId: activity.id,
        actorUri,
      });
      return;
    }

    // Store sentiment reaction (upsert - one sentiment per post per user)
    try {
      await prisma.postSentiment.upsert({
        where: {
          postId_authorId: {
            postId: post.id,
            authorId: actor.id,
          },
        },
        create: {
          // Sentiment inherits the owning post's tenant.
          tenantId: post.tenantId,
          postId: post.id,
          postUri: objectId,
          authorId: actor.id,
          sentiment: sentiment || "love", // Default to 'love' if no sentiment specified
        },
        update: {
          sentiment: sentiment || "love", // Update sentiment if changed
        },
      });

      logger.info(
        "[ActivityProcessor] Like activity processed (sentiment reaction stored)",
        {
          activityId: activity.id,
          actorUri,
          postId: post.id,
          sentiment: sentiment || "love",
        },
      );
    } catch (error: any) {
      logger.error("[ActivityProcessor] Failed to store sentiment reaction", {
        error: error.message,
        activityId: activity.id,
        actorUri,
        postId: post.id,
      });
      throw error;
    }
  }

  /**
   * Extract sentiment from ActivityStreamsActivity
   * Supports both JSON-LD extension format and plain property format
   */
  private static extractSentimentFromActivity(
    activity: ActivityStreamsActivity,
  ): string | null {
    // Check for JSON-LD extension format: trellis:sentiment
    if ((activity as any)["trellis:sentiment"]) {
      const sentiment = (activity as any)["trellis:sentiment"];
      if (this.isValidSentiment(sentiment)) {
        return sentiment;
      }
    }

    // Check for plain sentiment property
    if ((activity as any).sentiment) {
      const sentiment = (activity as any).sentiment;
      if (this.isValidSentiment(sentiment)) {
        return sentiment;
      }
    }

    return null;
  }

  /**
   * Validate sentiment type
   */
  private static isValidSentiment(sentiment: string): boolean {
    const validSentiments = [
      "joy",
      "gratitude",
      "calm",
      "love",
      "hope",
      "compassion",
      "awe",
      "sadness",
      "anger",
      "fear",
      "insightful",
    ];
    return validSentiments.includes(sentiment);
  }

  /**
   * Process Announce activity (repost)
   * Phase 1: Basic structure - will be implemented in Phase 2
   */
  private static async processAnnounce(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    logger.info("[ActivityProcessor] Processing Announce activity", {
      activityId: activity.id,
      actorUri:
        typeof activity.actor === "string"
          ? activity.actor
          : (activity.actor as any)?.id,
    });
    // Phase 2: Store repost
  }

  /**
   * Process Accept activity
   * Phase 2: Handles friend request acceptance
   */
  private static async processAccept(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;

    logger.info("[ActivityProcessor] Processing Accept activity", {
      activityId: activity.id,
      actorUri,
    });

    const object = activity.object;

    if (!actorUri || !object) {
      logger.warn(
        "[ActivityProcessor] Accept activity missing actor or object",
        {
          activityId: activity.id,
        },
      );
      return;
    }

    // Extract the Follow activity from object
    const followActivity =
      typeof object === "object" && object !== null
        ? (object as ActivityStreamsActivity)
        : null;
    if (!followActivity || followActivity.type !== "Follow") {
      logger.warn(
        "[ActivityProcessor] Accept activity object is not a Follow activity",
        {
          activityId: activity.id,
        },
      );
      return;
    }

    const requesterActorUri =
      typeof followActivity.actor === "string"
        ? followActivity.actor
        : (followActivity.actor as any)?.id;
    const targetActorUri =
      typeof followActivity.object === "string"
        ? followActivity.object
        : (followActivity.object as any)?.id;

    if (!requesterActorUri || !targetActorUri) {
      logger.warn(
        "[ActivityProcessor] Accept activity Follow object missing actor or object",
        {
          activityId: activity.id,
        },
      );
      return;
    }

    // Verify that the current user is accepting the friend request
    if (user.actorUri !== targetActorUri) {
      logger.warn(
        "[ActivityProcessor] Accept activity target does not match current user",
        {
          userActorUri: user.actorUri,
          targetActorUri,
        },
      );
      return;
    }

    // Accept the friendship
    const { FriendshipService } = await import("./friendship-service.js");
    await FriendshipService.acceptFriendship(
      prisma,
      requesterActorUri,
      targetActorUri,
    );

    logger.info("[ActivityProcessor] Friend request accepted", {
      requesterActorUri,
      targetActorUri,
    });
  }

  /**
   * Process Reject activity
   * Phase 1: Basic structure - will be implemented in Phase 2
   */
  private static async processReject(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    logger.info("[ActivityProcessor] Processing Reject activity", {
      activityId: activity.id,
      actorUri:
        typeof activity.actor === "string"
          ? activity.actor
          : (activity.actor as any)?.id,
    });
    // Phase 2: Handle follow request rejection
  }

  /**
   * Process Undo activity
   * Phase 1: Basic structure - will be implemented in Phase 2
   */
  private static async processUndo(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    user: User,
    logger: Logger,
  ): Promise<void> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;

    logger.info("[ActivityProcessor] Processing Undo activity", {
      activityId: activity.id,
      actorUri,
    });

    const innerObject = activity.object;
    const innerType =
      typeof innerObject === "string"
        ? null
        : (innerObject as any)?.type;

    if (innerType === "Follow") {
      await this.processUndoFollow(prisma, activity, actorUri, logger);
    } else {
      logger.warn("[ActivityProcessor] Unsupported Undo target type", {
        innerType,
        activityId: activity.id,
      });
    }
  }

  /**
   * Process Undo(Follow) — remote user unfollowed a local user or entity
   */
  private static async processUndoFollow(
    prisma: PrismaClient,
    activity: ActivityStreamsActivity,
    followerActorUri: string | undefined,
    logger: Logger,
  ): Promise<void> {
    if (!followerActorUri) return;

    const innerObject = activity.object as any;
    const targetUri =
      typeof innerObject?.object === "string"
        ? innerObject.object
        : innerObject?.object?.id;

    if (!targetUri) {
      logger.warn("[ActivityProcessor] Undo(Follow) missing target URI");
      return;
    }

    const follower = await prisma.user.findUnique({
      where: { actorUri: followerActorUri },
    });
    if (!follower) return;

    // Try user target
    const targetUser = await prisma.user.findUnique({
      where: { actorUri: targetUri },
    });

    if (targetUser) {
      // TODO: redesign - use GraphService
      ({} as any);
      logger.info("[ActivityProcessor] Undo(Follow) user processed (stubbed)", {
        followerActorUri,
        targetUri,
      });
      return;
    }

    // Try entity target
    const targetEntity = await prisma.entity.findFirst({
      where: { actorUri: targetUri },
    });

    if (targetEntity) {
      // TODO: redesign - use GraphService
      ({} as any);
      logger.info("[ActivityProcessor] Undo(Follow) entity processed (stubbed)", {
        followerActorUri,
        targetUri,
      });
      return;
    }

    logger.warn("[ActivityProcessor] Undo(Follow) target not found", {
      targetUri,
    });
  }

  /**
   * Send an Accept activity back to confirm a follow.
   * Required by the ActivityPub spec.
   */
  private static async sendAcceptActivity(
    prisma: PrismaClient,
    targetActorUri: string,
    followerActorUri: string,
    originalActivity: ActivityStreamsActivity,
    logger: Logger,
  ): Promise<void> {
    try {
      const { ActivityService } = await import("./activity-service.js");
      await ActivityService.storeOutboxActivity(prisma, targetActorUri, {
        type: "Accept",
        actor: targetActorUri,
        object: originalActivity,
        to: [followerActorUri],
        published: new Date().toISOString(),
      });

      logger.info("[ActivityProcessor] Accept activity stored", {
        targetActorUri,
        followerActorUri,
      });

      // Delivery to follower's inbox happens via federation outbox worker
    } catch (error) {
      logger.error("[ActivityProcessor] Failed to send Accept", {
        error: (error as Error).message,
        targetActorUri,
        followerActorUri,
      });
    }
  }
}
