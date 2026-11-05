/**
 * ActivityPub Group Routes
 *
 * Handles group actor documents and collections.
 */

import type { Env } from "../../../env.js";
import { addCorsHeaders } from "../../../worker.js";
import { ActivityProcessor } from "../../activitypub/activity-processor.js";
import { ActivityService } from "../../activitypub/activity-service.js";
import { GroupService } from "../../activitypub/group-service.js";
import { assertActorBinding } from "../../activitypub/http-signatures.js";
import { verifyInboxRequest } from "../../activitypub/listeners/http-signatures.js";
import { verificationFailureStatus } from "../../activitypub/http-signatures.js";
import { admitActivity } from "../../activitypub/services/abuse-prevention.js";
import {
  PAYLOAD_TOO_LARGE_BODY,
  addresseeLimitViolation,
  declaredContentLength,
  inboxMaxBodyBytes,
} from "../../activitypub/inbox-limits.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { corsMiddleware } from "../../middleware.js";
import { detectRegionSync } from "../../region-detection.js";
import { SecurityHeaders } from "../../security-headers.js";
import { SessionManager } from "../../session-cookie.js";
import type { Route } from "../types.js";

/**
 * M14 — who may READ a group's collections.
 *
 *  - `inbox`: an ActivityPub inbox is owner-only by spec, so it is readable
 *    only by the group's ADMIN / MODERATOR members — for PUBLIC groups too. It
 *    lists every activity delivered to the group (actor, object, target,
 *    audience), which for a private group is a roster of who is asking to join
 *    and what is being addressed to it.
 *  - `collection` (followers, outbox): open for a PUBLIC group (unchanged);
 *    for a PRIVATE / FRIENDS_ONLY group the member list, member count and
 *    outbox are members-only.
 *
 * Written as `privacy === "PUBLIC"` ⇒ open, everything else ⇒ members-only, so a
 * privacy value added later fails CLOSED.
 *
 * A refusal is the SAME 404 a nonexistent group gets, so the response does not
 * tell an outsider that a private group exists. Any failure while establishing
 * the caller's role is a refusal.
 */
type GroupReadLevel = "collection" | "inbox";

async function authorizeGroupRead(args: {
  request: Request;
  env: Env;
  region: Parameters<typeof withQueryTimeoutAndRetry>[1];
  group: { id: string; privacy: string };
  level: GroupReadLevel;
}): Promise<boolean> {
  const { request, env, region, group, level } = args;
  if (level === "collection" && group.privacy === "PUBLIC") return true;

  try {
    const session = await new SessionManager().getSession(
      request,
      env.SESSION_SECRET,
      env,
    );
    if (!session) return false;

    const dbManager = sharedDatabaseConnectionManager;
    const user = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) =>
        db.user.findUnique({
          where: { id: session.userId },
          select: { actorUri: true },
        }),
      { ...QueryTimeoutPresets.STANDARD, context: { operation: "groupReadAuthUser" } },
    );
    if (!user?.actorUri) return false;

    const role = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => GroupService.getMemberRole(db, group.id, user.actorUri!),
      { ...QueryTimeoutPresets.STANDARD, context: { operation: "groupReadAuthRole" } },
    );
    if (role === null) return false;
    return level === "inbox" ? role === "ADMIN" || role === "MODERATOR" : true;
  } catch (error) {
    getLogger().warn("[Group] Read authorization failed — refusing", {
      error: (error as Error).message,
      groupId: group.id,
    });
    return false;
  }
}

