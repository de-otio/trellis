/**
 * Encrypted Settings Routes (WS5 — state-sync).
 *
 * GET/PUT /api/settings/:namespace — server-blind, session-scoped sync of a
 * user's per-namespace encrypted setting blob.
 *
 * Security posture:
 *  - Session-scoped to `session.userId`; a user can only read/write THEIR OWN
 *    blob. The blob has no tenantId — `auth.activeTenantId` is used only to
 *    scope the publish-on-change realtime channel.
 *  - Server-blind: the ciphertext is never parsed or logged.
 *  - Optimistic concurrency: stale version -> 409 with current; If-None-Match
 *    matching the current version -> 304.
 */

import { authMiddleware } from "../auth/auth-middleware.js";
import { createPrisma } from "../../db.js";
import {
  BlobTooLargeError,
  UnknownNamespaceError,
} from "../encrypted-settings/types.js";
import { EncryptedSettingsHandler } from "../encrypted-settings/encrypted-settings-handler.js";
import { PrismaEncryptedSettingsStore } from "../encrypted-settings/encrypted-settings-store.js";
import { resolveSettingsConfig } from "../encrypted-settings/config.js";
import { getLogger } from "../logger.js";
import {
  corsMiddleware,
  csrfMiddleware,
  rateLimitMiddleware,
} from "../middleware.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { Validator } from "../validation.js";
import type { Env } from "../../env.js";
import type { Route } from "./types.js";

const NAMESPACE_PATTERN = /^\/api\/settings\/([^/]+)$/;
// Track C — offline backfill cursor. A LITERAL path; it MUST be registered
// before NAMESPACE_PATTERN so "changes" is never captured as a `:namespace`
// (Hono runs matching handlers in registration order, first Response wins).
const CHANGES_PATTERN = /^\/api\/settings\/changes$/;

/** Parse the opaque `?since=<cursor>` version high-watermark. Missing/invalid
 *  -> 0 (a full backfill), never throws. The cursor is an opaque integer. */
function sinceFrom(url: URL): number {
  const raw = url.searchParams.get("since");
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Extract the `:namespace` path param (decoded). */
function namespaceFrom(pathname: string): string | null {
  const m = pathname.match(NAMESPACE_PATTERN);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Build the handler from resolved Env. The store is Prisma-backed; the
 *  transport comes from the WS1 seam (poll/noop/injected). */
function buildHandler(env: Env): EncryptedSettingsHandler {
  const db = createPrisma(env);
  const store = new PrismaEncryptedSettingsStore(db);
  const config = resolveSettingsConfig(env);
  return new EncryptedSettingsHandler(store, config, env.realtimeTransport);
}

export const settingsRoutes: Route[] = [
  // GET /api/settings/changes?since=<cursor> — Track C offline-backfill cursor.
  // Session-scoped; returns METADATA ONLY (never ciphertext) for namespaces whose
  // version advanced past the cursor. Registered FIRST so the literal "changes"
  // path wins over the :namespace capture.
  {
    path: CHANGES_PATTERN,
    method: "GET",
    handler: async (request, env, { url }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const handler = buildHandler(env);
        const response = await handler.handleChanges(
          session.userId,
          sinceFrom(url),
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        logger.error("Error listing setting changes:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      rateLimitMiddleware({ maxRequests: 120, windowMs: 60000 }),
    ],
    description: "List setting namespaces changed since a cursor (metadata only)",
  },

  // GET /api/settings/:namespace — read the current blob (or 304 if unchanged).
  {
    path: NAMESPACE_PATTERN,
    method: "GET",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const namespace = namespaceFrom(pathname);
      if (namespace === null) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "NOT_FOUND" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const handler = buildHandler(env);
        const response = await handler.handleGet(
          session.userId,
          namespace,
          request.headers.get("if-none-match"),
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        if (error instanceof UnknownNamespaceError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "NOT_FOUND", message: "Unknown namespace" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        logger.error("Error reading encrypted setting:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      rateLimitMiddleware({ maxRequests: 120, windowMs: 60000 }),
    ],
    description: "Get encrypted setting blob",
  },

  // PUT /api/settings/:namespace — write the blob with optimistic concurrency.
  {
    path: NAMESPACE_PATTERN,
    method: "PUT",
    handler: async (request, env, { pathname }) => {
      const sessionManager = new SessionManager();
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const validator = new Validator();

      const session = await sessionManager.getSession(
        request,
        env.SESSION_SECRET,
        env,
      );
      if (!session) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const auth = await authMiddleware(request, env);
      if (!auth || !auth.activeTenantId) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const namespace = namespaceFrom(pathname);
      if (namespace === null) {
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: "NOT_FOUND" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return securityHeaders.createSecureResponse(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const handler = buildHandler(env);
        const response = await handler.handlePut(
          session.userId,
          auth.activeTenantId,
          namespace,
          body,
        );
        return securityHeaders.addSecurityHeaders(response);
      } catch (error) {
        if (error instanceof UnknownNamespaceError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({ error: "NOT_FOUND", message: "Unknown namespace" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        if (error instanceof BlobTooLargeError) {
          return securityHeaders.createSecureResponse(
            JSON.stringify({
              error: "PAYLOAD_TOO_LARGE",
              message: "Encrypted setting blob exceeds size limit",
            }),
            { status: 413, headers: { "content-type": "application/json" } },
          );
        }
        logger.error("Error writing encrypted setting:", error);
        return securityHeaders.createSecureResponse(
          JSON.stringify({ error: validator.sanitizeError(error) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    },
    middleware: [
      corsMiddleware(),
      csrfMiddleware(),
      rateLimitMiddleware({ maxRequests: 30, windowMs: 60000 }),
    ],
    description: "Write encrypted setting blob",
  },
];
