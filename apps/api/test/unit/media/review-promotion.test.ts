import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaReviewHandler,
  setMediaReviewPromotion,
  __resetMediaReviewPromotionForTests,
  type ReviewPrismaLike,
  type ReviewPromotionPort,
} from "../../../src/lib/media/media-review-handler.js";
import { MockStoragePort } from "../../../src/lib/media/media-ports.js";
import type {
  TrellisAuditLogger,
  TrellisAuditLoggerEnv,
} from "../../../src/lib/audit-composer.js";

const TENANT = "c0000000000000000000000aa";
const UPLOAD = "c1111111111111111111111bb";
const HASH = "a".repeat(64);
const CAS_KEY = `cas/${TENANT}/${HASH}`;
const STAGING_KEY = `processing/${TENANT}/${UPLOAD}`;
const PENDING_KEY = `pending/${TENANT}/${UPLOAD}`;
const MEDIA_ID = "media-1";

const REVIEWED_BYTES = Buffer.from("the bytes the moderator looked at");
const SWAPPED_BYTES = Buffer.from("something else entirely, uploaded later");

function makeDb(row: Record<string, unknown>): {
  db: ReviewPrismaLike;
  updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const db: ReviewPrismaLike = {
    mediaFile: {
      findMany: async () => [],
      findUnique: async () => row,
      update: async (args) => {
        updates.push((args as { data: Record<string, unknown> }).data);
        return row;
      },
    },
    user: { findUnique: async () => ({ role: "MODERATOR" }) },
  };
  return { db, updates };
}

const auditLogger = {
  logSystemAction: vi.fn(async () => undefined),
} as unknown as TrellisAuditLogger;
const auditEnv = {} as TrellisAuditLoggerEnv;

const APPROVE_INPUT = {
  mediaId: MEDIA_ID,
  decision: "approve" as const,
  moderatorUserId: "moderator-1",
  region: "eu" as never,
};

/** A storage world where the reviewed version was captured at mock-version-1. */
async function seededStorage(): Promise<MockStoragePort> {
  const storage = new MockStoragePort();
  await storage.putObject(STAGING_KEY, REVIEWED_BYTES, "video/mp4");
  await storage.putObject(PENDING_KEY, Buffer.from("raw original"), "video/mp4");
  return storage;
}

function promotionPort(
  storage: MockStoragePort,
  coords: {
    stagingVersionId: string | null;
  } = { stagingVersionId: "mock-version-1" },
): ReviewPromotionPort {
  return {
    storage,
    async coordsFor() {
      return {
        tenantId: TENANT,
        uploadId: UPLOAD,
        contentHash: HASH,
        stagingVersionId: coords.stagingVersionId,
      };
    },
  };
}

describe("MediaReviewHandler.decide — approval promotes the bytes that were reviewed", () => {
  it("promotes the pinned version to the serve key", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db, updates } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage),
    );

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
    expect(updates[0]).toEqual({ lifecycle: "APPROVED" });
    await expect(storage.getObject(CAS_KEY)).resolves.toEqual(REVIEWED_BYTES);
  });

  it("promotes the REVIEWED version even after the staging key was overwritten", async () => {
    // The bait-and-switch: swap the bytes between the review and the click.
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    await storage.putObject(STAGING_KEY, SWAPPED_BYTES, "video/mp4");
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage),
    );

    expect(result.ok).toBe(true);
    const served = await storage.getObject(CAS_KEY);
    expect(served).toEqual(REVIEWED_BYTES);
    expect(served).not.toEqual(SWAPPED_BYTES);
  });

  it("cleans up the raw original and the staging copy after promoting", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage),
    );

    expect((await storage.headObject(PENDING_KEY)).exists).toBe(false);
    expect((await storage.headObject(STAGING_KEY)).exists).toBe(false);
  });
});

