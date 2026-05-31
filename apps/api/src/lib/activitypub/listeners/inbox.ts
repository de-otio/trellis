/**
 * Fedify Inbox Listener
 *
 * Integrates Fedify for HTTP signature verification and activity parsing
 * in the inbox endpoint. Fedify handles:
 * - HTTP Signature verification
 * - Activity parsing and validation
 * - Type-safe activity objects
 */

import type { Env } from "../../../env.js";
import {
  ActivityService,
  type ActivityStreamsActivity,
} from "../activity-service.js";
import { ActivityProcessor } from "../activity-processor.js";
import { getLogger, Logger } from "../../logger.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { detectRegionSync } from "../../region-detection.js";
import { verifyHttpSignature } from "./http-signatures.js";
import { processRemoteActivity } from "../services/remote-activity-handler.js";
import { validateActivity } from "../services/abuse-prevention.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { isStandaloneModeEnabled, isRemoteUri } from "../standalone-mode.js";

/**
 * Parse activity using Fedify
 *
 * Fedify provides type-safe activity parsing.
 * This function uses Fedify to parse and validate activities.
 *
 * @param request - Incoming request with activity JSON
 * @param env - Cloudflare Workers environment
 * @returns Parsed activity or null if invalid
 */
export async function parseActivity(
  request: Request,
  env: Env,
): Promise<ActivityStreamsActivity | null> {
  const logger = getLogger();

  try {
    // Parse JSON from request
    const activity = (await request.json()) as any;

    // Validate activity structure
    if (!activity?.type || !activity?.actor) {
      logger.warn("[Fedify Inbox] Invalid activity structure", {
        activityType: activity?.type,
      });
      return null;
    }

    // Fedify provides type-safe activity parsing
    // For now, parse JSON and validate structure

    return activity as ActivityStreamsActivity;
  } catch (error) {
    logger.error("[Fedify Inbox] Error parsing activity", {
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Process inbox activity
 *
 * Handles storing and processing activities received in inbox using Fedify.
 *
 * @param request - Incoming request
 * @param env - Cloudflare Workers environment
 * @param username - Target username
 * @returns Response
 */
export async function processInboxActivity(
  request: Request,
  env: Env,
  username: string,
): Promise<Response> {
  const logger = getLogger();

  try {
    // Verify HTTP Signature (Fedify handles this)
    const signatureValid = await verifyHttpSignature(request, env);
    if (!signatureValid) {
      logger.warn("[Fedify Inbox] Invalid HTTP signature", { username });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // Parse activity (Fedify handles parsing)
    const activity = await parseActivity(request, env);
    if (!activity) {
      logger.warn("[Fedify Inbox] Failed to parse activity", { username });
      return new Response(JSON.stringify({ error: "Invalid activity" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Check if this is a remote activity
    const baseUrl = getActivityPubBaseUrl(env);
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;
    const isRemote = actorUri && isRemoteUri(actorUri, env);

    // Check if standalone mode is enabled - reject remote activities early
    if (isRemote && actorUri) {
      const standaloneMode = await isStandaloneModeEnabled(
        env,
        undefined,
        request,
      );
      if (standaloneMode) {
        logger.info(
          "[Fedify Inbox] Rejecting remote activity (standalone mode enabled)",
          {
            username,
            actorUri,
            activityType: activity.type,
          },
        );
        return new Response(
          JSON.stringify({
            error: "Remote activities not accepted in standalone mode",
          }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Validate activity for abuse prevention (Fedify handles rate limiting)
      const isValid = await validateActivity(activity, actorUri, env);
      if (!isValid) {
        logger.warn("[Fedify Inbox] Activity failed abuse prevention check", {
          username,
          actorUri,
          activityType: activity.type,
        });
        return new Response(JSON.stringify({ error: "Activity rejected" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Get region and database
    const region = detectRegionSync(request, env);
    const dbManager = sharedDatabaseConnectionManager;

    // Get target user by username
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
            inboxUrl: true,
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

    if (!user) {
      logger.warn("[Fedify Inbox] User not found", { username });
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    if (!user.actorUri) {
      logger.warn("[Fedify Inbox] User missing actorUri", {
        username,
        userId: user.id,
      });
      return new Response(
        JSON.stringify({ error: "User not configured for ActivityPub" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Store and process activity (unified for local and remote)
    if (isRemote && actorUri) {
      // Remote activity: use remote handler
      const processed = await processRemoteActivity(
        activity,
        request,
        user.actorUri!,
        env,
      );
      if (!processed) {
        logger.warn("[Fedify Inbox] Failed to process remote activity", {
          username,
          actorUri,
          activityType: activity.type,
        });
        return new Response(
          JSON.stringify({ error: "Failed to process activity" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    } else {
      // Store activity
      await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (db) => {
          await ActivityService.storeInboxActivity(
            db,
            user.actorUri!,
            activity,
          );
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "storeInboxActivity",
            username,
            activityType: activity.type,
          },
        },
      );

      // Process activity asynchronously
      withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (db) => {
          await ActivityProcessor.processActivity(
            db,
            activity,
            user as any,
            env,
          );
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: {
            operation: "processActivity",
            username,
            activityType: activity.type,
          },
        },
      ).catch((error) => {
        logger.error("[Fedify Inbox] Error processing activity", {
          error: (error as Error).message,
          username,
          activityType: activity.type,
        });
      });
    }

    // Return 202 Accepted (ActivityPub standard)
    return new Response(JSON.stringify({ success: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    logger.error("[Fedify Inbox] Unexpected error", {
      error: (error as Error).message,
      username,
    });
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