export const groupRoutes: Route[] = [
  {
    path: "/groups/:groupId",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { groupId } = params;

      try {
        // Get region and database
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get group by ID
        const group = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.group.findUnique({
              where: { id: groupId },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupById",
              groupId,
            },
          },
        );

        // M14: the actor document exposes name / summary / privacy, so for a
        // non-PUBLIC group it is members-only, with the same 404 as "not found".
        // PUBLIC groups stay open (and never touch the session).
        if (
          !group ||
          !(await authorizeGroupRead({
            request,
            env,
            region,
            group,
            level: "collection",
          }))
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Group not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Serialize to ActivityStreams actor document
        const actorDoc = await GroupService.serializeActor(
          group,
          env as Env,
          request.url,
        );

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(actorDoc),
          {
            status: 200,
            headers: {
              "content-type": "application/activity+json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Group] Error getting group actor", {
          error: (error as Error).message,
          groupId,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Get ActivityPub group actor document",
  },
  {
    path: "/groups/:groupId/followers",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { groupId } = params;
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "20", 10),
        100,
      );

      try {
        // Get region and database
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get group by ID
        const group = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.group.findUnique({
              where: { id: groupId },
              select: {
                id: true,
                actorUri: true,
                followersUrl: true,
                privacy: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupById",
              groupId,
            },
          },
        );

        // M14: members-only for a non-PUBLIC group; same 404 as "not found".
        if (
          !group ||
          !group.actorUri ||
          !(await authorizeGroupRead({
            request,
            env,
            region,
            group,
            level: "collection",
          }))
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Group not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get members (followers)
        const memberActorUris = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return GroupService.getMemberActorUris(db, group.id, page, limit);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupMembers",
              groupId,
            },
          },
        );

        const totalItems = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return GroupService.getMembersCount(db, group.id);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupMembersCount",
              groupId,
            },
          },
        );

        // Format as OrderedCollection
        const collection = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          id: group.followersUrl || `${group.actorUri}/followers`,
          totalItems,
          orderedItems: memberActorUris,
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(collection),
          {
            status: 200,
            headers: {
              "content-type": "application/activity+json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[Group] Error getting group followers", {
          error: (error as Error).message,
          groupId,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Get ActivityPub group followers collection (members)",
  },
  {
    path: "/groups/:groupId/inbox",
    method: "POST",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { groupId } = params;

      try {
        // L2: refuse a declared oversize body before reading or verifying it;
        // the check on the verified bytes below is the authoritative one.
        const maxBody = inboxMaxBodyBytes();
        const declared = declaredContentLength(request);
        if (declared !== null && declared > maxBody) {
          logger.warn("[GroupInbox] Declared body exceeds the inbox cap", {
            groupId,
            declared,
            maxBody,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            PAYLOAD_TOO_LARGE_BODY,
            { status: 413, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Verify HTTP Signature. This authenticates the body (signed digest,
        // constant-time compared), bounds the Date, and returns the actor URI
        // that owns the signing key. Through the inbox entry point so the
        // group inbox shares the user inbox's replay suppression — calling the
        // service directly left this inbox with only the skew window.
        const verification = await verifyInboxRequest(request.clone(), env);
        if (!verification.valid) {
          logger.warn("[GroupInbox] Invalid HTTP signature", {
            groupId,
            reason: verification.reason,
            detail: verification.detail,
          });
          // 429 / 503 for a pre-verification budget / limiter outcome (M13).
          const status = verificationFailureStatus(verification.reason);
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({
              error: status === 401 ? "Unauthorized" : "Try again later",
            }),
            { status, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // L2: the verified bytes are the truth about size — refuse BEFORE parsing.
        if (verification.body.length > maxBody) {
          logger.warn("[GroupInbox] Verified body exceeds the inbox cap", {
            groupId,
            size: verification.body.length,
            maxBody,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            PAYLOAD_TOO_LARGE_BODY,
            { status: 413, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Parse the exact bytes the digest covered, not a fresh read.
        let activity: import("../../activitypub/activity-service.js").ActivityStreamsActivity;
        try {
          activity = JSON.parse(verification.body.toString("utf8"));
        } catch (error) {
          logger.warn("[GroupInbox] Failed to parse activity JSON", {
            error: (error as Error).message,
            groupId,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid JSON" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Validate activity structure
        if (!activity.type || !activity.actor) {
          logger.warn("[GroupInbox] Invalid activity structure", {
            groupId,
            activityType: activity.type,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Invalid activity structure" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // L2: bound the addressing arrays stored verbatim. Refuse (400) before
        // anything is persisted; truncating would change who it is addressed to.
        const oversizedField = addresseeLimitViolation(activity);
        if (oversizedField) {
          logger.warn("[GroupInbox] Too many addressees", {
            groupId,
            field: oversizedField,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Too many addressees" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Bind keyId → owner → activity.actor (F1).
        const binding = assertActorBinding(verification.owner, activity);
        if (!binding.ok) {
          logger.warn("[GroupInbox] Actor binding failed — possible spoofing", {
            groupId,
            keyId: verification.keyId,
            owner: verification.owner,
            reason: binding.reason,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Actor mismatch" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Admission control (F6). The group inbox previously had NONE — no
        // blocklist, no rate limit — so it was the softer of the two inboxes.
        const admission = await admitActivity(
          activity,
          verification.owner,
          env as any,
        );
        if (!admission.admitted) {
          logger.warn("[GroupInbox] Activity refused admission", {
            groupId,
            owner: verification.owner,
            reason: admission.reason,
            detail: admission.detail,
          });
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Activity rejected" }),
            {
              status: admission.reason === "rate-limited" ? 429 : 403,
              headers: { "content-type": "application/json" },
            },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get region and database
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get group
        const group = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.group.findUnique({
              where: { id: groupId },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupById",
              groupId,
            },
          },
        );

        if (!group || !group.actorUri) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Group not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Store activity in group's inbox
        await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            await ActivityService.storeInboxActivity(
              db,
              group.actorUri!,
              activity,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "storeGroupInboxActivity",
              groupId,
            },
          },
        );

        // Process activity asynchronously (don't block response)
        // Note: In production, this should be queued for background processing
        withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            await ActivityProcessor.processActivity(
              db,
              activity,
              {} as any,
              env as any,
              // Bind Follows to THIS group's inbox (a Follow of group A posted
              // to group B's inbox must not be processed against A).
              { inboxGroupId: groupId },
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "processGroupInboxActivity",
              groupId,
            },
          },
        ).catch((error) => {
          logger.error("[GroupInbox] Error processing activity", {
            error: (error as Error).message,
            groupId,
          });
        });

        // Return 202 Accepted (activity received, processing asynchronously)
        const response = securityHeaders.createSecureResponse(
          JSON.stringify({ success: true }),
          {
            status: 202,
            headers: {
              "content-type": "application/json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[GroupInbox] Error receiving activity", {
          error: (error as Error).message,
          groupId,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Receive ActivityPub activities in group inbox",
  },
  {
    path: "/groups/:groupId/inbox",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { groupId } = params;
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "20", 10),
        100,
      );

      try {
        // Get region and database
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get group
        const group = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.group.findUnique({
              where: { id: groupId },
              select: {
                id: true,
                actorUri: true,
                privacy: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupById",
              groupId,
            },
          },
        );

        // M14: an inbox is owner-only — group admins / moderators, for PUBLIC
        // groups too. Same 404 as "not found" so nothing is revealed.
        if (
          !group ||
          !group.actorUri ||
          !(await authorizeGroupRead({
            request,
            env,
            region,
            group,
            level: "inbox",
          }))
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Group not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get inbox activities
        const activities = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getInboxActivities(
              db,
              group.actorUri!,
              page,
              limit,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupInboxActivities",
              groupId,
            },
          },
        );

        const totalItems = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getInboxCount(db, group.actorUri!);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupInboxCount",
              groupId,
            },
          },
        );

        // Format as OrderedCollection
        const collection = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          id: `${group.actorUri}/inbox`,
          totalItems,
          orderedItems: activities.map((a) => ({
            type: a.type,
            actor: a.actorUri,
            object: a.objectId,
            target: a.targetId,
            to: a.to,
            cc: a.cc,
            published: a.published.toISOString(),
          })),
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(collection),
          {
            status: 200,
            headers: {
              "content-type": "application/activity+json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[GroupInbox] Error getting inbox activities", {
          error: (error as Error).message,
          groupId,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Get ActivityPub group inbox",
  },
  {
    path: "/groups/:groupId/outbox",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { groupId } = params;
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "20", 10),
        100,
      );

      try {
        // Get region and database
        const region = detectRegionSync(request, env);
        const dbManager = sharedDatabaseConnectionManager;

        // Get group
        const group = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return db.group.findUnique({
              where: { id: groupId },
              select: {
                id: true,
                actorUri: true,
                privacy: true,
              },
            });
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupById",
              groupId,
            },
          },
        );

        // M14: members-only for a non-PUBLIC group; same 404 as "not found".
        if (
          !group ||
          !group.actorUri ||
          !(await authorizeGroupRead({
            request,
            env,
            region,
            group,
            level: "collection",
          }))
        ) {
          const errorResponse = securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Group not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
          return addCorsHeaders(errorResponse, request, env);
        }

        // Get outbox activities
        const activities = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getOutboxActivities(
              db,
              group.actorUri!,
              page,
              limit,
            );
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupOutboxActivities",
              groupId,
            },
          },
        );

        const totalItems = await withQueryTimeoutAndRetry(
          dbManager,
          region,
          env,
          async (db) => {
            return ActivityService.getOutboxCount(db, group.actorUri!);
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: {
              operation: "getGroupOutboxCount",
              groupId,
            },
          },
        );

        // Format as OrderedCollection
        const collection = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          id: `${group.actorUri}/outbox`,
          totalItems,
          orderedItems: activities.map((a) => ({
            type: a.type,
            actor: a.actorUri,
            object: a.objectId,
            target: a.targetId,
            to: a.to,
            cc: a.cc,
            published: a.published.toISOString(),
          })),
        };

        const response = securityHeaders.createSecureResponse(
          JSON.stringify(collection),
          {
            status: 200,
            headers: {
              "content-type": "application/activity+json",
            },
          },
        );
        return addCorsHeaders(response, request, env);
      } catch (error) {
        logger.error("[GroupOutbox] Error getting outbox activities", {
          error: (error as Error).message,
          groupId,
        });
        const errorResponse = securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Internal server error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
        return addCorsHeaders(errorResponse, request, env);
      }
    },
    description: "Get ActivityPub group outbox",
  },
];
