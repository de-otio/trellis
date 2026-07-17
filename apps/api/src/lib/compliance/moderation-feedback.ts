// Submit-for-analysis (spec 07 §4.2 / plan 08 Phase 2). The consent-gated,
// lawful-content false-positive capture path — and the CSAM/illegal CARVE-OUT.
//
//   POST /api/moderation/feedback   (auth; rate-limited + deduped at the route)
//   body { resourceType, resourceId, description?, includeContent, consent,
//          content? }   consent MUST be literally true, else 400.
//
// The block class is RE-DERIVED SERVER-SIDE — never trusted from the client:
//   - media : read the stored, server-only MediaFile.blockClass (owner-scoped).
//   - text  : re-run the injected text-moderation provider over the submitted
//             content and derive the class from the reserved illegal label.
//
// Branch:
//   - illegal-suspected → REFUSE the sink; route to preserve-in-place + a
//     `pending` AuthorityReport (operator-confirmed, NEVER auto-submitted);
//     return a NEUTRAL 202 indistinguishable from accept (no illegal oracle).
//   - lawful-flagged    → write ONE record via the ModerationFeedbackSink seam;
//     return 202.
// Either way the content STAYS blocked — nothing here reinstates or serves it.

import type { Env } from "../../env.js";
import type { Session } from "../session-cookie.js";
import type { TrellisRequestContext } from "../request-context.js";
import type { Region } from "../region-detection.js";
import type { BlockClass } from "../media/compliance-seams.js";
import { DataRouter } from "../data-router.js";
import { getLogger } from "../logger.js";
import { TrellisAuditLogger } from "../audit-composer.js";
import {
  MODERATION_FEEDBACK_CAPTURED,
  MODERATION_FEEDBACK_ILLEGAL_ROUTED,
} from "../audit-actions.js";
import {
  getEvidencePreservationStore,
  getModerationFeedbackSink,
  isEvidencePreservationConfigured,
  ComplianceSeamNotConfiguredError,
  type EvidenceBundle,
} from "../media/compliance-seams.js";
import { deriveBlockClass } from "./block-class.js";
import { getTextModerationProvider } from "../media/request-text-moderation.js";
import {
  createPendingAuthorityReport,
  type AuthorityReportDb,
} from "./authority-report.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

export const FEEDBACK_RESOURCE_TYPES = ["post", "comment", "media"] as const;
export type FeedbackResourceType = (typeof FEEDBACK_RESOURCE_TYPES)[number];

/**
 * The NEUTRAL success response. Identical for the lawful accept AND the illegal
 * carve-out — it deliberately says nothing about outcome or class, so a client
 * (or a prober) cannot tell an illegal item from a lawful one.
 */
function neutralAccepted(): Response {
  return new Response(JSON.stringify({ received: true }), {
    status: 202,
    headers: JSON_HEADERS,
  });
}

/** Deterministic idempotency key — stable across retries; no raw content. */
export function feedbackDedupKey(
  userId: string,
  resourceType: string,
  resourceId: string,
): string {
  return `${userId}:${resourceType}:${resourceId}`;
}

export class ModerationFeedbackHandler {
  async handleSubmit(
    request: Request,
    session: Session,
    env: Env,
    requestContext: TrellisRequestContext,
  ): Promise<Response> {
    const logger = getLogger();
    const region: Region = requestContext.region;
    const db = DataRouter.getDatabaseForRegion(region, env);

    let parsedBody: {
      resourceType: FeedbackResourceType;
      resourceId: string;
      description?: string;
      includeContent: boolean;
      consent: boolean;
      content?: string;
    };
    try {
      const { z } = await import("zod");
      const schema = z.object({
        resourceType: z.enum(FEEDBACK_RESOURCE_TYPES),
        resourceId: z.string().min(1).max(512),
        description: z.string().max(2000).optional(),
        includeContent: z.boolean(),
        // Must be literally true — z.literal(true) rejects false/missing → 400.
        consent: z.literal(true),
        // Author-provided text for server-side re-derivation (post/comment).
        content: z.string().max(20000).optional(),
      });
      const parsed = schema.safeParse(await request.json().catch(() => ({})));
      if (!parsed.success) {
        return new Response(
          JSON.stringify({
            error: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "Invalid feedback",
          }),
          { status: 400, headers: JSON_HEADERS },
        );
      }
      parsedBody = parsed.data;
    } catch (error) {
      logger.error("[Feedback] parse failed", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }

    try {
      const { resourceType, resourceId, description, includeContent, content } =
        parsedBody;

      // Re-derive the block class SERVER-SIDE. On not-found / non-owner for
      // media, return the neutral 202 (never reveal existence/ownership).
      const derivation = await this.rederiveBlockClass(
        db,
        session.userId,
        resourceType,
        resourceId,
        content,
      );
      if (derivation.kind === "not-owned") {
        return neutralAccepted();
      }
      const blockClass = derivation.blockClass;

      const audit = new TrellisAuditLogger(env);

      if (blockClass === "illegal-suspected") {
        // CARVE-OUT: never the sink. Preserve + pending AuthorityReport.
        await this.routeIllegalToPreserveAndReport(
          db,
          {
            resourceType,
            resourceId,
            userId: session.userId,
            bytesLocation: derivation.bytesLocation,
          },
          env,
          region,
        );
        await audit.logSystemAction(
          MODERATION_FEEDBACK_ILLEGAL_ROUTED,
          {
            resource: resourceType,
            resourceId,
            userId: session.userId,
            region,
            success: true,
            severity: "critical",
            // Neutral: NO classifier detail.
            metadata: { routed: "preserve+authority-report" },
          },
          env,
        );
        // NEUTRAL — indistinguishable from the lawful accept below.
        return neutralAccepted();
      }

      // LAWFUL false-positive: write exactly ONE record to the sink.
      await getModerationFeedbackSink().store({
        resourceType,
        resourceId,
        reporterUserId: session.userId,
        ...(description ? { description } : {}),
        includeContent,
        dedupKey: feedbackDedupKey(session.userId, resourceType, resourceId),
        blockClass,
      });
      await audit.logSystemAction(
        MODERATION_FEEDBACK_CAPTURED,
        {
          resource: resourceType,
          resourceId,
          userId: session.userId,
          region,
          success: true,
          severity: "low",
        },
        env,
      );

      return neutralAccepted();
    } catch (error) {
      // A missing evidence store on an illegal item throws here (fail-safe,
      // loud) — surfaced as a generic 500, which is NOT an illegal oracle (any
      // internal fault looks the same).
      logger.error("[Feedback] submit failed", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: JSON_HEADERS,
      });
    }
  }

