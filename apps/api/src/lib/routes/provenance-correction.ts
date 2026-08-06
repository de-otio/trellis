/**
 * Staff-reviewed provenance correction (AI Act Art. 50 + GDPR Art. 16, D12).
 *
 *   POST /api/admin/provenance-correction
 *
 * The ONLY path by which a synthetic-content declaration can be reduced. The
 * author-facing edit path is monotonic and returns 409 on any attempt to lower
 * one, which fails safe but left an author who mis-declared with no remedy — and
 * GDPR Art. 16 gives a data subject the right to have inaccurate personal data
 * rectified. This route is that remedy, gated behind a human.
 *
 * Every route here:
 *   1. requires an authenticated session (401 else);
 *   2. resolves the caller's role SERVER-SIDE from the User table and requires
 *      MODERATOR/SUPER_ADMIN (403 else) — never a client claim;
 *   3. requires a written reason, which becomes part of the audit record;
 *   4. writes an AuditEvent for every applied correction, through the
 *      audit-composer facade (one of the two sanctioned paths, CLAUDE.md rule 7).
 *
 * Mirrors the shape of media-review.ts deliberately — same preamble, same role
 * resolution, same JSON helper — because a second authorization idiom is a second
 * thing to get wrong.
 */

import { z } from "zod";

import { DataRouter } from "../data-router.js";
import { addCorsHeaders } from "../../worker.js";
import { corsMiddleware, csrfMiddleware } from "../middleware.js";
import { getLogger } from "../logger.js";
import { SecurityHeaders } from "../security-headers.js";
import { SessionManager } from "../session-cookie.js";
import { validateRequest } from "../validate-request.js";
import { MediaReviewHandler } from "../media/media-review-handler.js";
import { planCorrection } from "../provenance/correction.js";
import type { SyntheticSourceType } from "../provenance/types.js";
import type { Region } from "../region-detection.js";
import type { Route } from "./types.js";

const CORRECTION_PATH = "/api/admin/provenance-correction";

/**
 * Which row is being corrected.
 *
 * `postMedia` is addressed by its own PostMedia row id, not by (postId, mediaId):
 * the declaration belongs to one *use* of the bytes, and a MediaFile is shared
 * across authors by content-addressed dedup, so a media-level correction would
 * silently rewrite other people's disclosures.
 */
