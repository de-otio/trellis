/**
 * Unit Tests: user media erasure (AR7 / GDPR Art. 17).
 *
 * The account-deletion path previously enumerated the obsolete
 * `originals/user-{id}/` S3 prefix — which matches nothing under the
 * tenant-scoped CAS key scheme — so account deletion removed ZERO media
 * bytes. This suite pins the replacement: DB-level erasure through the
 * shared storage-accounting predicate, with byte reclamation routed through
 * the existing nightly GC purge (soft-delete) and staging keys returned for
 * direct deletion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eraseUserMedia } from "../../../src/lib/services/user-media-erasure.js";

const TENANT = "cabcdefghijklmnopqrstuvwx";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const UPLOAD_ID = "cupload00000000000000001x";

function makeDb() {
  return {
    mediaFile: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    postMedia: { groupBy: vi.fn().mockResolvedValue([]) },
    postCommentMedia: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}

describe("eraseUserMedia", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
  });

  it("soft-deletes an unreferenced row (enqueue for the nightly GC purge) and returns its staging keys", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        {
          id: "m1",
          tenantId: TENANT,
          contentHash: HASH_A,
          uploadId: UPLOAD_ID,
          deletedAt: null,
        },
      ])
      .mockResolvedValue([]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(1);
    expect(result.retainedShared).toBe(0);
    expect(result.stagingKeys.sort()).toEqual(
      [`pending/${TENANT}/${UPLOAD_ID}`, `processing/${TENANT}/${HASH_A}`].sort(),
    );
    // Soft-delete with the personal link scrubbed.
    expect(db.mediaFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1"] }, deletedAt: null },
      data: { uploadedBy: null, deletedAt: expect.any(Date) },
    });
  });

  it("retains a row still referenced by another user's post: scrubs uploadedBy, never soft-deletes, returns no staging keys", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: null },
      ])
      .mockResolvedValue([]);
    db.postMedia.groupBy.mockResolvedValue([{ mediaId: "m1" }]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(0);
    expect(result.retainedShared).toBe(1);
    expect(result.stagingKeys).toEqual([]);
    expect(db.mediaFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1"] } },
      data: { uploadedBy: null },
    });
    const softDeletes = db.mediaFile.updateMany.mock.calls.filter(
      (c: any[]) => c[0]?.data?.deletedAt,
    );
    expect(softDeletes).toHaveLength(0);
  });

  it("retains a row referenced by another user's comment media", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: null },
      ])
      .mockResolvedValue([]);
    db.postCommentMedia.groupBy.mockResolvedValue([{ mediaId: "m1" }]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(0);
    expect(result.retainedShared).toBe(1);
  });

  it("retains a row when the shared storage-accounting predicate reports another LIVE row with the same (tenantId, contentHash)", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: null },
      ])
      .mockResolvedValue([]);
    // Another non-deleted MediaFile shares the hash within the tenant scope.
    db.mediaFile.count.mockResolvedValue(1);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(0);
    expect(result.retainedShared).toBe(1);
    expect(result.stagingKeys).toEqual([]);
    // The predicate was consulted with the tenant-scoped reference query.
    expect(db.mediaFile.count).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        contentHash: HASH_A,
        deletedAt: null,
        id: { notIn: ["m1"] },
      },
    });
  });

  it("erases a pre-transcode video row (contentHash null): pending staging key only, no CAS predicate query", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: null, uploadId: UPLOAD_ID, deletedAt: null },
      ])
      .mockResolvedValue([]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(1);
    expect(result.stagingKeys).toEqual([`pending/${TENANT}/${UPLOAD_ID}`]);
    expect(db.mediaFile.count).not.toHaveBeenCalled();
  });

  it("scrubs — but does not re-date — a row that was already soft-deleted (already in the GC pipeline)", async () => {
    const priorDeletedAt = new Date("2026-06-01T00:00:00Z");
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: priorDeletedAt },
      ])
      .mockResolvedValue([]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(1);
    // The soft-delete write is guarded on deletedAt: null, so the purge date
    // never moves forward; the scrub-only write covers the row.
    expect(db.mediaFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1"] }, deletedAt: null },
      data: { uploadedBy: null, deletedAt: expect.any(Date) },
    });
    expect(db.mediaFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1"] } },
      data: { uploadedBy: null },
    });
  });

  it("skips rows whose ids fail CAS key validation without throwing (no key emitted)", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        // tenantId not a CUID shape -> both key builders return typed errors
        { id: "m1", tenantId: "BAD_TENANT", contentHash: HASH_A, uploadId: "BAD_UPLOAD", deletedAt: null },
      ])
      .mockResolvedValue([]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(1);
    expect(result.stagingKeys).toEqual([]);
  });

  it("drains multiple pages", async () => {
    db.mediaFile.findMany
      .mockResolvedValueOnce([
        { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: null },
      ])
      .mockResolvedValueOnce([
        { id: "m2", tenantId: TENANT, contentHash: HASH_B, uploadId: null, deletedAt: null },
      ])
      .mockResolvedValue([]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(result.erased).toBe(2);
    expect(result.stagingKeys.sort()).toEqual(
      [`processing/${TENANT}/${HASH_A}`, `processing/${TENANT}/${HASH_B}`].sort(),
    );
  });

  it("stops at the pagination circuit breaker instead of looping forever", async () => {
    // A pathological db that always returns the same (retained) row would loop
    // forever without the breaker.
    db.mediaFile.findMany.mockResolvedValue([
      { id: "m1", tenantId: TENANT, contentHash: HASH_A, uploadId: null, deletedAt: null },
    ]);
    db.postMedia.groupBy.mockResolvedValue([{ mediaId: "m1" }]);

    const result = await eraseUserMedia(db as any, "user-1");

    expect(db.mediaFile.findMany.mock.calls.length).toBeLessThanOrEqual(100);
    expect(result.retainedShared).toBeGreaterThan(0);
  });

  it("returns zeros for a user with no media", async () => {
    const result = await eraseUserMedia(db as any, "user-1");
    expect(result).toEqual({ erased: 0, retainedShared: 0, stagingKeys: [] });
    expect(db.mediaFile.updateMany).not.toHaveBeenCalled();
  });

  it("propagates database errors (the deletion record must fail visibly, not ack)", async () => {
    db.mediaFile.findMany.mockRejectedValue(new Error("DB connection lost"));
    await expect(eraseUserMedia(db as any, "user-1")).rejects.toThrow("DB connection lost");
  });
});