  /**
   * Re-derive the server-only block class. NEVER trusts a client-supplied class.
   * - media: read stored MediaFile.blockClass, owner-scoped (uploadedBy).
   * - text : re-run the injected text provider over `content` (if provided).
   */
  private async rederiveBlockClass(
    db: ReturnType<typeof DataRouter.getDatabaseForRegion>,
    userId: string,
    resourceType: FeedbackResourceType,
    resourceId: string,
    content: string | undefined,
  ): Promise<
    | { kind: "ok"; blockClass: BlockClass; bytesLocation?: { bucket: string; key: string } }
    | { kind: "not-owned" }
  > {
    if (resourceType === "media") {
      const media = await db.mediaFile.findUnique({
        where: { id: resourceId },
        select: {
          uploadedBy: true,
          blockClass: true,
          tenantId: true,
          contentHash: true,
        },
      });
      if (!media || media.uploadedBy !== userId) {
        return { kind: "not-owned" };
      }
      const blockClass = (media.blockClass as BlockClass | null) ?? "lawful-flagged";
      // Bytes live in the tenant-scoped processing/CAS space; pass a REF only.
      const bytesLocation =
        media.contentHash != null
          ? { bucket: "processing", key: `${media.tenantId}/${media.contentHash}` }
          : undefined;
      return { kind: "ok", blockClass, ...(bytesLocation ? { bytesLocation } : {}) };
    }

    // Text (post/comment): re-run moderation over the submitted content. No
    // content to classify → lawful-flagged (nothing to route as illegal, and
    // nothing to preserve).
    if (content && content.length > 0) {
      const verdict = await getTextModerationProvider().moderateText(content);
      return { kind: "ok", blockClass: deriveBlockClass(verdict) };
    }
    return { kind: "ok", blockClass: "lawful-flagged" };
  }

  /**
   * Route an illegal-class item to preserve-in-place + a `pending`
   * AuthorityReport. Fails LOUD (throws {@link ComplianceSeamNotConfiguredError})
   * if no evidence store is injected — a deployment MUST wire one before enabling
   * any illegal category. NEVER auto-submits the authority report.
   */
  private async routeIllegalToPreserveAndReport(
    db: ReturnType<typeof DataRouter.getDatabaseForRegion>,
    ref: {
      resourceType: FeedbackResourceType;
      resourceId: string;
      userId: string;
      bytesLocation?: { bucket: string; key: string };
    },
    env: Env,
    region: Region,
  ): Promise<void> {
    if (!isEvidencePreservationConfigured()) {
      throw new ComplianceSeamNotConfiguredError("EvidencePreservationStore");
    }

    const bundle: EvidenceBundle = {
      contentRef: `${ref.resourceType}:${ref.resourceId}`,
      ...(ref.bytesLocation ? { bytesLocation: ref.bytesLocation } : {}),
      uploaderContext: { userId: ref.userId },
      timestamps: { routedAt: new Date().toISOString() },
    };
    const { evidenceId } = await getEvidencePreservationStore().preserve(bundle);

    // Set the evidence hold on the original media so the hard-delete GC path and
    // the account-deletion cascade skip it (the case is now open).
    if (ref.resourceType === "media") {
      await db.mediaFile.update({
        where: { id: ref.resourceId },
        data: { evidenceHold: true, evidenceId, hidden: true },
      });
    }

    const jurisdiction =
      (env as unknown as { COMPLIANCE_JURISDICTION?: string }).COMPLIANCE_JURISDICTION ??
      "UNKNOWN";

    await createPendingAuthorityReport(
      // The managed client satisfies the structural slice; the cast only bridges
      // Prisma's invariant Json input type for `bundle`.
      db as unknown as AuthorityReportDb,
      {
        jurisdiction,
        evidenceId,
        // Refs, never bytes.
        bundle: {
          contentRef: bundle.contentRef,
          uploaderContext: bundle.uploaderContext,
        },
      },
      env,
      region,
    );
  }
}
