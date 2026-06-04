/**
 * ActivityPub Post Service (Fedify-Based)
 *
 * Handles conversion of posts to ActivityPub Create activities and Note objects using Fedify.
 * This provides type-safe activity creation with automatic JSON-LD serialization.
 */

import { Create, Update, Note, PUBLIC_COLLECTION } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import type { Env } from "../../../env.js";
import type { Post, User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { UserActorDispatcher } from "../dispatchers/user-actor.js";
import { ActivityService } from "../activity-service.js";
import { getLogger, Logger } from "../../logger.js";
import { fedifyCreateToActivityStreams } from "./fedify-converters.js";

/**
 * Service for managing posts as Fedify ActivityPub activities
 */
export class PostActivityServiceFedify {
  /**
   * Generate ActivityPub URIs for a post
   */
  static generatePostUris(
    postId: string,
    env: Env,
    requestUrl?: string,
  ): {
    activityId: URL;
    objectId: URL;
  } {
    const baseUrl = getActivityPubBaseUrl(env, requestUrl);
    return {
      activityId: new URL(`${baseUrl}/posts/${postId}/activity`),
      objectId: new URL(`${baseUrl}/posts/${postId}`),
    };
  }

  /**
   * Determine audience targeting for a post based on visibility
   * Returns Fedify Recipient objects (URLs or collections)
   */
  static async determineAudience(
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
    customAudienceId?: string,
  ): Promise<{
    to?: (URL | string)[];
    cc?: (URL | string)[];
    bto?: (URL | string)[];
    bcc?: (URL | string)[];
  }> {
    // If post already has 'to' field (e.g., from custom audience), use it
    if (post.to && Array.isArray(post.to) && post.to.length > 0) {
      return {
        to: post.to.map((uri) => new URL(String(uri))),
        cc: post.cc
          ? (Array.isArray(post.cc) ? post.cc : [post.cc]).map(
              (uri) => new URL(String(uri)),
            )
          : undefined,
        bto: post.bto
          ? (Array.isArray(post.bto) ? post.bto : [post.bto]).map(
              (uri) => new URL(String(uri)),
            )
          : undefined,
        bcc: post.bcc
          ? (Array.isArray(post.bcc) ? post.bcc : [post.bcc]).map(
              (uri) => new URL(String(uri)),
            )
          : undefined,
      };
    }

    // If custom audience ID provided, resolve to collection URI
    if (customAudienceId) {
      const { CustomAudienceService } = await import("../audience-service.js");
      const collectionId = CustomAudienceService.generateCollectionUri(
        customAudienceId,
        env,
        requestUrl,
      );
      return {
        to: [new URL(collectionId)],
      };
    }

    const actorUri = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );

    switch (post.radius) {
      case "SHOUT":
        return {
          to: [PUBLIC_COLLECTION],
        };

      case "NORMAL":
        return {
          to: [new URL(`${actorUri}/followers`)],
        };

      case "WHISPER":
        // Whisper = private/friends-only, use bto (blind recipients)
        return {
          bto: [], // Will be populated based on post recipients if needed
        };

      default:
        // Default to public
        return {
          to: [PUBLIC_COLLECTION],
        };
    }
  }

  /**
   * Create Fedify Note object from post
   */
  static async createNote(
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
    customAudienceId?: string,
  ): Promise<Note> {
    const uris = this.generatePostUris(post.id, env, requestUrl);
    const actorUri = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );
    const audience = await this.determineAudience(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );
    const published = post.published || post.createdAt;

    // Convert Date to Temporal.Instant for Fedify
    const publishedInstant = Temporal.Instant.from(published.toISOString());

    // Create Fedify Note object
    const note = new Note({
      id: uris.objectId,
      content: post.text || "",
      published: publishedInstant,
    });

    // Add attributedTo and audience fields (Fedify types may not include these)
    (note as any).attributedTo = new URL(actorUri);
    if (audience.to && audience.to.length > 0) {
      (note as any).to = audience.to;
    }
    if (audience.cc && audience.cc.length > 0) {
      (note as any).cc = audience.cc;
    }
    if (audience.bto && audience.bto.length > 0) {
      (note as any).bto = audience.bto;
    }
    if (audience.bcc && audience.bcc.length > 0) {
      (note as any).bcc = audience.bcc;
    }

    return note;
  }

  /**
   * Create Fedify Create activity for a post
   */
  static async createCreateActivity(
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
    customAudienceId?: string,
  ): Promise<Create> {
    const uris = this.generatePostUris(post.id, env, requestUrl);
    const actorUri = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );
    const audience = await this.determineAudience(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );
    const published = post.published || post.createdAt;
    const note = await this.createNote(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );

    // Convert Date to Temporal.Instant for Fedify
    const publishedInstant = Temporal.Instant.from(published.toISOString());

    // Create Fedify Create activity
    const activity = new Create({
      id: uris.activityId,
      actor: new URL(actorUri),
      object: note,
      published: publishedInstant,
    });

    // Add audience fields (Fedify types may not include these)
    if (audience.to && audience.to.length > 0) {
      (activity as any).to = audience.to;
    }
    if (audience.cc && audience.cc.length > 0) {
      (activity as any).cc = audience.cc;
    }
    if (audience.bto && audience.bto.length > 0) {
      (activity as any).bto = audience.bto;
    }
    if (audience.bcc && audience.bcc.length > 0) {
      (activity as any).bcc = audience.bcc;
    }

    return activity;
  }

  /**
   * Create post activity and store in database and outbox
   */
  static async createPostActivity(
    prisma: PrismaClient,
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
    customAudienceId?: string,
  ): Promise<Create> {
    const logger = getLogger();
    const uris = this.generatePostUris(post.id, env, requestUrl);
    const audience = await this.determineAudience(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );
    const published = post.published || post.createdAt;

    // Create note first (needed for both activity and conversion)
    const note = await this.createNote(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );
    const activity = await this.createCreateActivity(
      post,
      author,
      env,
      requestUrl,
      customAudienceId,
    );

    // Convert audience URLs to strings for database storage
    const toStrings = audience.to?.map((r) =>
      typeof r === "string" ? r : r.toString(),
    );
    const ccStrings = audience.cc?.map((r) =>
      typeof r === "string" ? r : r.toString(),
    );
    const btoStrings = audience.bto?.map((r) =>
      typeof r === "string" ? r : r.toString(),
    );
    const bccStrings = audience.bcc?.map((r) =>
      typeof r === "string" ? r : r.toString(),
    );

    // Update post with ActivityPub fields
    await prisma.post.update({
      where: { id: post.id },
      data: {
        activityId: uris.activityId.toString(),
        objectId: uris.objectId.toString(),
        to: toStrings || undefined,
        cc: ccStrings || undefined,
        bto: btoStrings || undefined,
        bcc: bccStrings || undefined,
        published: published,
      },
    });

    // Store activity in author's outbox
    // Convert Fedify Create to ActivityStreamsActivity format for database storage
    // Note: We need to pass IDs explicitly since Fedify doesn't expose properties directly
    const actorUri = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );
    const activityStreamsFormat = fedifyCreateToActivityStreams(
      activity,
      note,
      actorUri,
      uris.activityId.toString(),
      uris.objectId.toString(),
    );
    await ActivityService.storeOutboxActivity(
      prisma,
      actorUri,
      activityStreamsFormat,
    );

    logger.debug("[PostActivityServiceFedify] Created post activity", {
      postId: post.id,
      activityId: uris.activityId.toString(),
    });

    return activity;
  }

  /**
   * Create Fedify Update activity for an edited post
   */
  static async createUpdateActivity(
    prisma: PrismaClient,
    post: Post,
    author: User,
    env: Env,
    requestUrl?: string,
  ): Promise<Update> {
    const logger = getLogger();
    const uris = this.generatePostUris(post.id, env, requestUrl);
    const actorUri = UserActorDispatcher.generateActorUri(
      author.username || "",
      env,
    );
    const audience = await this.determineAudience(
      post,
      author,
      env,
      requestUrl,
    );
    const updated = post.editedAt || post.updatedAt;
    const note = await this.createNote(post, author, env, requestUrl);

    // Convert Date to Temporal.Instant for Fedify
    const updatedInstant = Temporal.Instant.from(updated.toISOString());

    // Create Fedify Update activity
    const activity = new Update({
      id: new URL(`${uris.activityId.toString()}/update/${Date.now()}`),
      actor: new URL(actorUri),
      object: note,
      published: updatedInstant,
    });

    // Add audience fields
    if (audience.to && audience.to.length > 0) {
      (activity as any).to = audience.to;
    }
    if (audience.cc && audience.cc.length > 0) {
      (activity as any).cc = audience.cc;
    }
    if (audience.bto && audience.bto.length > 0) {
      (activity as any).bto = audience.bto;
    }
    if (audience.bcc && audience.bcc.length > 0) {
      (activity as any).bcc = audience.bcc;
    }

    // Store activity in author's outbox
    const activityStreamsFormat = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Update",
      id: activity.id?.toString(),
      actor: actorUri,
      object: {
        type: "Note",
        id: uris.objectId.toString(),
        content: post.text || "",
        attributedTo: actorUri,
        published: (post.published || post.createdAt).toISOString(),
        updated: updated.toISOString(),
        to: audience.to?.map((r) => (typeof r === "string" ? r : r.toString())),
        cc: audience.cc?.map((r) => (typeof r === "string" ? r : r.toString())),
      },
      published: updated.toISOString(),
      to: audience.to?.map((r) => (typeof r === "string" ? r : r.toString())),
      cc: audience.cc?.map((r) => (typeof r === "string" ? r : r.toString())),
    };

    await ActivityService.storeOutboxActivity(
      prisma,
      actorUri,
      activityStreamsFormat,
    );

    logger.debug("[PostActivityServiceFedify] Created update activity", {
      postId: post.id,
      activityId: activity.id?.toString(),
    });

    return activity;
  }
}
