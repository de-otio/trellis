/**
 * ActivityPub Entity Routes
 *
 * Serves ActivityPub Actor documents and collections for any entity type.
 * URI pattern: /entities/{entityType}/{entityId}
 */

import { respondWithObject } from "@fedify/fedify";
import type { Env } from "../../../env.js";
import { addCorsHeaders } from "../../../worker.js";
import { EntityProfileService } from "../../activitypub/entity-profile-service.js";
import { EntityActorDispatcher } from "../../activitypub/dispatchers/entity-actor.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import {
  QueryTimeoutPresets,
  withQueryTimeoutAndRetry,
} from "../../db-query-helper.js";
import { getLogger, Logger } from "../../logger.js";
import { corsMiddleware } from "../../middleware.js";
import { detectRegionSync } from "../../region-detection.js";
import { SecurityHeaders } from "../../security-headers.js";
import type { Route } from "../types.js";

export const entityProfileRoutes: Route[] = [
  {
    path: "/entities/:entityType/:entityId",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { entityType, entityId } = params;

      try {
        const region = detectRegionSync(request, env);

        const entity = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          async (db) => {
            const found = await db.entity.findUnique({
              where: { id: entityId },
            });
            if (!found) return null;

            const ownership = await db.entityOwnership.findFirst({
              where: { entityId: found.id, status: 'ACTIVE' },
              orderBy: { id: 'asc' },
              select: { userId: true },
            });
            const owner = ownership ? await db.user.findUnique({
              where: { id: ownership.userId },
              select: { id: true, actorUri: true },
            }) : null;

            return { ...found, owner };
          },
          {
            ...QueryTimeoutPresets.STANDARD,
            context: { operation: "getEntityActor", entityId },
          },
        );

        if (!entity) {
          return addCorsHeaders(
            securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Entity not found" }),
              { status: 404, headers: { "content-type": "application/json" } },
            ),
            request,
            env,
          );
        }

        if (entity.entityType && entity.entityType !== entityType) {
          return addCorsHeaders(
            securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Entity type mismatch" }),
              { status: 404, headers: { "content-type": "application/json" } },
            ),
            request,
            env,
          );
        }

        const dispatcher = new EntityActorDispatcher(env as Env);
        const actor = dispatcher.entityToActor(entity);

        // Use Fedify's respondWithObject for proper JSON-LD serialization
        // and content negotiation — same pattern as user actor route
        const response = await respondWithObject(
          request as any,
          actor as any,
        );

        // Apply security headers to Fedify's response
        const responseBody = await response.text();
        return addCorsHeaders(
          securityHeaders.createSecureResponse(responseBody, {
            status: response.status,
            headers: {
              ...Object.fromEntries(response.headers.entries()),
              "content-type": "application/activity+json",
            },
          }),
          request,
          env,
        );
      } catch (error) {
        logger.error("[EntityProfile] Error serving actor document", {
          error: (error as Error).message,
          entityId,
        });
        return addCorsHeaders(
          securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
          request,
          env,
        );
      }
    },
    description: "Get ActivityPub entity actor document",
  },
  {
    path: "/entities/:entityType/:entityId/followers",
    method: "GET",
    middleware: [corsMiddleware()],
    handler: async (request, env, { params }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const { entityId } = params;
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") || "20", 10),
        100,
      );

      try {
        const region = detectRegionSync(request, env);

        const entity = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          async (db) =>
            db.entity.findUnique({
              where: { id: entityId },
              select: { id: true, actorUri: true },
            }),
          {
            ...QueryTimeoutPresets.STANDARD,
            context: { operation: "getEntityForFollowers", entityId },
          },
        );

        if (!entity?.actorUri) {
          return addCorsHeaders(
            securityHeaders.createSecureResponse(
              JSON.stringify({ error: "Entity not found" }),
              { status: 404, headers: { "content-type": "application/json" } },
            ),
            request,
            env,
          );
        }

        const followersActorUris = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          async (db) =>
            EntityProfileService.getFollowers(db, entity.id, page, limit),
          {
            ...QueryTimeoutPresets.STANDARD,
            context: { operation: "getEntityFollowers", entityId },
          },
        );

        const totalItems = await withQueryTimeoutAndRetry(
          sharedDatabaseConnectionManager,
          region,
          env,
          async (db) => EntityProfileService.getFollowersCount(db, entity.id),
          {
            ...QueryTimeoutPresets.STANDARD,
            context: { operation: "getEntityFollowersCount", entityId },
          },
        );

        const collection = {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "OrderedCollection",
          id: `${entity.actorUri}/followers`,
          totalItems,
          orderedItems: followersActorUris,
        };

        return addCorsHeaders(
          securityHeaders.createSecureResponse(JSON.stringify(collection), {
            status: 200,
            headers: { "content-type": "application/activity+json" },
          }),
          request,
          env,
        );
      } catch (error) {
        logger.error("[EntityProfile] Error serving followers collection", {
          error: (error as Error).message,
          entityId,
        });
        return addCorsHeaders(
          securityHeaders.createSecureResponse(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
          request,
          env,
        );
      }
    },
    description: "Get ActivityPub entity followers collection",
  },
];
