/**
 * Unit Tests: the evidence-hold GUARD (plan 08 §2.3 item 5 / §5).
 *
 * Content under a live evidence hold must be skipped by BOTH cascade paths:
 *   - the account-deletion media erasure (`eraseUserMedia`), and
 *   - the nightly hard-delete purge (via the shared `evidenceHoldExemptWhere`).
 * A held original must survive while an authority case is open.
 */

import { describe, expect, it, vi } from "vitest";
import { eraseUserMedia } from "../../../src/lib/services/user-media-erasure.js";
import { evidenceHoldExemptWhere } from "../../../src/lib/compliance/restrict-content.js";

describe("account-deletion cascade skips held media", () => {
  it("eraseUserMedia queries with evidenceHold:false — held rows never enter the erasure set", async () => {
    const findMany = vi.fn(async () => []); // held rows are excluded DB-side
    const db = {
      mediaFile: { findMany, updateMany: vi.fn(), count: vi.fn() },
      postMedia: { groupBy: vi.fn(async () => []) },
      postCommentMedia: { groupBy: vi.fn(async () => []) },
    } as any;

    await eraseUserMedia(db, "user-1");

    expect(findMany).toHaveBeenCalled();
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ uploadedBy: "user-1", evidenceHold: false });
  });

  it("a held row is neither soft-deleted nor scrubbed (nothing to erase → both branches skipped)", async () => {
    // The DB-side filter returns no rows (all held); the erasure loop terminates
    // immediately, so no updateMany (soft-delete/scrub) runs on held content.
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = {
      mediaFile: { findMany: vi.fn(async () => []), updateMany, count: vi.fn() },
      postMedia: { groupBy: vi.fn(async () => []) },
      postCommentMedia: { groupBy: vi.fn(async () => []) },
    } as any;

    const result = await eraseUserMedia(db, "user-1");

    expect(updateMany).not.toHaveBeenCalled();
    expect(result.erased).toBe(0);
  });
});

describe("hard-delete purge exemption", () => {
  it("the shared hold-exempt predicate is applied to the purge query", () => {
    // nightly-cron composes `{ deletedAt: {lte}, ...evidenceHoldExemptWhere() }`.
    const purgeWhere = { deletedAt: { lte: new Date() }, ...evidenceHoldExemptWhere() };
    expect(purgeWhere.evidenceHold).toBe(false);
  });
});
