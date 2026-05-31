/**
 * WebFinger Server (Fedify-Based)
 *
 * Implements WebFinger protocol for ActivityPub actor discovery.
 * Fedify provides WebFinger support for actor URI resolution.
 */

import type { Env } from "../../../env.js";
import { getLogger, Logger } from "../../logger.js";
import { getActivityPubBaseUrl } from "../fedify/context.js";
import { UserActorDispatcher } from "../dispatchers/user-actor.js";
import { sharedDatabaseConnectionManager } from "../../database-connection-manager.js";
import { detectRegionSync } from "../../region-detection.js";
import {
  withQueryTimeoutAndRetry,
  QueryTimeoutPresets,
} from "../../db-query-helper.js";

/**
 * WebFinger resource identifier
 * Format: acct:username@domain
 */
interface WebFingerResource {
  subject: string;
  username: string;
  domain: string;
}

/**
 * Parse WebFinger resource identifier
 *
 * @param resource - WebFinger resource string (e.g., "acct:alice@example.com")
 * @returns Parsed resource or null if invalid
 */
function parseWebFingerResource(resource: string): WebFingerResource | null {
  // WebFinger resource format: acct:username@domain
  const match = resource.match(/^acct:(.+)@(.+)$/);
  if (!match) {
    return null;
  }

  return {
    subject: resource,
    username: match[1],
    domain: match[2],
  };
}

/**
 * Handle WebFinger request
 *
 * @param request - HTTP request
 * @param env - Cloudflare Workers environment
 * @returns WebFinger JSON response
 */
export async function handleWebFinger(
  request: Request,
  env: Env,
): Promise<Response> {
  const logger = getLogger();
  const { SecurityHeaders } = await import("../../security-headers.js");
  const securityHeaders = new SecurityHeaders(env);

  try {
    // Parse query parameters
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");

    if (!resource) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "resource parameter is required" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Try entity URI lookup first (resource=https://...entities/{type}/{id})
    if (resource.startsWith("https://") || resource.startsWith("http://")) {
      try {
        const resourceUrl = new URL(resource);
        const entityMatch = resourceUrl.pathname.match(/^\/entities\/([^/]+)\/(.+)$/);
        if (entityMatch) {
          const entityResult = await resolveEntityWebFinger(
            resource,
            decodeURIComponent(entityMatch[2]),
            request,
            env,
            logger,
            securityHeaders,
          );
          if (entityResult) return entityResult;
        }
      } catch {
        // Invalid URL, fall through to acct: parsing
      }
    }

    // Parse acct: WebFinger resource
    const parsed = parseWebFingerResource(resource);
    if (!parsed) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Invalid resource format" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Verify domain matches
    const baseUrl = getActivityPubBaseUrl(env, request.url);
    const baseDomain = new URL(baseUrl).hostname;

    if (parsed.domain !== baseDomain) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "Domain mismatch" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Get region for database connection
    const region = detectRegionSync(request, env);
    const dbManager = sharedDatabaseConnectionManager;

    // Find user by username
    const user = await withQueryTimeoutAndRetry(
      dbManager,
      region,
      env,
      async (db) => {
        return db.user.findUnique({
          where: { username: parsed.username },
          select: {
            id: true,
            username: true,
            actorUri: true,
            publicKey: true,
            suspended: true,
            deletionConfirmedAt: true,
          },
        });
      },
      {
        ...QueryTimeoutPresets.STANDARD,
        context: {
          operation: "webfinger_findUser",
          username: parsed.username,
        },
      },
    );

    if (!user || !user.actorUri || !user.publicKey) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "User not found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (user.suspended || user.deletionConfirmedAt) {
      return securityHeaders.createSecureResponse(
        JSON.stringify({ error: "User account is suspended or deleted" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Generate actor URI
    const actorUri = UserActorDispatcher.generateActorUri(
      user.username || "",
      env,
    );

    // Build WebFinger response
    const webfingerResponse = {
      subject: parsed.subject,
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: actorUri,
        },
      ],
    };

    logger.debug("[WebFinger] Resolved actor", {
      resource: parsed.subject,
      actorUri,
    });

    return securityHeaders.createSecureResponse(
      JSON.stringify(webfingerResponse),
      {
        status: 200,
        headers: {
          "content-type": "application/jrd+json",
        },
      },
    );
  } catch (error: any) {
    logger.error("[WebFinger] Error handling request:", error);

    return securityHeaders.createSecureResponse(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

/**
 * Resolve an entity by ID for WebFinger.
 * Returns a WebFinger Response if entity found, or null to fall through.
 */
async function resolveEntityWebFinger(
  resourceUri: string,
  entityId: string,
  request: Request,
  env: Env,
  logger: Logger,
  securityHeaders: any,
): Promise<Response | null> {
  const region = detectRegionSync(request, env);

  const entity = await withQueryTimeoutAndRetry(
    sharedDatabaseConnectionManager,
    region,
    env,
    async (db) =>
      db.entity.findUnique({
        where: { id: entityId },
        select: { id: true, actorUri: true, entityType: true },
      }),
    {
      ...QueryTimeoutPresets.STANDARD,
      context: { operation: "webfinger_findEntity", entityId },
    },
  );

  if (!entity?.actorUri) return null;

  const webfingerResponse = {
    subject: resourceUri,
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: entity.actorUri,
      },
    ],
  };

  logger.debug("[WebFinger] Resolved entity actor", {
    resource: resourceUri,
    actorUri: entity.actorUri,
  });

  return securityHeaders.createSecureResponse(
    JSON.stringify(webfingerResponse),
    {
      status: 200,
      headers: { "content-type": "application/jrd+json" },
    },
  );
}
