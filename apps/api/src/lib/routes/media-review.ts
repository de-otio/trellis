/**
 * Media REVIEW-queue moderator routes (T9).
 *
 * The platform-MODERATOR HTTP surface over media awaiting a human decision.
 * Every route:
 *   1. requires an authenticated session (401 else);
 *   2. resolves the caller's role SERVER-SIDE from the User table and requires
 *      MODERATOR/SUPER_ADMIN (403 else) — never a client claim;
 *   3. delegates the decision to the pure lifecycle machine via
 *      {@link MediaReviewHandler}, which writes an AuditEvent for every
 *      decision and for the audited view-bypass.
 *
 *   GET    /api/admin/media-review                    — paginated queue
 *   POST   /api/admin/media-review/:id/decision       — approve | reject
 *   POST   /api/admin/media-review/:id/escalate-csam  — lock + page (stub)
 *   GET    /api/admin/media-review/:id/content        — audited byte view
 *
 * Handles BOTH image and video items (the list surfaces per-track verdicts;
 * the content view serves either). Mounted in app.ts (H11 tier) — the parity
 * guard (route-mount-parity.test.ts) enforces it stays mounted.
 */

import { z } from "zod";

import { DataRouter } from "../data-router.js";
import { createAuditLogger } from "../audit-composer.js";
import { addCorsHeaders } from "../../worker.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { getLogger } from "../logger.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateRequest } from "../validate-request.js";
import { canonicalContentType } from "../media/serve-gate.js";
import {
  MediaReviewHandler,
  getMediaReviewPromotion,
  type MediaKind,
} from "../media/media-review-handler.js";
import type { Region } from "../region-detection.js";
import type { Route } from "./types.js";

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

const REVIEW_BASE = "/api/admin/media-review";
const DECISION_RE = /^\/api\/admin\/media-review\/([^/]+)\/decision$/;
const CSAM_RE = /^\/api\/admin\/media-review\/([^/]+)\/escalate-csam$/;
const CONTENT_RE = /^\/api\/admin\/media-review\/([^/]+)\/content$/;

/** JSON response helper with security + CORS headers. */
async function json(
  securityHeaders: SecurityHeaders,
  request: Request,
  env: unknown,
  status: number,
  body: unknown,
): Promise<Response> {
  const res = securityHeaders.createSecureResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  return addCorsHeaders(res, request, env as never);
}

/**
 * Shared preamble: authenticate + resolve MODERATOR role server-side.
 * Returns `{ session, db, region }` on success, or a ready-made 401/403
 * Response on failure. The role is read from the User table (DB-authoritative),
 * never from the request body or a token claim the client controls.
 */
async function requireModerator(
  request: Request,
  env: any,
  requestContext: { region?: string } | undefined,
  securityHeaders: SecurityHeaders,
): Promise<
  | { ok: true; userId: string; region: Region; db: any }
  | { ok: false; response: Response }
> {
  const sessionManager = new SessionManager();
  const session = await sessionManager.getSession(
    request,
    env.SESSION_SECRET,
    env,
  );
  if (!session) {
    return {
      ok: false,
      response: await json(securityHeaders, request, env, 401, {
        error: "Unauthorized",
      }),
    };
  }

  const region = (requestContext?.region || env.DEFAULT_REGION || "EU") as Region;
  const db = DataRouter.getDatabaseForRegion(region, env) as any;
  const handler = new MediaReviewHandler();
  const role = await handler.resolveModeratorRole(db, session.userId);
  if (!role) {
    return {
      ok: false,
      response: await json(securityHeaders, request, env, 403, {
        error: "Forbidden: Moderator access required",
      }),
    };
  }
  return { ok: true, userId: session.userId, region, db };
}

function clientIp(request: Request): string | undefined {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return undefined;
}

