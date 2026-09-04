// Owner-scoped media disposition read (spec 07 §4.1 / plan 08 Phase 2).
//
//   GET /api/media/:mediaId/disposition   (auth; OWNER-ONLY)
//   → 200 { status: "approved" | "pending" | "blocked", appealable: boolean }
//   → 404 IDENTICAL for not-found AND non-owner (anti-oracle: no existence
//        oracle for a third party; a prober can never distinguish the two).
//
// Coarse by construction: the response NEVER carries category, label, confidence,
// provider, or the internal block class. `appealable` is the ONLY bit derived
// from the server-only block class that crosses the boundary.

import type { Env } from "../../env.js";
import type { Session } from "../session-cookie.js";
import type { TrellisRequestContext } from "../request-context.js";
import type { MediaLifecycle } from "../media/media-lifecycle.js";
import type { BlockClass } from "../media/compliance-seams.js";
import { DataRouter } from "../data-router.js";
import { getLogger } from "../logger.js";
import { isAppealable } from "./block-class.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export type DispositionStatus = "approved" | "pending" | "blocked";

export interface DispositionResult {
  status: DispositionStatus;
  appealable: boolean;
}

/**
 * Pure disposition mapping. `approved` iff APPROVED and neither hidden nor
 * soft-deleted (mirrors the serve gate). `pending` for the pre-verdict states.
 * Everything else — REVIEW/QUARANTINED/REJECTED/UPLOAD_FAILED, or an
 * APPROVED-but-hidden/deleted object — is `blocked`. `appealable` is true only
 * for a blocked, non-illegal-class item.
 */
export function computeDisposition(record: {
  lifecycle: MediaLifecycle;
  hidden: boolean;
  deletedAt: Date | null;
  blockClass: BlockClass | null;
}): DispositionResult {
  const approved =
    record.lifecycle === "APPROVED" && !record.hidden && record.deletedAt === null;
  if (approved) return { status: "approved", appealable: false };

  const pending =
    record.lifecycle === "AWAITING_UPLOAD" || record.lifecycle === "UPLOADED";
  if (pending) return { status: "pending", appealable: false };

  // Blocked: appealable only if NOT illegal-class (the carve-out).
  return { status: "blocked", appealable: isAppealable(record.blockClass) };
}

/** The uniform not-found response — byte-identical for not-found AND non-owner. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: JSON_HEADERS,
  });
}

export class ModerationDispositionHandler {
  async handleGet(
    mediaId: string,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    const logger = getLogger();
    const region = requestContext?.region || env.DEFAULT_REGION || "EU";
    const db = DataRouter.getDatabaseForRegion(region, env);

    try {
      const media = await db.mediaFile.findUnique({
        where: { id: mediaId },
        select: {
          uploadedBy: true,
          lifecycle: true,
          hidden: true,
          deletedAt: true,
          blockClass: true,
        },
      });

      // Anti-oracle: not-found AND not-owner return the SAME 404. A non-owner
      // must never learn the item exists, and even the owner never learns which
      // classifier fired.
      if (!media || media.uploadedBy !== session.userId) {
        return notFound();
      }

      const disposition = computeDisposition({
        lifecycle: media.lifecycle as MediaLifecycle,
        hidden: media.hidden,
        deletedAt: media.deletedAt,
        blockClass: (media.blockClass as BlockClass | null) ?? null,
      });

      return new Response(JSON.stringify(disposition), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      logger.error("[Disposition] lookup failed", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }
}
