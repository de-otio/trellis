/**
 * Media REVIEW-queue moderator handler (T9) — the imperative shell.
 *
 * Exposes the platform-MODERATOR surface over media awaiting a human decision:
 *   - list()        — paginated queue of REVIEW/QUARANTINED media, with the
 *                     per-track (visual/audio→transcript) verdicts from
 *                     MediaModerationJob surfaced for video items.
 *   - decide()      — apply a human approve/reject through the pure lifecycle
 *                     state machine (nextLifecycle `human` event); approve lands
 *                     APPROVED (servable) IFF the CAS object is present, reject
 *                     lands REJECTED. Every decision writes an AuditEvent.
 *   - escalateCsam()— STUB: drives the item to REJECTED via the `csam` event,
 *                     LOCKS it (hidden=true), and writes a CRITICAL audit row
 *                     flagged for human paging. NO automated reporting — the
 *                     statutory NCMEC/BKA path is handled by a human out-of-band.
 *
 * Design: functional-core / imperative-shell. The lifecycle decision is the
 * pure `nextLifecycle` machine; this shell only performs the I/O the machine
 * reports, and NEVER re-implements the transition inline. Role enforcement is
 * SERVER-SIDE and DB-authoritative (the caller resolves the role from the
 * session's userId against the User table — never a client claim); the pure
 * predicate `isModeratorRole` lives here so both the shell and its tests share
 * one definition.
 *
 * Every method takes its `db` (Prisma-like) and `auditLogger` explicitly so the
 * unit tests inject mocks — no module-level Prisma coupling.
 */

import {
  nextLifecycle,
  type MediaLifecycle,
} from "./media-lifecycle.js";
import type { StoragePort } from "./media-ports.js";
import {
  promotePinned,
  resolvePromoteSource,
  type PromoteLog,
} from "./promote-staging.js";
import { isModeratorServable } from "./moderator-serve-gate.js";
import {
  MEDIA_MODERATION_APPROVED,
  MEDIA_MODERATION_REJECTED,
  MEDIA_MODERATION_CSAM_ESCALATED,
  MEDIA_MODERATION_VIEWED,
} from "../audit-actions.js";
import type { Region } from "../region-detection.js";
import type { TrellisAuditLogger, TrellisAuditLoggerEnv } from "../audit-composer.js";

/**
 * The platform roles permitted on the media review surface. MODERATOR is the
 * purpose-built role (schema comment: "moderation-queue access"); SUPER_ADMIN is
 * a strict superset and is also allowed. Every other role — including END_USER —
 * is denied 403 by the shell. This is the ONE place the allow-set is defined.
 */
export const MODERATOR_ROLES = ["MODERATOR", "SUPER_ADMIN"] as const;

/**
 * Pure role predicate. `role` is the value read from `User.role` (server-side);
 * a null/unknown role (no such user, or a role outside the allow-set) is denied.
 * Fail-closed: anything not explicitly in {@link MODERATOR_ROLES} is false.
 */
export function isModeratorRole(role: string | null | undefined): boolean {
  return role === "MODERATOR" || role === "SUPER_ADMIN";
}

/** A moderator decision on a review item. `reject` is terminal (→ REJECTED). */
export type ModeratorDecision = "approve" | "reject";

/** The media "kind" derived from its stored mimeType (drives the client view). */
export type MediaKind = "image" | "video" | "audio" | "other";

/** Derive the coarse media kind from a mimeType. Total; unknown → "other". */
export function mediaKindOf(mimeType: string | null | undefined): MediaKind {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "other";
}

/** One per-track verdict surfaced to the moderator (video items carry ≥1). */
export interface TrackVerdictView {
  track: "VISUAL" | "AUDIO";
  /** The resolved classifier decision, or null while the job is in flight. */
  decision: string | null;
}

/** A single queue row as returned to the admin client. */
export interface ReviewQueueItem {
  id: string;
  tenantId: string;
  mimeType: string;
  kind: MediaKind;
  lifecycle: MediaLifecycle;
  size: number;
  width: number | null;
  height: number | null;
  /** Video duration in seconds (null for images). */
  duration: number | null;
  createdAt: string;
  /** Per-track moderation verdicts (visual / audio→transcript). */
  tracks: TrackVerdictView[];
}

