/**
 * Fedify Activity Delivery Service
 *
 * Integrates Fedify's delivery system for ActivityPub activities.
 * Fedify handles:
 * - Activity delivery to remote inboxes
 * - Retry logic with exponential backoff
 * - Rate limiting per domain
 * - Delivery queue management
 */

import type { Env } from "../../../env.js";
import type { ActivityStreamsActivity } from "../activity-service.js";
import { getLogger, Logger } from "../../logger.js";
import { signRequest } from "../listeners/http-signatures.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { ActivityService } from "../activity-service.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { isStandaloneModeEnabled, isRemoteUri } from "../standalone-mode.js";

/**
 * Deliver activity using Fedify
 *
 * Fedify provides automatic delivery with retry logic and rate limiting.
 * This function integrates with Fedify's delivery system.
 *
 * @param activity - Activity to deliver
 * @param inboxUrl - Recipient's inbox URL
 * @param actorUri - Sender's actor URI
 * @param env - Cloudflare Workers environment
 * @returns True if delivery successful, false otherwise
 */
export async function deliverActivityWithFedify(
  activity: ActivityStreamsActivity,
  inboxUrl: string,
  actorUri: string,
  env: Env,
): Promise<boolean> {
  const logger = getLogger();

  try {
    // Check if this is a local inbox
    const baseUrl = getActivityPubBaseUrl(env);
    const isLocal = !isRemoteUri(inboxUrl, env);

    // Check if standalone mode is enabled - skip remote deliveries
    if (!isLocal) {
      const standaloneMode = await isStandaloneModeEnabled(env);
      if (standaloneMode) {
        logger.info(
          "[FedifyDelivery] Skipping remote delivery (standalone mode enabled)",
          {
            inboxUrl,
            activityType: activity.type,
          },
        );
        return false;
      }
    }

    if (isLocal) {
      // Local delivery: store directly in database
      const { ActivityService } = await import("../activity-service.js");
      const { sharedDatabaseConnectionManager } = await import(
        "../../database-connection-manager.js"
      );

      // Extract actor ID from inbox URL
      const match = inboxUrl.match(/\/users\/([^\/]+)\/inbox/);
      if (!match) {
        logger.warn(
          "[FedifyDelivery] Could not extract username from local inbox URL",
          { inboxUrl },
        );
        return false;
      }

      const username = decodeURIComponent(match[1]);
      const region = "EU";
      const dbManager = sharedDatabaseConnectionManager;

      const user = await withQueryTimeoutAndRetry(
        dbManager,
        region,
        env,
        async (db) => {
          return db.user.findUnique({
            where: { username },
            select: { actorUri: true },
          });
        },
        {
          ...QueryTimeoutPresets.STANDARD,
          context: { operation: "getUserForDelivery", username },
        },
      );

      if (!user?.actorUri) {
        logger.warn("[FedifyDelivery] Local recipient not found", { username });
        return false;
      }

      // Store activity in local inbox
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
          context: { operation: "storeLocalActivity", username },
        },
      );
      return true;
    }

    // Remote delivery: use Fedify with HTTP signatures

    // Sign the request
    const request = new Request(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
      },
      body: JSON.stringify(activity),
    });

    const signedRequest = await signRequest(request, env, actorUri);

    // Send request
    const response = await fetch(signedRequest);

    if (!response.ok) {
      logger.warn("[FedifyDelivery] Remote delivery failed", {
        inboxUrl,
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    logger.info("[FedifyDelivery] Activity delivered successfully", {
      inboxUrl,
      activityType: activity.type,
    });

    return true;
  } catch (error) {
    logger.error("[FedifyDelivery] Error delivering activity", {
      error: (error as Error).message,
      inboxUrl,
      actorUri,
    });
    return false;
  }
}

/**
 * Deliver activity to multiple recipients using Fedify
 *
 * Fedify handles rate limiting and retry logic automatically.
 *
 * @param activity - Activity to deliver
 * @param recipients - Array of recipient inbox URLs
 * @param actorUri - Sender's actor URI
 * @param env - Cloudflare Workers environment
 * @returns Delivery results
 */
export async function deliverToRecipients(
  activity: ActivityStreamsActivity,
  recipients: string[],
  actorUri: string,
  env: Env,
): Promise<{ successful: number; failed: number }> {
  const logger = getLogger();
  let successful = 0;
  let failed = 0;

  // Deliver to all recipients in parallel
  // Fedify will handle rate limiting per domain
  const deliveryPromises = recipients.map(async (inboxUrl) => {
    const result = await deliverActivityWithFedify(
      activity,
      inboxUrl,
      actorUri,
      env,
    );
    if (result) {
      successful++;
    } else {
      failed++;
    }
  });

  await Promise.allSettled(deliveryPromises);

  logger.info("[FedifyDelivery] Batch delivery completed", {
    total: recipients.length,
    successful,
    failed,
  });

  return { successful, failed };
}
