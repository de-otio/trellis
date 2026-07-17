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
import { processingKey, isCasKeyError } from "../media/cas-keys.js";
import {
  createPendingAuthorityReport,
  type AuthorityReportDb,
} from "./authority-report.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * The literal placeholder that MUST NEVER be used as an evidence copy-source
 * bucket. `"processing"` is a CAS key PREFIX inside the media bucket (see
 * cas-keys.ts), not a bucket name — handing it to the evidence store's
 * `CopyObject` as the source bucket fails `NoSuchBucket` and the WORM criminal-
 * evidence bytes silently fail to preserve (V2 Finding G).
 */
const PLACEHOLDER_EVIDENCE_BUCKET = "processing";

/**
 * Thrown when the evidence copy-source cannot be resolved to a REAL configured
 * bucket. Surfaces as a generic 500 (not an illegal oracle — any internal fault
 * looks identical), and — critically — happens BEFORE any preserve/mutation, so
 * an illegal item is never half-preserved (manifest without bytes).
 */
export class ComplianceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceConfigurationError";
  }
}

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
      // media/post/comment, return the neutral 202 (never reveal existence/
      // ownership). The evidence copy-source bucket comes from the SAME single
      // env value the media pipeline/moderation read path uses.
      const derivation = await this.rederiveBlockClass(
        db,
        session.userId,
        resourceType,
        resourceId,
        content,
        env.MEDIA_BUCKET_NAME,
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
      //
      // Secondary LOW (V2): `description` is user free text that reaches the
      // write-only analysis sink. The sink adapter's illegal-record refusal keys
      // on the RESOURCE blockClass, not on this field — so a lawful record could
      // still smuggle attacker-supplied illegal text through the description
      // channel. Moderate it with the SAME provider and DROP it fail-closed
      // (illegal-suspected OR a moderation fault) so illegal bytes can never
      // enter the analysis corpus via `description`.
      let safeDescription = description;
      if (safeDescription) {
        try {
          const dVerdict =
            await getTextModerationProvider().moderateText(safeDescription);
          if (deriveBlockClass(dVerdict) === "illegal-suspected") {
            safeDescription = undefined;
          }
        } catch {
          safeDescription = undefined;
        }
      }
      await getModerationFeedbackSink().store({
        resourceType,
        resourceId,
        reporterUserId: session.userId,
        ...(safeDescription ? { description: safeDescription } : {}),
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
   * - text : classify the STORED post/comment loaded by resourceId, owner-scoped
   *          — NEVER the client-supplied `content` (see the text branch below).
   */
  private async rederiveBlockClass(
    db: ReturnType<typeof DataRouter.getDatabaseForRegion>,
    userId: string,
    resourceType: FeedbackResourceType,
    resourceId: string,
    content: string | undefined,
    mediaBucketName: string,
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
      // Evidence copy-source (V2 Finding G). The blocked item's ORIGINAL bytes
      // live in the REAL media bucket under the canonical `processing/{tenantId}/
      // {hash}` staging key (cleaned-but-unapproved bytes — see cas-keys.ts).
      // Source the bucket from the SAME single env value the media pipeline and
      // the moderation read path use (MEDIA_BUCKET_NAME) — NEVER a hardcoded
      // placeholder, which would make the WORM evidence CopyObject fail and the
      // criminal-evidence bytes silently not preserve. A null hash / invalid key
      // yields no bytesLocation; the illegal path then fails LOUD (see
      // routeIllegalToPreserveAndReport) rather than half-preserving.
      let bytesLocation: { bucket: string; key: string } | undefined;
      if (media.contentHash != null) {
        const key = processingKey(media.tenantId, media.contentHash);
        if (!isCasKeyError(key)) {
          bytesLocation = { bucket: mediaBucketName, key };
        }
      }
      return { kind: "ok", blockClass, ...(bytesLocation ? { bytesLocation } : {}) };
    }

    // Text (post/comment): classify the STORED resource loaded by resourceId,
    // owner-scoped — NEVER the client-supplied `content` (V2 HOLE #2). Deriving
    // the class from client text lets an attacker relabel an illegal STORED
    // resource `lawful-flagged` by submitting benign `content` for its
    // resourceId; that mislabelled pointer (with includeContent) is a latent
    // trap for any future sink consumer that resolves resourceId back to bytes.
    // Mirrors the media branch's stored + owner-scoped read.
    const stored = await this.loadStoredText(db, resourceType, resourceId);
    if (stored) {
      if (stored.authorId !== userId) {
        return { kind: "not-owned" };
      }
      const verdict = await getTextModerationProvider().moderateText(stored.text);
      return { kind: "ok", blockClass: deriveBlockClass(verdict) };
    }

    // No stored resource for this id (e.g. text rejected AT CREATION and never
    // persisted). The client `content` is then the ONLY text that exists, and
    // there is no stored resource a downstream consumer could resolve resourceId
    // back to — so classifying it here carries no relabel/mislabel risk. No
    // content at all → lawful-flagged (nothing to route illegal, nothing to
    // preserve).
    if (content && content.length > 0) {
      const verdict = await getTextModerationProvider().moderateText(content);
      return { kind: "ok", blockClass: deriveBlockClass(verdict) };
    }
    return { kind: "ok", blockClass: "lawful-flagged" };
  }

  /**
   * Load the STORED text + owner of a post/comment by id (owner-scoping and
   * classification target for the text branch). Returns null when no row exists
   * (e.g. rejected-at-creation, never persisted).
   */
  private async loadStoredText(
    db: ReturnType<typeof DataRouter.getDatabaseForRegion>,
    resourceType: "post" | "comment",
    resourceId: string,
  ): Promise<{ authorId: string; text: string } | null> {
    if (resourceType === "post") {
      return db.post.findUnique({
        where: { id: resourceId },
        select: { authorId: true, text: true },
      });
    }
    return db.postComment.findUnique({
      where: { id: resourceId },
      select: { authorId: true, text: true },
    });
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

    // Fail LOUD (V2 Finding G): an illegal MEDIA item MUST have a resolvable,
    // REAL evidence copy-source before we preserve. A missing/placeholder source
    // bucket would make the WORM content copy fail (NoSuchBucket) and preserve
    // ONLY the manifest — silently losing the criminal-evidence bytes. Refuse
    // (throw, before any preserve/mutation) rather than half-preserve. Text has
    // no S3 bytes to copy, so this guard is media-only.
    if (ref.resourceType === "media") {
      const loc = ref.bytesLocation;
      if (!loc || !loc.bucket || loc.bucket === PLACEHOLDER_EVIDENCE_BUCKET) {
        throw new ComplianceConfigurationError(
          "Evidence copy-source bucket for illegal media is unset or a " +
            `placeholder (got: ${loc?.bucket ?? "<none>"}). MEDIA_BUCKET_NAME ` +
            "must resolve to the real media bucket so the WORM evidence copy can " +
            "read the original bytes. Refusing to preserve manifest-only.",
        );
      }
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
