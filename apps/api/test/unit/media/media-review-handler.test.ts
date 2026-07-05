/**
 * T9 — media REVIEW-queue moderator handler tests.
 *
 * Covers the auth-sensitive invariants:
 *  - role-denied: a non-MODERATOR is refused (resolveModeratorRole → null);
 *  - approve-promotes: a REVIEW item with CAS bytes → APPROVED (servable);
 *  - approve fail-closed: a REVIEW item WITHOUT CAS bytes is NOT promoted;
 *  - reject: a REVIEW item → REJECTED (state-machine `human` reject);
 *  - illegal state: a decision on a terminal item is refused (no write);
 *  - audit-row-written: every applied decision + the view-bypass emit an audit;
 *  - video item: per-track (VISUAL/AUDIO) verdicts are surfaced and decidable;
 *  - CSAM stub: locks (hidden) + drives REJECTED + critical audit, no automated
 *    reporting;
 *  - moderator view bypass: REVIEW/QUARANTINED served + audited, terminal denied.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  MediaReviewHandler,
  isModeratorRole,
  mediaKindOf,
  type ReviewPrismaLike,
} from "../../../src/lib/media/media-review-handler.js";
import {
  moderatorCanServe,
  isModeratorServable,
  MODERATOR_REVIEWABLE_LIFECYCLES,
} from "../../../src/lib/media/moderator-serve-gate.js";
import { ALL_MEDIA_LIFECYCLES } from "../../../src/lib/media/media-lifecycle.js";
import type { TrellisAuditLogger } from "../../../src/lib/audit-composer.js";

// A sp-yable audit logger: only logSystemAction is used by the handler.
function makeAuditLogger(): TrellisAuditLogger & {
  logSystemAction: ReturnType<typeof vi.fn>;
} {
  return {
    logSystemAction: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrellisAuditLogger & {
    logSystemAction: ReturnType<typeof vi.fn>;
  };
}

const env = { DEFAULT_REGION: "EU" } as never;

function makeDb(overrides: Partial<ReviewPrismaLike> = {}): ReviewPrismaLike & {
  mediaFile: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn> };
} {
  return {
    mediaFile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn() },
    ...overrides,
  } as never;
}

describe("isModeratorRole (pure server-side gate)", () => {
  it("allows MODERATOR and SUPER_ADMIN only", () => {
    expect(isModeratorRole("MODERATOR")).toBe(true);
    expect(isModeratorRole("SUPER_ADMIN")).toBe(true);
  });
  it("denies every other role and null/undefined (fail-closed)", () => {
    for (const r of [
      "END_USER",
      "B2B_PARTNER",
      "PARTNER_ADMIN",
      "INTERNAL",
      "CONTENT_CREATOR",
      "",
      null,
      undefined,
    ]) {
      expect(isModeratorRole(r as never)).toBe(false);
    }
  });
});

describe("mediaKindOf", () => {
  it("maps mime prefixes to kinds; unknown → other", () => {
    expect(mediaKindOf("image/jpeg")).toBe("image");
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("application/pdf")).toBe("other");
    expect(mediaKindOf(null)).toBe("other");
  });
});

describe("moderator-serve-gate (pure)", () => {
  it("serves ONLY REVIEW/QUARANTINED via the bypass — never APPROVED or terminal", () => {
    for (const s of ALL_MEDIA_LIFECYCLES) {
      const expected = s === "REVIEW" || s === "QUARANTINED";
      expect(moderatorCanServe(s)).toBe(expected);
    }
    // The reviewable tuple matches exactly.
    expect([...MODERATOR_REVIEWABLE_LIFECYCLES].sort()).toEqual(
      ["QUARANTINED", "REVIEW"].sort(),
    );
  });
  it("bypass still honours the deletedAt kill switch", () => {
    expect(isModeratorServable({ lifecycle: "REVIEW", deletedAt: null })).toBe(true);
    expect(
      isModeratorServable({ lifecycle: "REVIEW", deletedAt: new Date() }),
    ).toBe(false);
    expect(isModeratorServable({ lifecycle: "APPROVED", deletedAt: null })).toBe(
      false,
    );
  });
});

describe("MediaReviewHandler.resolveModeratorRole (role-denied)", () => {
  const handler = new MediaReviewHandler();

  it("returns null (→ 403) for a non-moderator user", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ role: "END_USER" });
    expect(await handler.resolveModeratorRole(db, "user-1")).toBeNull();
  });

  it("returns null when the user does not exist", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(null);
    expect(await handler.resolveModeratorRole(db, "ghost")).toBeNull();
  });

  it("returns the role for a MODERATOR", async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ role: "MODERATOR" });
    expect(await handler.resolveModeratorRole(db, "mod-1")).toBe("MODERATOR");
  });
});

describe("MediaReviewHandler.list", () => {
  const handler = new MediaReviewHandler();

  it("queries REVIEW+QUARANTINED, non-deleted, and surfaces per-track verdicts (video)", async () => {
    const db = makeDb();
    db.mediaFile.findMany.mockResolvedValue([
      {
        id: "m-video",
        tenantId: "t1",
        mimeType: "video/mp4",
        lifecycle: "REVIEW",
        size: 1234,
        width: 1080,
        height: 1920,
        duration: 42,
        createdAt: new Date("2026-07-05T00:00:00Z"),
        moderationJobs: [
          { track: "VISUAL", decision: "review" },
          { track: "AUDIO", decision: "approved" },
        ],
      },
    ]);

    const page = await handler.list(db, { limit: 10 });

    // The where clause targets the two review states + not-deleted.
    const arg = db.mediaFile.findMany.mock.calls[0][0] as {
      where: { lifecycle: { in: string[] }; deletedAt: null };
    };
    expect(arg.where.lifecycle.in.sort()).toEqual(["QUARANTINED", "REVIEW"]);
    expect(arg.where.deletedAt).toBeNull();

    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.kind).toBe("video");
    expect(item.duration).toBe(42);
    expect(item.tracks).toEqual([
      { track: "VISUAL", decision: "review" },
      { track: "AUDIO", decision: "approved" },
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("paginates: take = limit+1, hasMore + nextCursor when overflowing", async () => {
    const db = makeDb();
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`,
      tenantId: "t1",
      mimeType: "image/jpeg",
      lifecycle: "REVIEW",
      size: 1,
      width: null,
      height: null,
      duration: null,
      createdAt: new Date(),
      moderationJobs: [],
    }));
    db.mediaFile.findMany.mockResolvedValue(rows); // 3 returned for limit 2
    const page = await handler.list(db, { limit: 2 });
    expect((db.mediaFile.findMany.mock.calls[0][0] as { take: number }).take).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("m1");
  });
});

describe("MediaReviewHandler.decide", () => {
  let handler: MediaReviewHandler;
  let audit: ReturnType<typeof makeAuditLogger>;

  beforeEach(() => {
    handler = new MediaReviewHandler();
    audit = makeAuditLogger();
  });

  it("approve-promotes a REVIEW item WITH CAS bytes → APPROVED + audit row", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m1",
      tenantId: "t1",
      lifecycle: "REVIEW",
      originalKey: "cas/t1/hash",
      deletedAt: null,
    });

    const result = await handler.decide(db, audit, env, {
      mediaId: "m1",
      decision: "approve",
      moderatorUserId: "mod-1",
      region: "EU",
    });

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
    // Persisted the promoted lifecycle.
    expect(db.mediaFile.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { lifecycle: "APPROVED" },
    });
    // Audit row written with the approve action.
    expect(audit.logSystemAction).toHaveBeenCalledTimes(1);
    const [action, event] = audit.logSystemAction.mock.calls[0];
    expect(action).toBe("media.moderation.approved");
    expect(event).toMatchObject({
      resource: "media",
      resourceId: "m1",
      userId: "mod-1",
      success: true,
      severity: "high",
      metadata: { fromLifecycle: "REVIEW", toLifecycle: "APPROVED", promoted: true },
    });
  });

  it("approve is FAIL-CLOSED when CAS bytes are absent (originalKey null) — NOT promoted", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m2",
      tenantId: "t1",
      lifecycle: "REVIEW",
      originalKey: null,
      deletedAt: null,
    });

    const result = await handler.decide(db, audit, env, {
      mediaId: "m2",
      decision: "approve",
      moderatorUserId: "mod-1",
      region: "EU",
    });

    expect(result).toEqual({ ok: true, status: "REVIEW", promoted: false });
    expect(db.mediaFile.update).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { lifecycle: "REVIEW" },
    });
  });

  it("reject drives a REVIEW item → REJECTED + audit row", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m3",
      tenantId: "t1",
      lifecycle: "REVIEW",
      originalKey: "cas/t1/hash",
      deletedAt: null,
    });

    const result = await handler.decide(db, audit, env, {
      mediaId: "m3",
      decision: "reject",
      moderatorUserId: "mod-1",
      region: "EU",
    });

    expect(result).toEqual({ ok: true, status: "REJECTED", promoted: false });
    expect(db.mediaFile.update).toHaveBeenCalledWith({
      where: { id: "m3" },
      data: { lifecycle: "REJECTED" },
    });
    expect(audit.logSystemAction.mock.calls[0][0]).toBe("media.moderation.rejected");
  });

  it("reject also resolves a QUARANTINED item → REJECTED", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m4",
      tenantId: "t1",
      lifecycle: "QUARANTINED",
      originalKey: "cas/t1/h",
      deletedAt: null,
    });
    const result = await handler.decide(db, audit, env, {
      mediaId: "m4",
      decision: "reject",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(result).toEqual({ ok: true, status: "REJECTED", promoted: false });
  });

  it("refuses a decision on a TERMINAL item (illegal state) — no write, no audit", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m5",
      tenantId: "t1",
      lifecycle: "APPROVED",
      originalKey: "cas/t1/h",
      deletedAt: null,
    });
    const result = await handler.decide(db, audit, env, {
      mediaId: "m5",
      decision: "reject",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(result).toEqual({ ok: false, code: "ILLEGAL_STATE", from: "APPROVED" });
    expect(db.mediaFile.update).not.toHaveBeenCalled();
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a missing/deleted item", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue(null);
    const result = await handler.decide(db, audit, env, {
      mediaId: "gone",
      decision: "approve",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(db.mediaFile.update).not.toHaveBeenCalled();
  });
});

describe("MediaReviewHandler.escalateCsam (stub)", () => {
  it("locks (hidden) + drives REJECTED + writes a CRITICAL audit row, no automated reporting", async () => {
    const handler = new MediaReviewHandler();
    const audit = makeAuditLogger();
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m6",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
    });

    const result = await handler.escalateCsam(db, audit, env, {
      mediaId: "m6",
      moderatorUserId: "mod-1",
      region: "EU",
    });

    expect(result).toEqual({ ok: true, status: "REJECTED", promoted: false });
    const updateArg = db.mediaFile.update.mock.calls[0][0] as {
      data: { lifecycle: string; hidden: boolean; hiddenBy: string };
    };
    expect(updateArg.data.lifecycle).toBe("REJECTED");
    expect(updateArg.data.hidden).toBe(true);
    expect(updateArg.data.hiddenBy).toBe("mod-1");

    const [action, event] = audit.logSystemAction.mock.calls[0];
    expect(action).toBe("media.moderation.csam_escalated");
    expect(event).toMatchObject({
      severity: "critical",
      success: true,
      metadata: {
        locked: true,
        pagedForHumanReview: true,
        automatedReporting: false,
      },
    });
  });
});

describe("MediaReviewHandler.authorizeView (audited bypass)", () => {
  let handler: MediaReviewHandler;
  let audit: ReturnType<typeof makeAuditLogger>;
  beforeEach(() => {
    handler = new MediaReviewHandler();
    audit = makeAuditLogger();
  });

  it("authorizes + AUDITS a REVIEW item view, returning the key", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m7",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "video/mp4",
    });
    const out = await handler.authorizeView(db, audit, env, {
      mediaId: "m7",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(out).toEqual({ originalKey: "cas/t1/h", mimeType: "video/mp4" });
    // Audited BEFORE serving.
    expect(audit.logSystemAction).toHaveBeenCalledTimes(1);
    expect(audit.logSystemAction.mock.calls[0][0]).toBe("media.moderation.viewed");
  });

  it("denies (null) + writes NO audit for a non-reviewable (APPROVED) item", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m8",
      tenantId: "t1",
      lifecycle: "APPROVED",
      deletedAt: null,
      originalKey: "cas/t1/h",
      mimeType: "image/jpeg",
    });
    const out = await handler.authorizeView(db, audit, env, {
      mediaId: "m8",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(out).toBeNull();
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it("denies (null) when the CAS object key is absent", async () => {
    const db = makeDb();
    db.mediaFile.findUnique.mockResolvedValue({
      id: "m9",
      tenantId: "t1",
      lifecycle: "REVIEW",
      deletedAt: null,
      originalKey: null,
      mimeType: "video/mp4",
    });
    const out = await handler.authorizeView(db, audit, env, {
      mediaId: "m9",
      moderatorUserId: "mod-1",
      region: "EU",
    });
    expect(out).toBeNull();
  });
});
