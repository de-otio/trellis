/**
 * Fedify Outbox Listener
 *
 * Handles retrieving ActivityPub activities from user outboxes.
 * Fedify will handle JSON-LD serialization and collection formatting.
 */

import type { Env } from "../../../env.js";
import { ActivityService } from "../activity-service.js";
import { getLogger, Logger } from "../../logger.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { detectRegionSync } from "../../region-detection.js";

/**
 * Get outbox activities
 *
 * Retrieves activities from a user's outbox and formats them as an OrderedCollection.
 * Fedify will handle JSON-LD serialization when fully integrated.
 *
 * @param request - Incoming request
 * @param env - Cloudflare Workers environment
 * @param username - Target username
 * @returns Response with OrderedCollection
 */
export async function getOutboxActivities(
  request: Request,
  env: Env,
  username: string,
): Promise<Response> {
  const logger = getLogger();

  try {
    // Parse pagination parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "20", 10),
      100,
    );

    // Get region and database
    const region = detectRegionSync(request, env);
    const dbManager = sharedDatabaseConnectionManager;

    // Get user by username
    const user = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return db.user.findUnique({
          where: { username },
          select: {
            id: true,
            username: true,
            actorUri: true,
          },
        });
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getUserByUsername",
          username,
        },
      },
    );

    if (!user || !user.actorUri) {
      logger.warn("[Fedify Outbox] User not found", { username });
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // Get outbox activities
    const activities = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return ActivityService.getOutboxActivities(
          db,
          user.actorUri!,
          page,
          limit,
        );
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getOutboxActivities",
          username,
        },
      },
    );

    const totalItems = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return ActivityService.getOutboxCount(db, user.actorUri!);
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "getOutboxCount",
          username,
        },
      },
    );

    // Convert activities to ActivityStreams format
    const orderedItems = activities.map((a) => ({
      type: a.type,
      actor: a.actorUri,
      object: a.objectId,
      target: a.targetId,
      to: a.to,
      cc: a.cc,
      bto: a.bto,
      bcc: a.bcc,
      published: a.published.toISOString(),
    }));

    // Format as OrderedCollection (ActivityPub standard)
    const collection = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "OrderedCollection",
      id: `${user.actorUri}/outbox`,
      totalItems,
      orderedItems,
    };

    return new Response(JSON.stringify(collection), {
      status: 200,
      headers: {
        "content-type": "application/activity+json",
      },
    });
  } catch (error) {
    logger.error("[Fedify Outbox] Error getting outbox activities", {
      error: (error as Error).message,
      username,
    });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