const correctionSchema = z
  .object({
    resource: z.enum(["post", "comment", "postMedia"]),
    resourceId: z.string().min(1).max(64),
    sourceType: z.enum([
      "UNKNOWN",
      "HUMAN_CREATED",
      "AI_EDITED",
      "AI_ASSISTED",
      "AI_GENERATED",
    ]),
    // MANDATORY and substantive. This is the rectification record: "corrected on
    // request of the author, who states the photograph is their own" is what an
    // Art. 16 enquiry needs to see. A 3-character reason would make the audit
    // trail worthless, which is why there is a floor rather than just `.min(1)`.
    // UNKNOWN is accepted as a target here (unlike the author-facing schemas,
    // which exclude it) precisely because erasing a wrong claim is the main use.
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

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
 * Shared preamble: authenticate + resolve MODERATOR role server-side from the
 * User table (DB-authoritative), never from a request body or a token claim.
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

  const region = (requestContext?.region ||
    env.DEFAULT_REGION ||
    "EU") as Region;
  const db = DataRouter.getDatabaseForRegion(region, env) as any;
  const role = await new MediaReviewHandler().resolveModeratorRole(
    db,
    session.userId,
  );
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

/** Per-resource column mapping. The two column PAIRS differ; the shape does not. */
const RESOURCE_MAP = {
  post: {
    delegate: "post",
    sourceColumn: "textSourceType",
    basisColumn: "textBasis",
    auditResource: "post",
  },
  comment: {
    delegate: "postComment",
    sourceColumn: "textSourceType",
    basisColumn: "textBasis",
    auditResource: "comment",
  },
  postMedia: {
    delegate: "postMedia",
    sourceColumn: "declaredSourceType",
    basisColumn: "declaredBasis",
    auditResource: "post_media",
  },
} as const;

export const provenanceCorrectionRoutes: Route[] = [
  {
    path: CORRECTION_PATH,
    method: "POST",
    handler: async (request, env, { requestContext }) => {
      const securityHeaders = new SecurityHeaders(env);
      const logger = getLogger();
      const gate = await requireModerator(
        request,
        env,
        requestContext,
        securityHeaders,
      );
      if (!gate.ok) return gate.response;

      const validation = await validateRequest(request, correctionSchema);
      if (!validation.success) return validation.error;
      const body = validation.data;

      const map = RESOURCE_MAP[body.resource];

      try {
        const row = await gate.db[map.delegate].findUnique({
          where: { id: body.resourceId },
          select: {
            id: true,
            [map.sourceColumn]: true,
            [map.basisColumn]: true,
          },
        });

        if (!row) {
          return await json(securityHeaders, request, env, 404, {
            error: "NOT_FOUND",
            message: `No ${body.resource} with that id`,
          });
        }

        const plan = planCorrection(
          {
            sourceType: (row[map.sourceColumn] ??
              "UNKNOWN") as SyntheticSourceType,
            basis: row[map.basisColumn] ?? null,
          },
          body.sourceType as SyntheticSourceType,
        );

        if (plan.kind === "refuse") {
          // 409, not 400: the request is well-formed and the caller is
          // authorised — it conflicts with the stored state.
          return await json(securityHeaders, request, env, 409, {
            error: plan.code,
            message: plan.message,
          });
        }

        await gate.db[map.delegate].update({
          where: { id: body.resourceId },
          data: {
            [map.sourceColumn]: plan.to,
            [map.basisColumn]: plan.basis,
          },
        });

        // The audit write is NOT best-effort here, unlike on the author edit
        // path. A correction whose record failed to persist is a rectification we
        // cannot evidence, which defeats the purpose — so a failed audit write
        // fails the request, loudly, and the caller retries.
        const { TrellisAuditLogger } = await import("../audit-composer.js");
        const { PROVENANCE_CHANGED } = await import("../audit-actions.js");
        await new TrellisAuditLogger(env).log(
          {
            type: "data_update",
            action: PROVENANCE_CHANGED,
            resource: map.auditResource,
            resourceId: body.resourceId,
            // The MODERATOR's user id — the actor, PII-minimised. No email, no
            // ipAddress, no userAgent: a provenance correction needs none of
            // them, and this must not become a new client-metadata path.
            userId: gate.userId,
            region: gate.region,
            metadata: {
              field: map.sourceColumn,
              from: plan.from,
              to: plan.to,
              basis: plan.basis,
              // The discriminator that makes staff corrections queryable.
              // PROVENANCE_CHANGED deliberately covers both directions (see
              // audit-actions.ts), so the action alone cannot distinguish a
              // routine author raise from a reviewed correction.
              staffCorrection: true,
              reducesDisclosure: plan.reducesDisclosure,
              reason: body.reason,
            },
            // A reduction removes a disclosure from published content, which is
            // the outcome an auditor would want surfaced; a staff-applied raise
            // is unremarkable.
            severity: plan.reducesDisclosure ? "medium" : "low",
            success: true,
          },
          env,
        );

        // Any cached response carrying the old label must go, or the correction
        // is invisible until the TTL expires.
        try {
          const { FeedHandler } = await import("../feed-handler.js");
          await FeedHandler.invalidateFeedCache(env as any);
        } catch (cacheError) {
          // Cache invalidation is best-effort: the correction and its audit
          // record are already durable, and failing the request here would
          // invite a retry that re-applies nothing (the plan would then refuse
          // as PROVENANCE_UNCHANGED) while looking like a failure.
          logger.warn(
            "[ProvenanceCorrection] feed cache invalidation failed",
            cacheError,
          );
        }

        return await json(securityHeaders, request, env, 200, {
          resource: body.resource,
          resourceId: body.resourceId,
          from: plan.from,
          to: plan.to,
          basis: plan.basis,
          reducesDisclosure: plan.reducesDisclosure,
        });
      } catch (error) {
        logger.error("[ProvenanceCorrection] correction failed:", error);
        return await json(securityHeaders, request, env, 500, {
          error: "Failed to apply provenance correction",
        });
      }
    },
    middleware: [corsMiddleware(), csrfMiddleware()],
    description:
      "Staff-reviewed provenance correction, the only path that can reduce a disclosure (MODERATOR only)",
  },
];
