/**
 * Unit Tests: shared storage-accounting object-state predicate.
 *
 * One definition (T15 ⇄ T16 ⇄ AR7): a CAS object is unreferenced iff no LIVE
 * (deletedAt: null) MediaFile row shares its (tenantId, contentHash) — the
 * same live-row predicate the upload quota counts.
 */

import { describe, expect, it, vi } from "vitest";
import { hasOtherLiveCasReference } from "../../../src/lib/media/storage-accounting.js";

describe("hasOtherLiveCasReference", () => {
  it("returns true when another live row shares the (tenantId, contentHash)", async () => {
    const db = { mediaFile: { count: vi.fn().mockResolvedValue(2) } };
    await expect(
      hasOtherLiveCasReference(db, "tenant-1", "hash-1", ["m1"]),
    ).resolves.toBe(true);
  });

  it("returns false when no other live row shares the hash", async () => {
    const db = { mediaFile: { count: vi.fn().mockResolvedValue(0) } };
    await expect(
      hasOtherLiveCasReference(db, "tenant-1", "hash-1", ["m1"]),
    ).resolves.toBe(false);
  });

  it("queries live rows only (deletedAt: null) within the tenant scope, excluding the rows being erased", async () => {
    const count = vi.fn().mockResolvedValue(0);
    await hasOtherLiveCasReference({ mediaFile: { count } }, "tenant-1", "hash-1", ["m1", "m2"]);
    expect(count).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        contentHash: "hash-1",
        deletedAt: null,
        id: { notIn: ["m1", "m2"] },
      },
    });
  });
});
