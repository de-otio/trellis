/**
 * Unit Tests: Postgres GraphService — Sync group (SyncOps)
 *
 * Covers the three shapes of the B6 sync group:
 *   - node syncs (syncUser/syncEntity/syncPost) are NO-OPS — assert no writes
 *   - node removals reproduce the Neo4j DETACH DELETE cascade for the edge
 *     tables that do NOT FK-cascade (relationships, entity_relationships)
 *   - edge syncs (syncPostSubjects/syncOwnership/removeOwnership) are the real
 *     writers: the ownership auto-pin and the removeOwnership un-pin are
 *     asserted explicitly.
 *
 * Prisma is fully mocked — no database required. Tenant context is provided by
 * the real `runWithTenantContext` ALS carrier so tenant-scoping is exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  runWithTenantContext,
  tenantId,
} from "@de-otio/saas-foundation/tenant";
import { SyncOps } from "../../../../src/lib/graph/postgres/sync.js";
import type { EntityGeoLookup } from "../../../../src/lib/geo/entity-geo-repository.js";

const TENANT = tenantId("tenant-1");
const withTenant = <T>(fn: () => T): T => runWithTenantContext(TENANT, fn);

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const relationship = {
  findFirst: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const entityRelationship = { deleteMany: vi.fn() };
const entityOwnership = { upsert: vi.fn(), deleteMany: vi.fn() };
const postSubject = { deleteMany: vi.fn(), createMany: vi.fn() };

// syncEntity owns the PostGIS location write (entity_location has no other
// writer), so SyncOps is constructed with a geoLookup.
const geoLookup = {
  upsertLocation: vi.fn(),
  removeLocation: vi.fn(),
  findNearby: vi.fn(),
  findNearAnchors: vi.fn(),
};

// $transaction supports BOTH forms: an array of promises and a callback that
// receives the (same) mocked tx client.
const txClient = { relationship, entityRelationship, entityOwnership, postSubject };
const $transaction = vi.fn((arg: unknown) =>
  typeof arg === "function"
    ? (arg as (tx: unknown) => unknown)(txClient)
    : Promise.all(arg as Promise<unknown>[]),
);

const prisma = {
  relationship,
  entityRelationship,
  entityOwnership,
  postSubject,
  $transaction,
} as unknown as PrismaClient;

let ops: SyncOps;

beforeEach(() => {
  vi.clearAllMocks();
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(txClient)
      : Promise.all(arg as Promise<unknown>[]),
  );
  ops = new SyncOps(prisma, geoLookup as unknown as EntityGeoLookup);
});

// ---------------------------------------------------------------------------
// Node syncs — NO-OP
// ---------------------------------------------------------------------------

describe("node syncs are no-ops", () => {
  it("syncUser writes nothing", async () => {
    await ops.syncUser({ id: "user-1", role: "END_USER" });
    expect(relationship.upsert).not.toHaveBeenCalled();
    expect(relationship.deleteMany).not.toHaveBeenCalled();
    expect(entityOwnership.upsert).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("syncEntity writes no graph rows but DOES upsert the PostGIS location", async () => {
    await withTenant(() =>
      ops.syncEntity({
        id: "entity-1",
        entityType: "dog",
        name: "Rex",
        tenantId: "tenant-1",
        lat: 1.23,
        lng: 4.56,
      }),
    );
    // No node/edge row writes...
    expect(entityOwnership.upsert).not.toHaveBeenCalled();
    expect(postSubject.createMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
    // ...but the geo dual-write (the one real side effect) fires.
    expect(geoLookup.upsertLocation).toHaveBeenCalledWith(
      "entity-1",
      "tenant-1",
      1.23,
      4.56,
    );
  });

  it("syncEntity drops the location point when lat/lng are absent", async () => {
    await withTenant(() =>
      ops.syncEntity({ id: "entity-1", entityType: "dog", name: "Rex" }),
    );
    expect(geoLookup.upsertLocation).not.toHaveBeenCalled();
    expect(geoLookup.removeLocation).toHaveBeenCalledWith("entity-1");
  });

  it("syncPost writes nothing", async () => {
    await ops.syncPost({
      id: "post-1",
      authorId: "user-1",
      radius: "NORMAL",
      createdAt: new Date(),
    });
    expect($transaction).not.toHaveBeenCalled();
    expect(relationship.upsert).not.toHaveBeenCalled();
  });

  it("removePost writes nothing (post_subjects FK-cascades)", async () => {
    await ops.removePost("post-1");
    expect(postSubject.deleteMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeUser — cascade scope
// ---------------------------------------------------------------------------

describe("removeUser cascade scope", () => {
  it("deletes relationships FROM the user and pointing AT the user, tenant-scoped", async () => {
    await withTenant(() => ops.removeUser("user-1"));

    expect(relationship.deleteMany).toHaveBeenCalledTimes(1);
    expect(relationship.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        OR: [
          { userId: "user-1" },
          { targetType: "user", targetId: "user-1" },
        ],
      },
    });
    // entity_ownerships FK-cascades off the user row — not deleted here.
    expect(entityOwnership.deleteMany).not.toHaveBeenCalled();
  });

  it("is unscoped when there is no ambient tenant", async () => {
    await ops.removeUser("user-1");
    expect(relationship.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1" },
          { targetType: "user", targetId: "user-1" },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// removeEntity — cascade scope
// ---------------------------------------------------------------------------

describe("removeEntity cascade scope", () => {
  it("deletes RELATES_TO pointing at the entity and entity_relationships on both sides", async () => {
    await withTenant(() => ops.removeEntity("entity-1"));

    expect(relationship.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", targetType: "entity", targetId: "entity-1" },
    });
    expect(entityRelationship.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        OR: [{ entityId: "entity-1" }, { relatedEntityId: "entity-1" }],
      },
    });
    // post_subjects + entity_ownerships FK-cascade off the entity row.
    expect(postSubject.deleteMany).not.toHaveBeenCalled();
    expect(entityOwnership.deleteMany).not.toHaveBeenCalled();
    // No `userId = X` branch — an entity is never a RELATES_TO source.
    const relCall = relationship.deleteMany.mock.calls[0][0];
    expect(JSON.stringify(relCall)).not.toContain("\"userId\"");
    // The PostGIS location row is cleaned up too (no orphan geo).
    expect(geoLookup.removeLocation).toHaveBeenCalledWith("entity-1");
  });
});

// ---------------------------------------------------------------------------
// syncPostSubjects — set-replace
// ---------------------------------------------------------------------------

describe("syncPostSubjects set-replace", () => {
  it("deletes existing ABOUT edges then inserts the new set with the primary flagged", async () => {
    await withTenant(() =>
      ops.syncPostSubjects({
        postId: "post-1",
        entityIds: ["entity-1", "entity-2"],
        primaryEntityId: "entity-1",
      }),
    );

    expect(postSubject.deleteMany).toHaveBeenCalledWith({
      where: { postId: "post-1" },
    });
    expect(postSubject.createMany).toHaveBeenCalledWith({
      data: [
        { postId: "post-1", entityId: "entity-1", isPrimary: true },
        { postId: "post-1", entityId: "entity-2", isPrimary: false },
      ],
      skipDuplicates: true,
    });
  });

  it("deletes only (no insert) when entityIds is empty", async () => {
    await withTenant(() =>
      ops.syncPostSubjects({ postId: "post-1", entityIds: [] }),
    );
    expect(postSubject.deleteMany).toHaveBeenCalledWith({
      where: { postId: "post-1" },
    });
    expect(postSubject.createMany).not.toHaveBeenCalled();
  });

  it("dedupes entityIds to respect the unique constraint", async () => {
    await withTenant(() =>
      ops.syncPostSubjects({
        postId: "post-1",
        entityIds: ["entity-1", "entity-1", "entity-2"],
        primaryEntityId: "entity-2",
      }),
    );
    expect(postSubject.createMany).toHaveBeenCalledWith({
      data: [
        { postId: "post-1", entityId: "entity-1", isPrimary: false },
        { postId: "post-1", entityId: "entity-2", isPrimary: true },
      ],
      skipDuplicates: true,
    });
  });
});

// ---------------------------------------------------------------------------
// syncOwnership — OWNS + auto-pin
// ---------------------------------------------------------------------------

describe("syncOwnership", () => {
  it("upserts the OWNS edge and auto-pins RELATES_TO at score 1.0 (tier 0)", async () => {
    await withTenant(() =>
      ops.syncOwnership({
        entityId: "entity-1",
        userId: "user-1",
        role: "PRIMARY_OWNER",
      }),
    );

    expect(entityOwnership.upsert).toHaveBeenCalledTimes(1);
    const ownArgs = entityOwnership.upsert.mock.calls[0][0];
    expect(ownArgs.where).toEqual({
      entityId_userId: { entityId: "entity-1", userId: "user-1" },
    });
    expect(ownArgs.create).toMatchObject({
      tenantId: "tenant-1",
      entityId: "entity-1",
      userId: "user-1",
      role: "PRIMARY_OWNER",
      addedByUserId: "user-1", // defaulted to self-added
      status: "ACTIVE",
    });

    // Auto-pin via manualScore override.
    expect(relationship.upsert).toHaveBeenCalledTimes(1);
    const pinArgs = relationship.upsert.mock.calls[0][0];
    expect(pinArgs.where).toEqual({
      userId_targetType_targetId: {
        userId: "user-1",
        targetType: "entity",
        targetId: "entity-1",
      },
    });
    expect(pinArgs.update).toEqual({ manualScore: 1.0, tier: 0 });
    expect(pinArgs.create).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
      targetType: "entity",
      targetId: "entity-1",
      manualScore: 1.0,
      tier: 0,
    });
  });

  it("skips entirely when there is no ambient tenant (cannot scope the row)", async () => {
    await ops.syncOwnership({
      entityId: "entity-1",
      userId: "user-1",
      role: "CO_OWNER",
    });
    expect(entityOwnership.upsert).not.toHaveBeenCalled();
    expect(relationship.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeOwnership — remove OWNS, un-pin RELATES_TO (keep the edge)
// ---------------------------------------------------------------------------

describe("removeOwnership", () => {
  it("deletes the OWNS edge and clears the score-1.0 pin, keeping RELATES_TO", async () => {
    relationship.findFirst.mockResolvedValueOnce({
      id: "rel-1",
      manualScore: 1.0,
      computedScore: 0.05,
    });

    await withTenant(() => ops.removeOwnership("entity-1", "user-1"));

    expect(entityOwnership.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", entityId: "entity-1", userId: "user-1" },
    });
    // Un-pin: manualScore -> null, tier recomputed from the computed score.
    expect(relationship.update).toHaveBeenCalledWith({
      where: { id: "rel-1" },
      data: { manualScore: null, tier: 3 }, // 0.05 -> ambient under default thresholds
    });
    // The RELATES_TO row is NOT deleted.
    expect(relationship.deleteMany).not.toHaveBeenCalled();
  });

  it("does not touch RELATES_TO when there is no manual pin to clear", async () => {
    relationship.findFirst.mockResolvedValueOnce({
      id: "rel-1",
      manualScore: null,
      computedScore: 0.42,
    });

    await withTenant(() => ops.removeOwnership("entity-1", "user-1"));

    expect(entityOwnership.deleteMany).toHaveBeenCalledTimes(1);
    expect(relationship.update).not.toHaveBeenCalled();
  });

  it("removes only the OWNS edge when no RELATES_TO exists", async () => {
    relationship.findFirst.mockResolvedValueOnce(null);

    await withTenant(() => ops.removeOwnership("entity-1", "user-1"));

    expect(entityOwnership.deleteMany).toHaveBeenCalledTimes(1);
    expect(relationship.update).not.toHaveBeenCalled();
  });
});