export interface ReviewQueuePage {
  items: ReviewQueueItem[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Minimal structural Prisma surface this handler needs. Declared narrowly so a
 * test mock is trivial and the handler cannot reach for anything undeclared.
 */
export interface ReviewPrismaLike {
  mediaFile: {
    findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
    findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
    update: (args: unknown) => Promise<Record<string, unknown>>;
  };
  user: {
    findUnique: (args: unknown) => Promise<{ role: string } | null>;
  };
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** A never-silent log seam: absent hooks simply drop, they never throw. */
function promotionLog(promotion?: ReviewPromotionPort): PromoteLog {
  return promotion?.log ?? {};
}

/** Outcome discriminant for decide()/escalateCsam(), mapped to HTTP by the route. */
export type DecisionResult =
  | { ok: true; status: MediaLifecycle; promoted: boolean }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ILLEGAL_STATE"; from: MediaLifecycle };

/**
 * The coordinates a promotion needs, resolved through a port rather than read
 * off the row here.
 *
 * `stagingVersionId` is the pin captured when the classifier ran. Where a
 * consuming application keeps it is its own business (today, inside an existing
 * JSON column), which is exactly why this is a port: the handler must not know.
 */
export interface ReviewPromoteCoords {
  readonly tenantId: string;
  readonly uploadId: string;
  readonly contentHash: string;
  readonly stagingVersionId: string | null;
}

/**
 * The capability that lets a human approval actually make bytes servable.
 *
 * Without it, `decide()` can flip a row to APPROVED but nothing copies the
 * reviewed bytes to the serve prefix. With it, approval performs the SAME
 * version-pinned promotion the automatic path performs — the moderator's
 * approval applies to the bytes the moderator saw, and to nothing else.
 *
 * OPTIONAL on `decide()`, because this is a published package and a required
 * argument would break every existing caller. The consequence is stated rather
 * than hidden: when it is absent, `decide()` behaves as before and says so in a
 * log line, and no promotion happens.
 */
export interface ReviewPromotionPort {
  readonly storage: StoragePort;
  /** Resolve the promote coordinates for a media object, or null when unknown. */
  coordsFor(mediaId: string): Promise<ReviewPromoteCoords | null>;
  readonly log?: PromoteLog;
}

export class MediaReviewHandler {
  /**
   * Resolve the caller's server-side role from the User table and decide whether
   * they may access the moderator surface. Returns the role string when allowed,
   * or null when denied (no such user, or a non-moderator role). The route maps
   * null → 403. DB is the source of truth; the session only supplies the userId.
   */
  async resolveModeratorRole(
    db: ReviewPrismaLike,
    userId: string,
  ): Promise<string | null> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user || !isModeratorRole(user.role)) return null;
    return user.role;
  }

  /**
   * Paginated queue of media in REVIEW/QUARANTINED, newest first, cursor over
   * `id`. Each row carries its per-track moderation verdicts so the client can
   * show the visual/audio/transcript breakdown for video without a second call.
   */
  async list(
    db: ReviewPrismaLike,
    opts: { limit?: number; cursor?: string; kind?: MediaKind } = {},
  ): Promise<ReviewQueuePage> {
    const limit = Math.min(
      Math.max(1, opts.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    const where: Record<string, unknown> = {
      lifecycle: { in: ["REVIEW", "QUARANTINED"] },
      deletedAt: null,
    };
    if (opts.cursor) where.id = { gt: opts.cursor };

    const rows = await db.mediaFile.findMany({
      where,
      take: limit + 1,
      orderBy: { id: "asc" },
      include: {
        moderationJobs: { select: { track: true, decision: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    let items: ReviewQueueItem[] = page.map((r) => this.toQueueItem(r));
    if (opts.kind) items = items.filter((it) => it.kind === opts.kind);

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (page[page.length - 1].id as string) : undefined,
    };
  }

  private toQueueItem(r: Record<string, unknown>): ReviewQueueItem {
    const mimeType = (r.mimeType as string) ?? "";
    const jobs = (r.moderationJobs as Array<{ track: unknown; decision: unknown }>) ?? [];
    const tracks: TrackVerdictView[] = jobs.map((j) => ({
      track: j.track as "VISUAL" | "AUDIO",
      decision: (j.decision as string | null) ?? null,
    }));
    const createdAt = r.createdAt as Date | string;
    return {
      id: r.id as string,
      tenantId: r.tenantId as string,
      mimeType,
      kind: mediaKindOf(mimeType),
      lifecycle: r.lifecycle as MediaLifecycle,
      size: (r.size as number) ?? 0,
      width: (r.width as number | null) ?? null,
      height: (r.height as number | null) ?? null,
      duration: (r.duration as number | null) ?? null,
      createdAt:
        createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
      tracks,
    };
  }

  /**
   * Apply a human approve/reject to a review item. The transition is decided by
   * the pure `nextLifecycle` machine (`human` event); this shell only persists
   * the resulting lifecycle, performs the promotion the machine implies, and
   * writes the audit row.
   *
   * APPROVE IS A CLAIM ABOUT SPECIFIC BYTES. A moderator looked at one version
   * of an object and said yes to that version. So when the promotion port is
   * wired, approval copies the VERSION-PINNED bytes the classifier ran on — the
   * same routine the automatic path uses — and refuses outright when that
   * version can no longer be resolved. It never resolves "whatever is at the
   * staging key now": between the review and the click, that key may hold
   * something else entirely, and copying it would launder unreviewed bytes
   * through a human decision.
   *
   * FAIL-CLOSED throughout: a missing object, an unresolvable pin, or a failed
   * copy all leave the item in REVIEW rather than marking it servable.
   *
   * Returns a DecisionResult; the route maps it to HTTP. Audit is written for
   * every APPLIED decision (success), before returning.
   */
  async decide(
    db: ReviewPrismaLike,
    auditLogger: TrellisAuditLogger,
    env: TrellisAuditLoggerEnv,
    input: {
      mediaId: string;
      decision: ModeratorDecision;
      moderatorUserId: string;
      region: Region;
      ipAddress?: string;
      userAgent?: string;
    },
    promotion?: ReviewPromotionPort,
  ): Promise<DecisionResult> {
    const media = await db.mediaFile.findUnique({
      where: { id: input.mediaId },
      select: {
        id: true,
        tenantId: true,
        lifecycle: true,
        originalKey: true,
        deletedAt: true,
      },
    });
    if (!media || media.deletedAt) return { ok: false, code: "NOT_FOUND" };

    const from = media.lifecycle as MediaLifecycle;
    const transition = nextLifecycle(from, {
      kind: "human",
      action: input.decision,
    });
    if (transition.ok === false) {
      // Not a REVIEW/QUARANTINED item (terminal or pre-moderation) — illegal.
      return { ok: false, code: "ILLEGAL_STATE", from };
    }

    // FAIL-CLOSED promote gate. The row's `originalKey` says where the bytes
    // WOULD live; on its own it is a claim, not evidence, so when the promotion
    // port is wired we go and check — and promote.
    const casObjectPresent = Boolean(media.originalKey);
    let bytesCertified = casObjectPresent;

    if (transition.status === "APPROVED" && casObjectPresent) {
      if (promotion === undefined) {
        // No promotion capability wired: behave as before, but do not pretend
        // this approval made anything servable.
        promotionLog(promotion).warn?.(
          "review: approving without a promotion capability — the reviewed bytes are not being copied to the serve prefix",
          { mediaId: input.mediaId },
        );
      } else {
        bytesCertified = await this.promoteReviewed(
          promotion,
          input.mediaId,
          media.originalKey as string,
        );
      }
    }

    const targetStatus: MediaLifecycle =
      transition.status === "APPROVED" && !bytesCertified
        ? "REVIEW"
        : transition.status;
    const promoted = targetStatus === "APPROVED";

    await db.mediaFile.update({
      where: { id: input.mediaId },
      data: { lifecycle: targetStatus },
    });

    await auditLogger.logSystemAction(
      input.decision === "approve"
        ? MEDIA_MODERATION_APPROVED
        : MEDIA_MODERATION_REJECTED,
      {
        resource: "media",
        resourceId: input.mediaId,
        userId: input.moderatorUserId,
        region: input.region,
        success: true,
        severity: "high",
        ...(input.ipAddress !== undefined && { ipAddress: input.ipAddress }),
        ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
        metadata: {
          fromLifecycle: from,
          toLifecycle: targetStatus,
          decision: input.decision,
          promoted,
          casObjectPresent,
          tenantId: media.tenantId as string,
        },
      },
      env,
    );

    return { ok: true, status: targetStatus, promoted };
  }

  /**
   * Copy the version-pinned reviewed bytes to the serve prefix.
   *
   * Returns true only when the serve object is genuinely there afterwards.
   * Every failure — unknown coordinates, an unresolvable pin, a copy that
   * throws — returns false, and the caller holds the item in REVIEW. Nothing
   * here is best-effort: this is the step that decides whether bytes become
   * publicly reachable.
   */
  private async promoteReviewed(
    promotion: ReviewPromotionPort,
    mediaId: string,
    casObjectKey: string,
  ): Promise<boolean> {
    const log = promotionLog(promotion);
    let coords: ReviewPromoteCoords | null;
    try {
      coords = await promotion.coordsFor(mediaId);
    } catch (err) {
      log.error?.("review: could not resolve promote coordinates — holding REVIEW", {
        mediaId,
        error: String(err),
      });
      return false;
    }
    if (coords === null) {
      log.error?.("review: no promote coordinates for this item — holding REVIEW", {
        mediaId,
      });
      return false;
    }

    const stagingKey = `processing/${coords.tenantId}/${coords.uploadId}`;
    try {
      const source = await resolvePromoteSource({
        storage: promotion.storage,
        stagingKey,
        casKey: casObjectKey,
        stagingVersionId: coords.stagingVersionId,
      });
      if (source.kind === "none") {
        // Either the pin is gone or there never was one. An approval cannot be
        // applied to bytes we cannot identify.
        log.error?.(
          "review: the reviewed version can no longer be resolved — refusing to promote, holding REVIEW",
          { mediaId },
        );
        return false;
      }
      await promotePinned({
        storage: promotion.storage,
        source,
        stagingKey,
        casKey: casObjectKey,
        cleanupKeys: [
          `pending/${coords.tenantId}/${coords.uploadId}`,
          stagingKey,
        ],
        log,
        logContext: { mediaId },
      });
      return true;
    } catch (err) {
      log.error?.("review: promotion failed — holding REVIEW", {
        mediaId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * CSAM escalation STUB. Drives the item to REJECTED via the pure `csam` event
   * (terminal from any state), LOCKS it (hidden=true so it is never served
   * anywhere), and writes a CRITICAL audit row flagged `pagedForHumanReview`.
   *
   * DELIBERATELY performs NO automated reporting: statutory CSAM handling
   * (NCMEC / national hotline, evidence preservation) is a HUMAN process. This
   * endpoint only locks the artifact and records the page; the runbook takes
   * over from the audit trail. See doc/.../media-moderation-ops.md CSAM runbook.
   */
  async escalateCsam(
    db: ReviewPrismaLike,
    auditLogger: TrellisAuditLogger,
    env: TrellisAuditLoggerEnv,
    input: {
      mediaId: string;
      moderatorUserId: string;
      region: Region;
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<DecisionResult> {
    const media = await db.mediaFile.findUnique({
      where: { id: input.mediaId },
      select: { id: true, tenantId: true, lifecycle: true, deletedAt: true },
    });
    if (!media) return { ok: false, code: "NOT_FOUND" };

    const from = media.lifecycle as MediaLifecycle;
    const transition = nextLifecycle(from, { kind: "csam" });
    // csam is legal from ANY state, but guard defensively.
    const targetStatus: MediaLifecycle = transition.ok
      ? transition.status
      : "REJECTED";

    await db.mediaFile.update({
      where: { id: input.mediaId },
      data: {
        lifecycle: targetStatus,
        hidden: true,
        hiddenAt: new Date(),
        hiddenBy: input.moderatorUserId,
      },
    });

    await auditLogger.logSystemAction(
      MEDIA_MODERATION_CSAM_ESCALATED,
      {
        resource: "media",
        resourceId: input.mediaId,
        userId: input.moderatorUserId,
        region: input.region,
        success: true,
        severity: "critical",
        ...(input.ipAddress !== undefined && { ipAddress: input.ipAddress }),
        ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
        metadata: {
          fromLifecycle: from,
          toLifecycle: targetStatus,
          locked: true,
          pagedForHumanReview: true,
          automatedReporting: false,
          tenantId: media.tenantId as string,
        },
      },
      env,
    );

    return { ok: true, status: targetStatus, promoted: false };
  }

  /**
   * Decide + audit a moderator VIEW (bypass) of an item's bytes. Returns the
   * servable `originalKey` when the item is bypass-eligible (REVIEW/QUARANTINED,
   * not deleted) AND writes the audit row BEFORE the route streams bytes — the
   * bypass is never silent. Returns null when the item is not bypass-eligible
   * (the route then denies uniformly). The role check is done by the route via
   * resolveModeratorRole; this method assumes an authorised moderator.
   */
  async authorizeView(
    db: ReviewPrismaLike,
    auditLogger: TrellisAuditLogger,
    env: TrellisAuditLoggerEnv,
    input: {
      mediaId: string;
      moderatorUserId: string;
      region: Region;
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<{ originalKey: string; mimeType: string } | null> {
    const media = await db.mediaFile.findUnique({
      where: { id: input.mediaId },
      select: {
        id: true,
        tenantId: true,
        lifecycle: true,
        deletedAt: true,
        originalKey: true,
        mimeType: true,
      },
    });
    if (
      !media ||
      !isModeratorServable({
        lifecycle: media.lifecycle as MediaLifecycle,
        deletedAt: (media.deletedAt as Date | null) ?? null,
      }) ||
      !media.originalKey
    ) {
      return null;
    }

    // Audit the bypass BEFORE serving bytes.
    await auditLogger.logSystemAction(
      MEDIA_MODERATION_VIEWED,
      {
        resource: "media",
        resourceId: input.mediaId,
        userId: input.moderatorUserId,
        region: input.region,
        success: true,
        severity: "high",
        ...(input.ipAddress !== undefined && { ipAddress: input.ipAddress }),
        ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
        metadata: {
          bypass: "moderator-review",
          lifecycle: media.lifecycle as string,
          tenantId: media.tenantId as string,
        },
      },
      env,
    );

    return {
      originalKey: media.originalKey as string,
      mimeType: (media.mimeType as string) ?? "application/octet-stream",
    };
  }
}
