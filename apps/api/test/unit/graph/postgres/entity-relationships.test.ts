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
      // M8: the target-entity check is now `findFirst({ id, tenantId })` — a
      // tenant-scoped lookup, not a bare PK existence probe.
      findFirst: vi.fn(),
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
      prisma.entity.findFirst
        .mockResolvedValueOnce({ id: "e-src" }) // source exists
        .mockResolvedValueOnce(null); // target missing

      await expect(withTenant(() => ops.createEntityRelationship(input))).rejects.toBeInstanceOf(
        GraphNotFoundError,
      );
    });

    it("throws GraphConflictError when a relationship of this type already exists", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });

      await expect(withTenant(() => ops.createEntityRelationship(input))).rejects.toBeInstanceOf(
        GraphConflictError,
      );
      expect(prisma.entityRelationship.create).not.toHaveBeenCalled();
    });

    it("creates a single PENDING edge for a non-auto-confirm type", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
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
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
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
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);
      prisma.entityOwnership.findMany.mockResolvedValue([{ userId: "u-a" }]);
      prisma.entityRelationship.create.mockResolvedValue({});

      const result = await withTenant(() => ops.createEntityRelationship(packInput));

      expect(result.status).toBe("PENDING");
      expect(prisma.entityRelationship.create).toHaveBeenCalledTimes(1);
    });

    // -----------------------------------------------------------------------
    // M8 — cross-tenant relatedEntityId (security review 2026-08, lane 7)
    // -----------------------------------------------------------------------
    it("scopes BOTH entity existence checks to the caller's tenant", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);
      prisma.entityRelationship.create.mockResolvedValue({});

      await withTenant(() => ops.createEntityRelationship(input));

      // The TARGET check is the one that was tenant-blind ("keyed by the
      // globally-unique cuid PK, so no tenant scope is needed") — which is true
      // of uniqueness and false of authorization.
      const wheres = prisma.entity.findFirst.mock.calls.map((c: any) => c[0].where);
      expect(wheres).toHaveLength(2);
      for (const where of wheres) {
        expect(where.tenantId).toBe(TEST_TENANT);
      }
      expect(wheres[1].id).toBe("e-tgt");
    });

    it("REFUSES a relatedEntityId that exists only in another tenant", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      // The source resolves in this tenant; the target does not, because the
      // scoped lookup does not see the other tenant's row. This is the attack:
      // a T1 user pointing a PENDING edge at a T2 entity, producing an orphan
      // the T2 owner never sees in any pending list.
      prisma.entity.findFirst
        .mockResolvedValueOnce({ id: "e-src" })
        .mockResolvedValueOnce(null);

      await expect(
        withTenant(() => ops.createEntityRelationship(input)),
      ).rejects.toBeInstanceOf(GraphNotFoundError);

      // Nothing was written. The orphan edge is the payload of this defect.
      expect(prisma.entityRelationship.create).not.toHaveBeenCalled();
      expect(prisma.entityRelationship.createMany).not.toHaveBeenCalled();
    });

    it("gives the SAME error for a foreign entity and a nonexistent one, naming neither id", async () => {
      // The existence-oracle half of M8. If "exists in T2" and "does not exist"
      // produced distinguishable outcomes, this endpoint would answer
      // "does entity <cuid> exist anywhere?" for any caller.
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });

      const messages: string[] = [];
      for (const _case of ["foreign", "absent"]) {
        vi.clearAllMocks();
        prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
        prisma.entity.findFirst
          .mockResolvedValueOnce({ id: "e-src" })
          .mockResolvedValueOnce(null);
        await withTenant(() => ops.createEntityRelationship(input)).catch(
          (e: Error) => messages.push(e.message),
        );
      }

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe(messages[1]);
      expect(messages[0]).not.toContain("e-tgt");
      expect(messages[0]).not.toContain("e-src");
    });

    it("throws when no tenant context is active, BEFORE touching the database", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "PRIMARY_OWNER" });
      prisma.entity.findFirst.mockResolvedValue({ id: "x" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      // No runWithTenantContext wrapper → getCurrentTenantId() is undefined.
      // L3b moved this refusal from the WRITE (where it used to be, via the
      // old requireTenantId) to the first line of the method, so the
      // ownership check above never runs unscoped either.
      await expect(ops.createEntityRelationship(input)).rejects.toBeInstanceOf(
        GraphAuthorizationError,
      );
      expect(prisma.entityOwnership.findFirst).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // confirmEntityRelationship — own-target authorization + reciprocal edges
  // -------------------------------------------------------------------------
  describe("confirmEntityRelationship", () => {
    it("throws GraphAuthorizationError when confirmer does not own the TARGET entity", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue(null);

      await expect(
        withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer")),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      expect(prisma.entityRelationship.update).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when the relationship does not exist", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      await expect(
        withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer")),
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
        withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer")),
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

      const result = await withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"));

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

      await withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"));

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

      await withTenant(() => ops.confirmEntityRelationship("e-src", "e-tgt", "u-confirmer"));

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
        withTenant(() => ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter")),
      ).rejects.toBeInstanceOf(GraphAuthorizationError);
      expect(prisma.entityRelationship.update).not.toHaveBeenCalled();
    });

    it("throws GraphNotFoundError when the relationship does not exist", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue(null);

      await expect(
        withTenant(() => ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter")),
      ).rejects.toBeInstanceOf(GraphNotFoundError);
    });

    it("sets status to REJECTED", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ role: "CO_OWNER" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });
      prisma.entityRelationship.update.mockResolvedValue({});

      await withTenant(() => ops.rejectEntityRelationship("e-src", "e-tgt", "u-rejecter"));

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
        withTenant(() => ops.removeEntityRelationship("e-src", "e-tgt", "u-remover")),
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
        withTenant(() => ops.removeEntityRelationship("e-src", "e-tgt", "u-remover")),
      ).rejects.toBeInstanceOf(GraphNotFoundError);
    });

    it("deletes both A→B and reciprocal B→A edges", async () => {
      prisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "e-src" });
      prisma.entityRelationship.findFirst.mockResolvedValue({ id: "rel-1" });
      prisma.entityRelationship.deleteMany.mockResolvedValue({ count: 1 });

      await withTenant(() => ops.removeEntityRelationship("e-src", "e-tgt", "u-remover"));

      expect(prisma.entityRelationship.deleteMany).toHaveBeenCalledTimes(2);
      // BOTH deleteMany calls carry the tenant. This is the L3b assertion for
      // this class: `tenantScope()` used to return `{}` with no ambient tenant,
      // which turned these two statements into an unscoped, cross-tenant mass
      // delete of every A↔B typed edge in the installation.
      expect(prisma.entityRelationship.deleteMany).toHaveBeenNthCalledWith(1, {
        where: {
          tenantId: TEST_TENANT,
          entityId: "e-src",
          relatedEntityId: "e-tgt",
        },
      });
      expect(prisma.entityRelationship.deleteMany).toHaveBeenNthCalledWith(2, {
        where: {
          tenantId: TEST_TENANT,
          entityId: "e-tgt",
          relatedEntityId: "e-src",
        },
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

      const result = await withTenant(() =>
        ops.getEntityRelationships("e-src", {
          type: "PLAYMATE",
          status: "CONFIRMED",
        }),
      );

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

      await withTenant(() => ops.getEntityRelationships("e-src"));

      const where = prisma.entityRelationship.findMany.mock.calls[0][0].where;
      // The tenant predicate is NOT one of the optional filters — it is always
      // present, whatever the caller passed.
      expect(where).toEqual({ tenantId: TEST_TENANT, entityId: "e-src" });
    });
  });

  // -------------------------------------------------------------------------
  // getPendingEntityRelationships — pending edges where user owns the target
  // -------------------------------------------------------------------------
  describe("getPendingEntityRelationships", () => {
    it("returns [] when the user owns no entities (no query)", async () => {
      prisma.entityOwnership.findMany.mockResolvedValue([]);

      const result = await withTenant(() => ops.getPendingEntityRelationships("u-owner"));

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

      const result = await withTenant(() => ops.getPendingEntityRelationships("u-owner"));

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