export const mediaReviewRoutes: Route[] = [
  // ── GET /api/admin/media-review — paginated REVIEW/QUARANTINED queue ──────
  {
    path: REVIEW_BASE,
    method: "GET",
    handler: async (request, env, { url, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const gate = await requireModerator(request, env, requestContext, securityHeaders);
      if (!gate.ok) return gate.response;

      try {
        const params = new URL(url).searchParams;
        const limit = parseInt(params.get("limit") || "50", 10);
        const cursor = params.get("cursor") || undefined;
        const kindParam = params.get("kind") || undefined;
        const kind =
          kindParam === "image" || kindParam === "video" || kindParam === "audio"
            ? (kindParam as MediaKind)
            : undefined;

        const handler = new MediaReviewHandler();
        const page = await handler.list(gate.db, {
          limit: Number.isFinite(limit) ? limit : 50,
          cursor,
          kind,
        });
        return json(securityHeaders, request, env, 200, page);
      } catch (error) {
        logger.error("[MediaReview] list failed:", error);
        return json(securityHeaders, request, env, 500, {
          error: "Failed to list review queue",
        });
      }
    },
    middleware: [corsMiddleware()],
    description: "List media awaiting moderator review (MODERATOR only)",
  },

  // ── POST /api/admin/media-review/:id/decision — approve | reject ─────────
  {
    path: DECISION_RE,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const gate = await requireModerator(request, env, requestContext, securityHeaders);
      if (!gate.ok) return gate.response;

      const mediaId = pathname.match(DECISION_RE)?.[1];
      if (!mediaId) {
        return json(securityHeaders, request, env, 404, { error: "Not found" });
      }

      const validation = await validateRequest(request, decisionSchema);
      if (!validation.success) {
        return addCorsHeaders(
          securityHeaders.addSecurityHeaders(validation.error),
          request,
          env as never,
        );
      }

      try {
        const handler = new MediaReviewHandler();
        const auditLogger = createAuditLogger(env);
        // The promotion capability, when a consuming application injected one,
        // is what makes this approval actually copy the reviewed bytes to the
        // serve prefix. `decide` reads it from the injection seam by default;
        // passing it explicitly keeps the dependency visible at the call site.
        const result = await handler.decide(
          gate.db,
          auditLogger,
          env,
          {
            mediaId,
            decision: validation.data.decision,
            moderatorUserId: gate.userId,
            region: gate.region,
            ipAddress: clientIp(request),
            userAgent: request.headers.get("user-agent") || undefined,
          },
          getMediaReviewPromotion(),
        );

        if (!result.ok) {
          if (result.code === "NOT_FOUND") {
            return json(securityHeaders, request, env, 404, { error: "Not found" });
          }
          return json(securityHeaders, request, env, 409, {
            error: "Item is not awaiting review",
            lifecycle: result.from,
          });
        }
        return json(securityHeaders, request, env, 200, {
          success: true,
          lifecycle: result.status,
          promoted: result.promoted,
        });
      } catch (error) {
        logger.error("[MediaReview] decision failed:", error);
        return json(securityHeaders, request, env, 500, {
          error: "Failed to record decision",
        });
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "Approve or reject a media review item (MODERATOR only)",
  },

  // ── POST /api/admin/media-review/:id/escalate-csam — lock + page (stub) ──
  {
    path: CSAM_RE,
    method: "POST",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const gate = await requireModerator(request, env, requestContext, securityHeaders);
      if (!gate.ok) return gate.response;

      const mediaId = pathname.match(CSAM_RE)?.[1];
      if (!mediaId) {
        return json(securityHeaders, request, env, 404, { error: "Not found" });
      }

      try {
        const handler = new MediaReviewHandler();
        const auditLogger = createAuditLogger(env);
        const result = await handler.escalateCsam(gate.db, auditLogger, env, {
          mediaId,
          moderatorUserId: gate.userId,
          region: gate.region,
          ipAddress: clientIp(request),
          userAgent: request.headers.get("user-agent") || undefined,
        });
        if (!result.ok) {
          return json(securityHeaders, request, env, 404, { error: "Not found" });
        }
        return json(securityHeaders, request, env, 200, {
          success: true,
          lifecycle: result.status,
          locked: true,
          pagedForHumanReview: true,
        });
      } catch (error) {
        logger.error("[MediaReview] CSAM escalation failed:", error);
        return json(securityHeaders, request, env, 500, {
          error: "Failed to escalate",
        });
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description: "CSAM-escalate a review item: lock + page a human (stub, no automated reporting)",
  },

  // ── GET /api/admin/media-review/:id/content — audited byte view ──────────
  {
    path: CONTENT_RE,
    method: "GET",
    handler: async (request, env, { pathname, requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const gate = await requireModerator(request, env, requestContext, securityHeaders);
      if (!gate.ok) return gate.response;

      const mediaId = pathname.match(CONTENT_RE)?.[1];
      if (!mediaId) {
        return json(securityHeaders, request, env, 404, { error: "Not found" });
      }

      try {
        const handler = new MediaReviewHandler();
        const auditLogger = createAuditLogger(env);
        const authorized = await handler.authorizeView(gate.db, auditLogger, env, {
          mediaId,
          moderatorUserId: gate.userId,
          region: gate.region,
          ipAddress: clientIp(request),
          userAgent: request.headers.get("user-agent") || undefined,
        });
        if (!authorized) {
          return json(securityHeaders, request, env, 404, { error: "Not found" });
        }

        const r2Bucket = (env as any).MEDIA_BUCKET_R2 || (env as any).R2_BUCKET;
        const object = r2Bucket ? await r2Bucket.get(authorized.originalKey) : null;
        if (!object) {
          return json(securityHeaders, request, env, 404, { error: "Not found" });
        }

        // Content-type from the canonical re-encode format (images) or the video
        // mime; never from attacker-influenced object metadata. Serve inline so
        // the in-queue player/preview can render it.
        const isVideo = authorized.mimeType.startsWith("video/");
        const contentType = isVideo
          ? authorized.mimeType
          : canonicalContentType(env.media.canonicalFormat);
        const res = new Response(object.body, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": "inline",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
        return addCorsHeaders(res, request, env as never);
      } catch (error) {
        logger.error("[MediaReview] content view failed:", error);
        return json(securityHeaders, request, env, 404, { error: "Not found" });
      }
    },
    middleware: [corsMiddleware()],
    description: "Audited moderator byte-view of a review item (MODERATOR only)",
  },
];
