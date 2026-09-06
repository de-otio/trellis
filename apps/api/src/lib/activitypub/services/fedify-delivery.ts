/**
 * ActivityPub activity delivery.
 *
 * Despite the module name, Fedify is NOT involved in delivery: there is no
 * retry, no per-domain rate limit and no queue here. Each call is one signed
 * POST. The federation-outbox worker (`lib/workers/federation-outbox.ts`) is
 * where a queue would live, and it is not implemented yet.
 *
 * Remote delivery goes through the SSRF-safe fetcher (`lib/net/safe-fetch.ts`):
 * https-only, DNS resolved and range-checked, socket pinned to the validated
 * address, no redirects, bounded time and response size. The inbox URL comes
 * from a REMOTE actor document, so it is attacker-chosen — a bare `fetch()`
 * here was a blind POST to any address a peer cared to name.
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
import {
  safeFetch,
  SsrfBlockedError,
  type DnsResolver,
  type Transport,
} from "../../net/safe-fetch.js";

/** Whole-exchange budget for one inbox POST. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** An inbox response is a status line; anything past this is not one. */
const DELIVERY_MAX_RESPONSE_BYTES = 64 * 1024;

/** Injection seam for tests — never set in production. */
export interface DeliveryFetchOptions {
  resolver?: DnsResolver;
  transport?: Transport;
}

/**
 * Fallback fetch options used when none are injected. TEST SEAM ONLY —
 * production leaves this empty, so the real resolver and the pinned-socket
 * transport are used. Same shape as `RemoteFetchService.defaultFetchOptions`.
 */
export const deliveryFetchOptions: DeliveryFetchOptions = {};

/**
 * Deliver one activity to one inbox.
 *
 * Local inboxes are written straight to the database. Remote inboxes get a
 * signed POST through the SSRF-safe fetcher. There is no retry: the caller
 * owns that decision.
 *
 * @param activity - Activity to deliver
 * @param inboxUrl - Recipient's inbox URL
 * @param actorUri - Sender's actor URI
 * @param env - Environment
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

    // Remote delivery: one signed POST through the SSRF-safe fetcher.

    const body = JSON.stringify(activity);
    const request = new Request(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
      },
      body,
    });

    // Throws SigningUnavailableError when the actor has no key — caught below,
    // so an unsigned POST is never sent.
    const signedRequest = await signRequest(request, env, actorUri);
    const headers: Record<string, string> = {};
    signedRequest.headers.forEach((value, name) => {
      headers[name] = value;
    });

    let status: number;
    try {
      const result = await safeFetch(inboxUrl, {
        method: "POST",
        headers,
        body,
        allowedProtocols: ["https:"],
        // A redirected POST would re-send the signed body to a hop the
        // signature never covered; peers do not redirect inboxes.
        maxRedirects: 0,
        timeoutMs: DELIVERY_TIMEOUT_MS,
        maxBytes: DELIVERY_MAX_RESPONSE_BYTES,
        resolver: deliveryFetchOptions.resolver,
        transport: deliveryFetchOptions.transport,
      });
      status = result.status;
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        logger.warn("[FedifyDelivery] Refused delivery to inbox URL", {
          inboxUrl,
          reason: error.reason,
          detail: error.detail,
        });
        return false;
      }
      throw error;
    }

    if (status < 200 || status >= 300) {
      logger.warn("[FedifyDelivery] Remote delivery failed", {
        inboxUrl,
        status,
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
 * Deliver activity to multiple recipients.
 *
 * Fan-out is parallel and unbounded per domain; there is no retry. Both are
 * the outbox worker's job once it exists.
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

  // Deliver to all recipients in parallel.
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