describe("MediaReviewHandler.decide — refuses rather than approving uncertain bytes", () => {
  it("holds REVIEW when the pinned version can no longer be resolved", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db, updates } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      // A pin that points at a version that does not exist.
      promotionPort(storage, { stagingVersionId: "mock-version-999" }),
    );

    expect(result).toEqual({ ok: true, status: "REVIEW", promoted: false });
    expect(updates[0]).toEqual({ lifecycle: "REVIEW" });
    expect((await storage.headObject(CAS_KEY)).exists).toBe(false);
  });

  it("refuses to promote an UNPINNED row rather than copying current bytes", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage, { stagingVersionId: null }),
    );

    expect(result.status).toBe("REVIEW");
    expect((await storage.headObject(CAS_KEY)).exists).toBe(false);
  });

  it("accepts an already-promoted CAS object as certified", async () => {
    // Those bytes were themselves pin-copied by a prior promotion.
    const handler = new MediaReviewHandler();
    const storage = new MockStoragePort();
    await storage.putObject(CAS_KEY, REVIEWED_BYTES, "video/mp4");
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage, { stagingVersionId: null }),
    );

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
    await expect(storage.getObject(CAS_KEY)).resolves.toEqual(REVIEWED_BYTES);
  });

  it("holds REVIEW when the promote coordinates are unknown", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(db, auditLogger, auditEnv, APPROVE_INPUT, {
      storage,
      async coordsFor() {
        return null;
      },
    });

    expect(result.status).toBe("REVIEW");
  });

  it("holds REVIEW when the copy itself fails", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    storage.copyObject = async () => {
      throw new Error("storage refused the copy");
    };
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage),
    );

    expect(result.status).toBe("REVIEW");
  });

  it("holds REVIEW when the row has no serve key at all", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: null,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(storage),
    );

    expect(result).toEqual({ ok: true, status: "REVIEW", promoted: false });
  });

  it("never promotes on a REJECT", async () => {
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(
      db,
      auditLogger,
      auditEnv,
      { ...APPROVE_INPUT, decision: "reject" },
      promotionPort(storage),
    );

    expect(result.status).toBe("REJECTED");
    expect((await storage.headObject(CAS_KEY)).exists).toBe(false);
  });
});

describe("MediaReviewHandler.decide — without a promotion capability", () => {
  it("behaves as before and says so", async () => {
    const handler = new MediaReviewHandler();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(db, auditLogger, auditEnv, APPROVE_INPUT);

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
  });
});

describe("the promotion capability is reachable from a real deployment", () => {
  afterEach(() => {
    __resetMediaReviewPromotionForTests();
  });

  it("decide() uses the INJECTED capability when the caller passes none", async () => {
    // Without an injection seam the capability was unreachable: the review route
    // constructs the handler itself, so every approval took the "no capability"
    // branch and promoted nothing. A fix nothing can reach is not a fix.
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    setMediaReviewPromotion(promotionPort(storage));
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(db, auditLogger, auditEnv, APPROVE_INPUT);

    expect(result).toEqual({ ok: true, status: "APPROVED", promoted: true });
    await expect(storage.getObject(CAS_KEY)).resolves.toEqual(REVIEWED_BYTES);
  });

  it("an explicitly-passed capability still wins over the injected one", async () => {
    const handler = new MediaReviewHandler();
    const injected = await seededStorage();
    const explicit = await seededStorage();
    setMediaReviewPromotion(promotionPort(injected));
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    await handler.decide(
      db,
      auditLogger,
      auditEnv,
      APPROVE_INPUT,
      promotionPort(explicit),
    );

    expect((await explicit.headObject(CAS_KEY)).exists).toBe(true);
    expect((await injected.headObject(CAS_KEY)).exists).toBe(false);
  });

  it("says so out loud when no capability is wired at all", async () => {
    // The earlier fallback returned an empty log object, making the one warning
    // that tells an operator "approvals are not making bytes servable" a
    // guaranteed no-op.
    const handler = new MediaReviewHandler();
    const warn = vi.fn();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });
    const logger = await import("../../../src/lib/logger.js");
    const spy = vi.spyOn(logger, "getLogger").mockReturnValue({
      info: vi.fn(),
      warn,
      error: vi.fn(),
    } as never);

    await handler.decide(db, auditLogger, auditEnv, APPROVE_INPUT);

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("promotion capability");
    spy.mockRestore();
  });
});

describe("MediaReviewHandler.decide — the coordinates must address THIS item", () => {
  it("refuses when the promote coordinates point at another object", async () => {
    // A coordsFor that returned another item's coordinates would promote that
    // item's staging bytes to this item's serve key — an approval applied to
    // media the moderator never saw.
    const handler = new MediaReviewHandler();
    const storage = await seededStorage();
    const { db } = makeDb({
      id: MEDIA_ID,
      tenantId: TENANT,
      lifecycle: "REVIEW",
      originalKey: CAS_KEY,
      deletedAt: null,
    });

    const result = await handler.decide(db, auditLogger, auditEnv, APPROVE_INPUT, {
      storage,
      async coordsFor() {
        return {
          tenantId: TENANT,
          uploadId: UPLOAD,
          // A different content hash — so a different serve key.
          contentHash: "b".repeat(64),
          stagingVersionId: "mock-version-1",
        };
      },
    });

    expect(result.status).toBe("REVIEW");
    expect((await storage.headObject(CAS_KEY)).exists).toBe(false);
  });
});
