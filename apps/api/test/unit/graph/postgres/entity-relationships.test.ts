/**
 * Unit tests for the Postgres EntityRelationshipOps adapter.
 *
 * Mocks the Prisma client; exercises the PENDING→CONFIRMED/REJECTED status
 * machine, the three authorization checks (own-source / own-target / own-either),
 * pending lookup, duplicate conflict, and the symmetric/asymmetric reciprocal
 * edge behavior. No DB is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import { EntityRelationshipOps } from "../../../../src/lib/graph/postgres/entity-relationships.js";
import {
  GraphAuthorizationError,
  GraphConflictError,
  GraphNotFoundError,
} from "../../../../src/lib/graph/errors.js";

const TEST_TENANT = tenantId("t-unit-entity-rel");

/** A mock Prisma client with the two delegates this group touches. */
function makePrisma() {
  return {
    entityOwnership: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    entity: {
      findUnique: vi.fn(),
    },
    entityRelationship: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

type MockPrisma = ReturnType<typeof makePrisma>;

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext(TEST_TENANT, fn);
}

describe("EntityRelationshipOps (Postgres)", () => {
  let prisma: MockPrisma;
  let ops: EntityRelationshipOps;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    ops = new EntityRelationshipOps(prisma as any);
  });

  // -------------------------------------------------------------------------
  // createEntityRelationship — own-source authorization + status machine
  // -------------------------------------------------------------------------
  describe("createEntityRelationship", () => {
    const input = {
      entityId: "e-src",
      relatedEntityId: "e-tgt",
      type: "PLAYMATE" as const,
      proposedByUserId: "u-proposer",
    };

    it("throws GraphAuthorizationError when proposer does not own the source entity", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue(null);

      await expect(withTenant(() => ops.createEntityRelationship(input))).rejects.toBeInstanceOf(
        GraphAuthorizationError,
      );
      expect(prisma.entityRelationship.create).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when an entity is missing", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findUnique
        .mockResolvedValueOnce({ id: "e-src" }) // source exists
        .mockResolvedValueOnce(null); // target missing

      await expect(withTenant(() => ops.createEntityRelationship(input))).rejects.toBeInstanceOf(
        GraphNotFoundError,
      );
    });

    it("throws GraphConflictError when a relationship of this type already exists", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findUnique.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });

      await expect(withTenant(() => ops.createEntityRelationship(input))).rejects.toBeInstanceOf(
        GraphConflictError,
      );
      expect(prisma.entityRelationship.create).not.toHaveBeenCalled();
    });

    it("creates a single PENDING edge for a non-auto-confirm type", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findUnique.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);
      prisma.entityRelationship.create.mockResolvedValue({});

      const result = await withTenant(() => ops.createEntityRelationship(input));

      expect(result.status).toBe("PENDING");
      expect(prisma.entityRelationship.create).toHaveBeenCalledTimes(1);
      expect(prisma.entityRelationship.createMany).not.toHaveBeenCalled();
      const data = prisma.entityRelationship.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        tenantId: TEST_TENANT,
        entityId: "e-src",
        relatedEntityId: "e-tgt",
        type: "PLAYMATE",
        status: "PENDING",
        proposedByUserId: "u-proposer",
      });
    });

    it("auto-confirms PACK_MATE when one user holds PRIMARY/CO ownership on BOTH entities (bidirectional edges)", async () => {
      const packInput = { ...input, type: "PACK_MATE" as const };
      prisma.entityOwnership.findFirst
        .mockResolvedValueOnce({ role: "PRIMARY_OWNER" }) // step 1: proposer owns source
        .mockResolvedValueOnce({ userId: "u-shared" }); // step 4: shared owner on target
      prisma.entity.findUnique.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);
      prisma.entityOwnership.findMany.mockResolvedValue([{ userId: "u-shared" }]);
      prisma.entityRelationship.createMany.mockResolvedValue({ count: 2 });

      const result = await withTenant(() => ops.createEntityRelationship(packInput));

      expect(result.status).toBe("CONFIRMED");
      expect(prisma.entityRelationship.createMany).toHaveBeenCalledTimes(1);
      const rows = prisma.entityRelationship.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ entityId: "e-src", relatedEntityId: "e-tgt", status: "CONFIRMED" });
      expect(rows[1]).toMatchObject({ entityId: "e-tgt", relatedEntityId: "e-src", status: "CONFIRMED" });
    });

    it("does NOT auto-confirm PACK_MATE when no shared PRIMARY/CO owner exists", async () => {
      const packInput = { ...input, type: "PACK_MATE" as const };
      prisma.entityOwnership.findFirst
        .mockResolvedValueOnce({ role: "PRIMARY_OWNER" }) // proposer owns source
        .mockResolvedValueOnce(null); // no shared owner on target
      prisma.entity.findUnique.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);
      prisma.entityOwnership.findMany.mockResolvedValue([{ userId: "u-a" }]);
      prisma.entityRelationship.create.mockResolvedValue({});

      const result = await withTenant(() => ops.createEntityRelationship(packInput));

      expect(result.status).toBe("PENDING");
      expect(prisma.entityRelationship.create).toHaveBeenCalledTimes(1);
    });

    it("throws when no tenant context is active (non-nullable tenant_id)", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findUnique.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      // No runWithTenantContext wrapper → getCurrentTenantId() is undefined.
      await expect(ops.createEntityRelationship(input)).rejects.toBeInstanceOf(GraphConflictError);
    });
  });

  // -------------------------------------------------------------------------
  // confirmEntityRelationship — own-target authorization + reciprocal edges
  // -------------------------------------------------------------------------
  describe("confirmEntityRelationship", () => {
    it("throws GraphAuthorizationError when confirmer does not own the TARGET entity", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue(null);

      await expect(
        ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      expect(prisma.entityRelationship.update).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when the relationship does not exist", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      await expect(
        ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"),
      ).rejects.toBeInstanceOf(GraphNotFoundError);
    });

    it("throws GraphConflictError when the relationship is not PENDING", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue({
        id: "rel-1",
        type: "PLAYMATE",
        status: "CONFIRMED",
        proposedByUserId: "u-p",
        since: new Date(),
        tenantId: "t-x",
      });

      await expect(
        ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"),
      ).rejects.toBeInstanceOf(GraphConflictError);
    });

    it("confirms a symmetric edge and CREATES the same-type reciprocal when absent", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entityRelationship.findFirst
        .mockResolvedValueOnce({
          id: "rel-1",
          type: "SIBLING",
          status: "PENDING",
          proposedByUserId: "u-p",
          since,
          tenantId: "t-x",
        })
        .mockResolvedValueOnce(null); // reverse edge does not exist
      prisma.entityRelationship.update.mockResolvedValue({});
      prisma.entityRelationship.create.mockResolvedValue({});

      const result = await ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer");

      expect(result.status).toBe("CONFIRMED");
      expect(result.type).toBe("SIBLING");
      expect(prisma.entityRelationship.update).toHaveBeenCalledWith({
        where: { id: "rel-1" },
        data: { status: "CONFIRMED" },
      });
      const created = prisma.entityRelationship.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        entityId: "e-tgt",
        relatedEntityId: "e-src",
        type: "SIBLING",
        status: "CONFIRMED",
        tenantId: "t-x",
        proposedByUserId: "u-p",
      });
    });

    it("confirms an existing reciprocal edge (symmetric) instead of creating a duplicate", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entityRelationship.findFirst
        .mockResolvedValueOnce({
          id: "rel-1",
          type: "PACK_MATE",
          status: "PENDING",
          proposedByUserId: "u-p",
          since: new Date(),
          tenantId: "t-x",
        })
        .mockResolvedValueOnce({ id: "rel-rev" }); // reverse edge already exists
      prisma.entityRelationship.update.mockResolvedValue({});

      await ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer");

      expect(prisma.entityRelationship.create).not.toHaveBeenCalled();
      expect(prisma.entityRelationship.update).toHaveBeenCalledWith({
        where: { id: "rel-rev" },
        data: { status: "CONFIRMED" },
      });
    });

    it("creates the COMPLEMENTARY type for an asymmetric PARENT→OFFSPRING reciprocal", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entityRelationship.findFirst
        .mockResolvedValueOnce({
          id: "rel-1",
          type: "PARENT",
          status: "PENDING",
          proposedByUserId: "u-p",
          since: new Date(),
          tenantId: "t-x",
        })
        .mockResolvedValueOnce(null);
      prisma.entityRelationship.update.mockResolvedValue({});
      prisma.entityRelationship.create.mockResolvedValue({});

      await ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer");

      // The reverse lookup must be for the inverse type.
      const reverseLookup = prisma.entityRelationship.findFirst.mock.calls[1][0].where;
      expect(reverseLookup).toMatchObject({
        entityId: "e-tgt",
        relatedEntityId: "e-src",
        type: "OFFSPRING",
      });
      const created = prisma.entityRelationship.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ type: "OFFSPRING", status: "CONFIRMED" });
    });
  });

  // -------------------------------------------------------------------------
  // rejectEntityRelationship — own-target authorization
  // -------------------------------------------------------------------------
  describe("rejectEntityRelationship", () => {
    it("throws GraphAuthorizationError when rejecter does not own the TARGET entity", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue(null);

      await expect(
        ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter"),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      expect(prisma.entityRelationship.update).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when the relationship does not exist", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      await expect(
        ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter"),
      ).rejects.toBeInstanceOf(GraphNotFoundError);
    });

    it("sets status to REJECTED", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });
      prisma.entityRelationship.update.mockResolvedValue({});

      await ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter");

      expect(prisma.entityRelationship.update).toHaveBeenCalledWith({
        where: { id: "rel-1" },
        data: { status: "REJECTED" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // removeEntityRelationship — own-either authorization
  // -------------------------------------------------------------------------
  describe("removeEntityRelationship", () => {
    it("throws GraphAuthorizationError when remover owns NEITHER entity", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue(null);

      await expect(
        ops.removeEntityRelationship("e-src", "e-tgt", "u-remover"),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      // Ownership query must allow either entity.
      const where = prisma.entityOwnership.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({
        userId: "u-remover",
        entityId: { in: ["e-src", "e-tgt"] },
      });
      expect(prisma.entityRelationship.deleteMany).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when the relationship does not exist", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "e-tgt" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      await expect(
        ops.removeEntityRelationship("e-src", "e-tgt", "u-remover"),
      ).rejects.toBeInstanceOf(GraphNotFoundError);
    });

    it("deletes both A→B and reciprocal B→A edges", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "e-src" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });
      prisma.entityRelationship.deleteMany.mockResolvedValue({ count: 1 });

      await ops.removeEntityRelationship("e-src", "e-tgt", "u-remover");

      expect(prisma.entityRelationship.deleteMany).toHaveBeenCalledTimes(2);
      expect(prisma.entityRelationship.deleteMany).toHaveBeenNthCalledWith(1, {
        where: { entityId: "e-src", relatedEntityId: "e-tgt" },
      });
      expect(prisma.entityRelationship.deleteMany).toHaveBeenNthCalledWith(2, {
        where: { entityId: "e-tgt", relatedEntityId: "e-src" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // getEntityRelationships — list + filters
  // -------------------------------------------------------------------------
  describe("getEntityRelationships", () => {
    it("returns mapped relationships ordered by since desc with type+status filters applied", async () => {
      const since = new Date("2026-02-02T00:00:00Z");
      prisma.entityRelationship.findMany.mockResolvedValue([
        { relatedEntityId: "e-tgt", type: "PLAYMATE", status: "CONFIRMED", proposedByUserId: "u-p", since },
      ]);

      const result = await ops.getEntityRelationships("e-src", {
        type: "PLAYMATE",
        status: "CONFIRMED",
      });

      expect(result).toEqual([
        {
          entityId: "e-src",
          relatedEntityId: "e-tgt",
          type: "PLAYMATE",
          status: "CONFIRMED",
          proposedByUserId: "u-p",
          since,
        },
      ]);
      const args = prisma.entityRelationship.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({ entityId: "e-src", type: "PLAYMATE", status: "CONFIRMED" });
      expect(args.orderBy).toEqual({ since: "desc" });
    });

    it("omits type/status filters when not provided", async () => {
      prisma.entityRelationship.findMany.mockResolvedValue([]);

      await ops.getEntityRelationships("e-src");

      const where = prisma.entityRelationship.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ entityId: "e-src" });
    });
  });

  // -------------------------------------------------------------------------
  // getPendingEntityRelationships — pending edges where user owns the target
  // -------------------------------------------------------------------------
  describe("getPendingEntityRelationships", () => {
    it("returns [] when the user owns no entities (no query)", async () => {
      prisma.entityOwnership.findMany.mockResolvedValue([]);

      const result = await ops.getPendingEntityRelationships("u-owner");

      expect(result).toEqual([]);
      expect(prisma.entityRelationship.findMany).not.toHaveBeenCalled();
    });

    it("returns PENDING edges whose TARGET is owned by the user", async () => {
      const since = new Date("2026-03-03T00:00:00Z");
      prisma.entityOwnership.findMany.mockResolvedValue([
        { entityId: "e-owned-1" },
        { entityId: "e-owned-2" },
      ]);
      prisma.entityRelationship.findMany.mockResolvedValue([
        { entityId: "e-src", relatedEntityId: "e-owned-1", type: "SIBLING", proposedByUserId: "u-p", since },
      ]);

      const result = await ops.getPendingEntityRelationships("u-owner");

      const where = prisma.entityRelationship.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        status: "PENDING",
        relatedEntityId: { in: ["e-owned-1", "e-owned-2"] },
      });
      expect(result).toEqual([
        {
          entityId: "e-src",
          relatedEntityId: "e-owned-1",
          type: "SIBLING",
          status: "PENDING",
          proposedByUserId: "u-p",
          since,
        },
      ]);
    });
  });
});
