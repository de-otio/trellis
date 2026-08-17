/**
 * Unit Tests: friend-set resolution (V1)
 *
 * `getFriendUserIds` decides who may read a NORMAL-radius post. It had no
 * direct test coverage, which is how the following went unnoticed: the query
 * read *outgoing* edges only, so creating a relationship to a stranger — an
 * action needing no involvement from that stranger — put the caller in their
 * friend set and granted read access to their close-friends posts.
 *
 * The invariant these tests protect is narrow and worth stating exactly:
 *
 *   No field the reader can write may increase the set this function returns.
 *
 * `tier` is reader-writable (it derives from manual_score, which the reader
 * sets through PATCH /api/relationships/score). `reciprocated` is not — the
 * server sets it only when the reverse edge exists. So the predicate must
 * require reciprocation, and these tests assert the query does.
 *
 * L4 (security review 2026-08, lane 7 HIGH-2) adds a second invariant of the
 * same kind:
 *
 *   The set is scoped to ONE tenant, and the tenant is never optional.
 *
 * These are predicate-shape assertions — the mock returns whatever rows it is
 * handed regardless of the `where`. The outcome assertions (does a cross-tenant
 * edge actually come back from Postgres) live in
 * test/integration/post-read-isolation.integration.test.ts, which is where a
 * predicate that admits everything would be caught.
 */

import { describe, expect, it, vi } from "vitest";
import {
  FRIEND_TIER_MAX,
  getFriendUserIds,
  type RelationshipReader,
} from "../../src/lib/friend-ids.js";

const TENANT = "tenant-1";

function readerReturning(rows: Array<{ userId: string }>) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    db: { relationship: { findMany } } as unknown as RelationshipReader,
    findMany,
  };
}

describe("getFriendUserIds", () => {
  it("returns the ids of the authors who placed this viewer close", async () => {
    const { db } = readerReturning([
      { userId: "author-a" },
      { userId: "author-b" },
    ]);

    await expect(getFriendUserIds(db, "viewer-1", TENANT)).resolves.toEqual([
      "author-a",
      "author-b",
    ]);
  });

  it("returns an empty array when the viewer has no qualifying edges", async () => {
    const { db } = readerReturning([]);

    await expect(getFriendUserIds(db, "viewer-1", TENANT)).resolves.toEqual([]);
  });

  // The defect. A one-directional edge must not qualify, so the query has to
  // constrain `reciprocated`. Asserting the predicate rather than the result,
  // because the mock returns whatever rows it is told to regardless of the
  // where — which is exactly why this hole survived: no test looked here.
  it("requires the relationship to be reciprocated", async () => {
    const { db, findMany } = readerReturning([]);

    await getFriendUserIds(db, "viewer-1", TENANT);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        targetId: "viewer-1",
        targetType: "user",
        tier: { lte: FRIEND_TIER_MAX },
        reciprocated: true,
      },
      select: { userId: true },
    });
  });

  // The direction is the whole point: `tier` must be the tier the AUTHOR
  // assigned, so the viewer has to appear as the edge's TARGET. Reading the
  // viewer's own outgoing edge hands the audience boundary to the reader, who
  // sets their own tier via PATCH /api/relationships/score.
  it("reads the author's edge — the viewer is the target, never the source", async () => {
    const { db, findMany } = readerReturning([]);

    await getFriendUserIds(db, "viewer-9", TENANT);

    const where = findMany.mock.calls[0][0].where;
    expect(where.targetId).toBe("viewer-9");
    expect(where.userId).toBeUndefined();
    expect(where.targetType).toBe("user");
  });

  it("bounds the tier rather than accepting every reciprocated edge", async () => {
    const { db, findMany } = readerReturning([]);

    await getFriendUserIds(db, "viewer-1", TENANT);

    // Retained on top of reciprocation: dropping it would widen the set to
    // every mutual edge however distant.
    expect(findMany.mock.calls[0][0].where.tier).toEqual({
      lte: FRIEND_TIER_MAX,
    });
    expect(FRIEND_TIER_MAX).toBe(1);
  });

  it("never omits the reciprocated constraint, whatever the viewer id", async () => {
    const { db, findMany } = readerReturning([]);

    for (const viewer of ["a", "b-with-dash", "c".repeat(30)]) {
      await getFriendUserIds(db, viewer, TENANT);
    }

    for (const call of findMany.mock.calls) {
      expect(call[0].where.reciprocated).toBe(true);
    }
  });
});

describe("getFriendUserIds tenant scoping (L4)", () => {
  it("refuses an empty tenant rather than querying without one", async () => {
    const { db, findMany } = readerReturning([]);

    await expect(getFriendUserIds(db, "viewer-1", "")).rejects.toThrow(
      /tenantId is required/,
    );
    // The point of throwing instead of defaulting: Prisma DROPS an undefined
    // `where` key, so a query that reached the database with no tenant would
    // return EVERY tenant's edges. It must not reach the database at all.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("puts the caller's tenant in the predicate, verbatim", async () => {
    const { db, findMany } = readerReturning([]);

    await getFriendUserIds(db, "viewer-1", "tenant-xyz");

    expect(findMany.mock.calls[0][0].where.tenantId).toBe("tenant-xyz");
  });

  it("never omits the tenant constraint, whatever the viewer id", async () => {
    const { db, findMany } = readerReturning([]);

    for (const viewer of ["a", "b-with-dash", "c".repeat(30)]) {
      await getFriendUserIds(db, viewer, TENANT);
    }

    for (const call of findMany.mock.calls) {
      expect(call[0].where.tenantId).toBe(TENANT);
    }
  });
});
