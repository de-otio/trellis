/**
 * Remote Activity Handler
 *
 * Handles accepting and processing remote ActivityPub activities.
 * Fedify verifies signatures and routes activities automatically.
 */

import type { Env } from "../../../env.js";
import type { ActivityStreamsActivity } from "../activity-service.js";
import { ActivityProcessor } from "../activity-processor.js";
import { ActivityService } from "../activity-service.js";
import { getLogger, Logger } from "../../logger.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";
import { detectRegionSync } from "../../region-detection.js";
import { verifyInboxRequest } from "../listeners/http-signatures.js";
import {
  assertActorBinding,
  type SignatureVerificationSuccess,
} from "../http-signatures.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { isStandaloneModeEnabled, isRemoteUri } from "../standalone-mode.js";

/**
 * Process remote activity
 *
 * Handles remote activities received in inbox.
 * Fedify verifies signatures automatically when configured.
 *
 * @param activity - Remote activity
 * @param request - Incoming request
 * @param inboxActorUri - Target actor's actor URI
 * @param env - Cloudflare Workers environment
 * @param verified - A verification already performed by the caller. Pass this
 *   whenever the caller has verified: re-verifying would (a) re-fetch the
 *   remote actor and (b) trip replay suppression on our own request, since an
 *   identical signature is exactly what the nonce cache is built to reject.
 * @returns True if processed successfully, false otherwise
 */
export async function processRemoteActivity(
  activity: ActivityStreamsActivity,
  request: Request,
  inboxActorUri: string,
  env: Env,
  verified?: SignatureVerificationSuccess,
): Promise<boolean> {
  const logger = getLogger();

  try {
    // Check if standalone mode is enabled - reject remote activities early
    const standaloneMode = await isStandaloneModeEnabled(
      env,
      undefined,
      request,
    );
    if (standaloneMode) {
      logger.info(
        "[RemoteActivityHandler] Rejecting remote activity (standalone mode enabled)",
        {
          inboxActorUri,
          activityType: activity.type,
        },
      );
      return false;
    }

    // Verify the HTTP Signature unless the caller already did.
    let verification: SignatureVerificationSuccess;
    if (verified) {
      verification = verified;
    } else {
      const result = await verifyInboxRequest(request, env);
      if (!result.valid) {
        logger.warn("[RemoteActivityHandler] Invalid HTTP signature", {
          inboxActorUri,
          activityType: activity.type,
          reason: result.reason,
          detail: result.detail,
        });
        return false;
      }
      verification = result;
    }

    // Bind keyId → owner → activity.actor before anything is stored. The
    // signature proves who sent the request; only this proves the activity is
    // theirs to send.
    const binding = assertActorBinding(verification.owner, activity);
    if (!binding.ok) {
      logger.warn(
        "[RemoteActivityHandler] Actor binding failed — possible spoofing",
        {
          inboxActorUri,
          keyId: verification.keyId,
          owner: verification.owner,
          reason: binding.reason,
        },
      );
      return false;
    }

    // Check if actor is remote
    const baseUrl = getActivityPubBaseUrl(env);
    const actorUri =
      typeof activity.actor === "string"
        ? activity.actor
        : (activity.actor as any)?.id;
    const isRemote = actorUri && isRemoteUri(actorUri, env);

    if (!isRemote) {
      // Local activity - should be handled by regular inbox processing
      logger.warn("[RemoteActivityHandler] Activity is not remote", {
        actorUri,
        inboxActorUri,
      });
      return false;
    }

    // Get region and database
    const region = detectRegionSync(request, env);
    const dbManager = sharedDatabaseConnectionManager;

    // Get target user by actor URI
    const user = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return db.user.findUnique({
          where: { actorUri: inboxActorUri },
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
          operation: "getUserByActorUri",
          inboxActorUri,
        },
      },
    );

    if (!user) {
      logger.warn("[RemoteActivityHandler] Target user not found", {
        inboxActorUri,
      });
      return false;
    }

    // Store activity in inbox
    await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        await ActivityService.storeInboxActivity(db, inboxActorUri, activity);
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "storeRemoteActivity",
          inboxActorUri,
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
        await ActivityProcessor.processActivity(db, activity, user as any, env);
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "processRemoteActivity",
          inboxActorUri,
          activityType: activity.type,
        },
      },
    ).catch((error) => {
      logger.error("[RemoteActivityHandler] Error processing remote activity", {
        error: (error as Error).message,
        inboxActorUri,
        activityType: activity.type,
      });
    });

    logger.info("[RemoteActivityHandler] Remote activity processed", {
      inboxActorUri,
      activityType: activity.type,
      actorUri,
    });

    return true;
  } catch (error) {
    logger.error("[RemoteActivityHandler] Error processing remote activity", {
      error: (error as Error).message,
      inboxActorUri,
    });
    return false;
  }
}
