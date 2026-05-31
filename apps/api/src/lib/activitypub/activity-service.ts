/**
 * Activity Service
 *
 * Handles storage and retrieval of ActivityPub activities in inbox/outbox.
 */

import type { PrismaClient, Activity } from "@prisma/client";

export interface ActivityStreamsActivity {
  "@context"?: string | string[];
  type: string;
  id?: string;
  actor: string | object;
  object?: string | object;
  target?: string | object;
  to?: string | string[];
  cc?: string | string[];
  bto?: string | string[];
  bcc?: string | string[];
  published?: string;
  [key: string]: any;
}

export class ActivityService {
  /**
   * Store activity in inbox
   */
  static async storeInboxActivity(
    prisma: PrismaClient,
    inboxActorUri: string,
    activity: ActivityStreamsActivity,
  ): Promise<Activity> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id || "";
    const objectId = activity.object
      ? typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id
      : null;
    const targetId = activity.target
      ? typeof activity.target === "string"
        ? activity.target
        : (activity.target as any)?.id
      : null;

    const published = activity.published
      ? new Date(activity.published)
      : new Date();

    return await prisma.activity.create({
      data: {
        actorUri,
        type: activity.type,
        objectId: objectId || undefined,
        targetId: targetId || undefined,
        to: activity.to
          ? Array.isArray(activity.to)
            ? activity.to
            : [activity.to]
          : undefined,
        cc: activity.cc
          ? Array.isArray(activity.cc)
            ? activity.cc
            : [activity.cc]
          : undefined,
        bto: activity.bto
          ? Array.isArray(activity.bto)
            ? activity.bto
            : [activity.bto]
          : undefined,
        bcc: activity.bcc
          ? Array.isArray(activity.bcc)
            ? activity.bcc
            : [activity.bcc]
          : undefined,
        published,
        inboxActorUri,
        receivedAt: new Date(),
      },
    });
  }

  /**
   * Store activity in outbox
   */
  static async storeOutboxActivity(
    prisma: PrismaClient,
    outboxActorUri: string,
    activity: ActivityStreamsActivity,
  ): Promise<Activity> {
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id || "";
    const objectId = activity.object
      ? typeof activity.object === "string"
        ? activity.object
        : (activity.object as any)?.id
      : null;
    const targetId = activity.target
      ? typeof activity.target === "string"
        ? activity.target
        : (activity.target as any)?.id
      : null;

    const published = activity.published
      ? new Date(activity.published)
      : new Date();

    return await prisma.activity.create({
      data: {
        actorUri,
        type: activity.type,
        objectId: objectId || undefined,
        targetId: targetId || undefined,
        to: activity.to
          ? Array.isArray(activity.to)
            ? activity.to
            : [activity.to]
          : undefined,
        cc: activity.cc
          ? Array.isArray(activity.cc)
            ? activity.cc
            : [activity.cc]
          : undefined,
        bto: activity.bto
          ? Array.isArray(activity.bto)
            ? activity.bto
            : [activity.bto]
          : undefined,
        bcc: activity.bcc
          ? Array.isArray(activity.bcc)
            ? activity.bcc
            : [activity.bcc]
          : undefined,
        published,
        outboxActorUri,
      },
    });
  }

  /**
   * Get outbox activities (paginated)
   */
  static async getOutboxActivities(
    prisma: PrismaClient,
    actorUri: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<Activity[]> {
    return await prisma.activity.findMany({
      where: {
        outboxActorUri: actorUri,
      },
      orderBy: {
        published: "desc",
      },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Get outbox count
   */
  static async getOutboxCount(
    prisma: PrismaClient,
    actorUri: string,
  ): Promise<number> {
    return await prisma.activity.count({
      where: {
        outboxActorUri: actorUri,
      },
    });
  }

  /**
   * Get inbox activities (paginated)
   */
  static async getInboxActivities(
    prisma: PrismaClient,
    actorUri: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<Activity[]> {
    return await prisma.activity.findMany({
      where: {
        inboxActorUri: actorUri,
      },
      orderBy: {
        receivedAt: "desc",
      },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Get inbox count
   */
  static async getInboxCount(
    prisma: PrismaClient,
    actorUri: string,
  ): Promise<number> {
    return await prisma.activity.count({
      where: {
        inboxActorUri: actorUri,
      },
    });
  }
}
