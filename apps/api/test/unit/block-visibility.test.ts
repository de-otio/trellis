/**
 * Unit tests: the block read-path seam (M2).
 *
 * Two things are asserted here that no other test can see:
 *
 *  1. The audience predicate every post read shares (`buildPostAudienceFilter`)
 *     carries the block as a CONJUNCT — so a block beats `SHOUT`, which is the
 *     only visibility that would otherwise survive it.
 *  2. The resolution is bidirectional and batched: one lookup per request, and
 *     the exclusion set is symmetric, so a blocked author disappears for the
 *     blocker AND the blocker disappears for the blocked account.
 */

import { describe, expect, it, vi } from "vitest";
import {
  blockedWriteResponse,
  isBlockedEitherWay,
  resolveMutualBlockIds,
} from "../../src/lib/block-visibility.js";
import { buildPostAudienceFilter } from "../../src/lib/feed-handler.js";
import { InMemoryBlockStore } from "../../src/lib/realtime/block-store.js";

const TENANT = "tenant-1";
const VIEWER = "viewer";
const OTHER = "other";

/** A structural stand-in for the Prisma client; unused when a store is passed. */
const noDb = { blockedUser: { findUnique: vi.fn(), findMany: vi.fn() } } as any;

describe("buildPostAudienceFilter — block conjunct", () => {
  it("omits the exclusion entirely when nothing is blocked", () => {
    const filter = buildPostAudienceFilter(VIEWER, ["friend"], []);
    expect(filter).not.toHaveProperty("authorId");
    expect(filter.OR).toHaveLength(3);
  });

  it("excludes blocked authors as a top-level AND, not another OR arm", () => {
    const filter = buildPostAudienceFilter(VIEWER, ["friend"], [OTHER]);

    // Top-level key => Prisma ANDs it with the audience OR. If it were pushed
    // into the OR it would WIDEN visibility instead of narrowing it.
    expect(filter).toMatchObject({ authorId: { notIn: [OTHER] } });
    expect(filter.OR).toHaveLength(3);
    expect(JSON.stringify(filter.OR)).not.toContain("notIn");
  });

  it("still admits the viewer's own posts (a self-block is unrepresentable)", () => {
    const filter = buildPostAudienceFilter(VIEWER, [], [OTHER]);
    expect(filter.OR).toContainEqual({ authorId: VIEWER });
    expect((filter as any).authorId.notIn).not.toContain(VIEWER);
  });

  it("defaults to no exclusion when the argument is omitted (back-compatible)", () => {
    const filter = buildPostAudienceFilter(VIEWER, ["friend"]);
    expect(filter).not.toHaveProperty("authorId");
  });
});

describe("resolveMutualBlockIds", () => {
  it("is symmetric: same exclusion set from either side of one block", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, VIEWER, OTHER); // only the viewer blocked

    const forBlocker = await resolveMutualBlockIds(noDb, TENANT, VIEWER, store);
    const forBlocked = await resolveMutualBlockIds(noDb, TENANT, OTHER, store);

    expect(forBlocker).toEqual([OTHER]);
    // The blocked account loses sight of the blocker too — a block is not a
    // mute, and one-way hiding leaves the harasser watching.
    expect(forBlocked).toEqual([VIEWER]);
  });

  it("empties after an unblock", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, VIEWER, OTHER);
    store.unblock(TENANT, VIEWER, OTHER);

    expect(await resolveMutualBlockIds(noDb, TENANT, VIEWER, store)).toEqual([]);
    expect(await resolveMutualBlockIds(noDb, TENANT, OTHER, store)).toEqual([]);
  });

  it("makes exactly ONE lookup per request, whatever the set size", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { blockerId: VIEWER, blockedId: "a" },
      { blockerId: VIEWER, blockedId: "b" },
      { blockerId: "c", blockedId: VIEWER },
    ]);
    const db = { blockedUser: { findUnique: vi.fn(), findMany } } as any;

    const ids = await resolveMutualBlockIds(db, TENANT, VIEWER);

    expect([...ids].sort()).toEqual(["a", "b", "c"]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("no-ops on a falsy tenant or viewer instead of widening or throwing", async () => {
    const findMany = vi.fn();
    const db = { blockedUser: { findUnique: vi.fn(), findMany } } as any;

    expect(await resolveMutualBlockIds(db, "", VIEWER)).toEqual([]);
    expect(await resolveMutualBlockIds(db, TENANT, "")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("isBlockedEitherWay", () => {
  it("is true whichever party holds the block", async () => {
    const store = new InMemoryBlockStore();
    store.block(TENANT, VIEWER, OTHER);

    expect(await isBlockedEitherWay(noDb, TENANT, VIEWER, OTHER, store)).toBe(
      true,
    );
    expect(await isBlockedEitherWay(noDb, TENANT, OTHER, VIEWER, store)).toBe(
      true,
    );
  });

  it("is false with no edge, across tenants, and for a self-pair", async () => {
    const store = new InMemoryBlockStore();
    store.block("tenant-other", VIEWER, OTHER);

    expect(await isBlockedEitherWay(noDb, TENANT, VIEWER, OTHER, store)).toBe(
      false,
    );
    expect(await isBlockedEitherWay(noDb, TENANT, VIEWER, VIEWER, store)).toBe(
      false,
    );
  });
});

describe("blockedWriteResponse", () => {
  it("is a 403 with the structured envelope and a remediation", async () => {
    const response = blockedWriteResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("BLOCKED");
    expect(body.message).toBeTruthy();
    expect(body.remediation).toContain("/api/blocks");
  });

  it("does not disclose which party holds the block", async () => {
    const body = JSON.stringify(await blockedWriteResponse().json());
    // A message that named the direction would turn every post into a probe
    // for "has this account blocked me?".
    expect(body).not.toMatch(/you blocked|blocked you|they blocked/i);
  });
});
