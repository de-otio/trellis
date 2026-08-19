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
import { verifyInboxRequest } from "./http-signatures.js";
import { assertActorBinding } from "../http-signatures.js";
import { processRemoteActivity } from "../services/remote-activity-handler.js";
import { admitActivity } from "../services/abuse-prevention.js";
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
  authenticatedBody?: Buffer,
): Promise<ActivityStreamsActivity | null> {
  const logger = getLogger();

  try {
    // Parse the bytes the signature's digest authenticated when we have them.
    // Re-reading the request would reintroduce a gap between what was verified
    // and what gets processed.
    const activity = (
      authenticatedBody !== undefined
        ? JSON.parse(authenticatedBody.toString("utf8"))
        : await request.json()
    ) as any;

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
    // Verify the HTTP Signature. This now also authenticates the BODY (digest
    // must be signed and must match) and bounds the Date, and it hands back
    // the actor URI that owns the signing key.
    const verification = await verifyInboxRequest(request, env);
    if (!verification.valid) {
      logger.warn("[Fedify Inbox] Invalid HTTP signature", {
        username,
        reason: verification.reason,
        detail: verification.detail,
      });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // Parse the exact bytes the digest covered.
    const activity = await parseActivity(request, env, verification.body);
    if (!activity) {
      logger.warn("[Fedify Inbox] Failed to parse activity", { username });
      return new Response(JSON.stringify({ error: "Invalid activity" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // Bind keyId → owner → activity.actor. Verifying a signature only proves
    // that someone holding that key sent the request; without this, an
    // attacker signs with their own valid key and sets
    // `"actor": "https://victim/users/admin"`, and the activity is stored and
    // processed as the victim.
    const binding = assertActorBinding(verification.owner, activity);
    if (!binding.ok) {
      logger.warn("[Fedify Inbox] Actor binding failed — possible spoofing", {
        username,
        keyId: verification.keyId,
        owner: verification.owner,
        reason: binding.reason,
      });
      return new Response(JSON.stringify({ error: "Actor mismatch" }), {
        status: 403,
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

      // Admission control: instance blocklist, then the shared domain-keyed
      // rate limit, then abuse heuristics. Fails CLOSED — a check that cannot
      // run is a refusal, not an admission.
      const admission = await admitActivity(activity, actorUri, env);
      if (!admission.admitted) {
        logger.warn("[Fedify Inbox] Activity refused admission", {
          username,
          actorUri,
          activityType: activity.type,
          reason: admission.reason,
          detail: admission.detail,
        });
        // A rate-limited peer should back off and retry; everything else is a
        // flat refusal.
        const status = admission.reason === "rate-limited" ? 429 : 403;
        return new Response(JSON.stringify({ error: "Activity rejected" }), {
          status,
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
        // Pass our verification down: re-verifying would re-fetch the remote
        // actor and trip replay suppression on our own request.
        verification,
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
