/**
 * ActivityPub Direct Message Service (Fedify-Based)
 *
 * Handles creation and delivery of direct messages using Fedify's type-safe Create and Note types.
 * DMs use the `bto` (blind recipients) field for privacy.
 */

import { Create, Note } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import type { Env } from "../../../env.js";
import type { User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { UserActorDispatcher } from "../dispatchers/user-actor.js";
import { ActivityService } from "../activity-service.js";
import { getLogger, Logger } from "../../logger.js";
import { fedifyCreateToActivityStreams } from "./fedify-converters.js";

/**
 * Service for managing direct messages as Fedify ActivityPub activities
 */
export class DmServiceFedify {
  /**
   * Generate ActivityPub URIs for a direct message
   */
  static generateDmUris(
    dmId: string,
    env: Env,
    requestUrl?: string,
  ): {
    activityId: URL;
    objectId: URL;
  } {
    const baseUrl = getActivityPubBaseUrl(env, requestUrl);
    return {
      activityId: new URL(`${baseUrl}/messages/${dmId}/activity`),
      objectId: new URL(`${baseUrl}/messages/${dmId}`),
    };
  }

  /**
   * Create Fedify Note object for a direct message
   * Uses bto field for privacy (blind recipients)
   */
  static async createDmNote(
    dmId: string,
    sender: User,
    recipient: User,
    text: string,
    published: Date,
    env: Env,
    requestUrl?: string,
  ): Promise<Note> {
    const uris = this.generateDmUris(dmId, env, requestUrl);
    const senderActorUri = UserActorDispatcher.generateActorUri(
      sender.username || "",
      env,
    );
    const recipientActorUri = UserActorDispatcher.generateActorUri(
      recipient.username || "",
      env,
    );

    // Convert Date to Temporal.Instant for Fedify
    const publishedInstant = Temporal.Instant.from(published.toISOString());

    // Create Fedify Note object
    const note = new Note({
      id: uris.objectId,
      content: text.trim(),
      published: publishedInstant,
    });

    // Set attributedTo and bto fields after construction (Fedify types may not include these)
    (note as any).attributedTo = new URL(senderActorUri);
    (note as any).bto = [new URL(recipientActorUri)]; // Blind recipients - only recipient can see

    return note;
  }

  /**
   * Create Fedify Create activity for a direct message
   */
  static async createDmCreateActivity(
    dmId: string,
    sender: User,
    recipient: User,
    text: string,
    published: Date,
    env: Env,
    requestUrl?: string,
  ): Promise<Create> {
    const uris = this.generateDmUris(dmId, env, requestUrl);
    const senderActorUri = UserActorDispatcher.generateActorUri(
      sender.username || "",
      env,
    );
    const recipientActorUri = UserActorDispatcher.generateActorUri(
      recipient.username || "",
      env,
    );
    const note = await this.createDmNote(
      dmId,
      sender,
      recipient,
      text,
      published,
      env,
      requestUrl,
    );

    // Convert Date to Temporal.Instant for Fedify
    const publishedInstant = Temporal.Instant.from(published.toISOString());

    // Create Fedify Create activity
    const activity = new Create({
      id: uris.activityId,
      actor: new URL(senderActorUri),
      object: note,
      published: publishedInstant,
    });

    // Set bto field after construction (Fedify types may not include this)
    // No 'to' field - use bto for privacy
    (activity as any).bto = [new URL(recipientActorUri)];

    return activity;
  }

  /**
   * Create direct message and store in database and outbox
   */
  static async createDirectMessage(
    prisma: PrismaClient,
    sender: User,
    recipient: User,
    text: string,
    env: Env,
    requestUrl?: string,
    logger?: Logger,
  ): Promise<{
    id: string;
    senderId: string;
    recipientId: string;
    text: string;
    objectId: string;
    activityId: string;
    read: boolean;
    createdAt: Date;
  }> {
    const log = logger || getLogger();

    // Verify both users have ActivityPub fields
    if (!sender.actorUri || !sender.publicKey) {
      throw new Error("Sender does not have ActivityPub fields set");
    }
    if (!recipient.actorUri || !recipient.publicKey) {
      throw new Error("Recipient does not have ActivityPub fields set");
    }

    const published = new Date();
    const dmId = `dm_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const uris = this.generateDmUris(dmId, env, requestUrl);
    const activity = await this.createDmCreateActivity(
      dmId,
      sender,
      recipient,
      text,
      published,
      env,
      requestUrl,
    );

    // Create DM in database
    const dm = await prisma.directMessage.create({
      data: {
        senderId: sender.id,
        recipientId: recipient.id,
        text: text.trim(),
        objectId: uris.objectId.toString(),
        activityId: uris.activityId.toString(),
        read: false,
        createdAt: published,
      },
    });

    // Store activity in sender's outbox
    // Convert Fedify Create to ActivityStreamsActivity format for database storage
    const senderActorUri = UserActorDispatcher.generateActorUri(
      sender.username || "",
      env,
    );
    const note = await this.createDmNote(
      dmId,
      sender,
      recipient,
      text,
      published,
      env,
      requestUrl,
    );
    const activityStreamsFormat = fedifyCreateToActivityStreams(
      activity,
      note,
      senderActorUri,
      uris.activityId.toString(),
      uris.objectId.toString(),
    );
    await ActivityService.storeOutboxActivity(
      prisma,
      senderActorUri,
      activityStreamsFormat,
    );

    // Deliver to recipient's inbox
    try {
      const { DeliveryService } = await import("../delivery-service.js");
      await DeliveryService.deliverToInbox(
        prisma,
        activityStreamsFormat,
        recipient,
        env,
        senderActorUri,
        log,
      );
    } catch (error: any) {
      log.error(
        "[DmServiceFedify] Failed to deliver DM to recipient inbox:",
        error,
      );
      // Don't fail DM creation if delivery fails - it can be retried
    }

    log.debug("[DmServiceFedify] Created direct message", {
      dmId: dm.id,
      senderId: sender.id,
      recipientId: recipient.id,
    });

    return {
      id: dm.id,
      senderId: sender.id,
      recipientId: recipient.id,
      text: dm.text,
      objectId: dm.objectId!,
      activityId: dm.activityId!,
      read: dm.read,
      createdAt: dm.createdAt,
    };
  }
}
