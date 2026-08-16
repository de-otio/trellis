/**
 * Integration Tests: two-tenant isolation of the Postgres graph adapter.
 *
 * Security review 2026-08, lane 7. The unit suites mock Prisma, so they can
 * only assert the SHAPE of the `where` an adapter builds — they would pass just
 * as happily if the predicate admitted everything. These are the outcome
 * assertions: two tenants, real rows, real Postgres, does anything cross.
 *
 * Findings encoded here, each as the concrete attack the review describes:
 *
 *   L3b (HIGH-1)  — RelationshipOps remove/update/get(s)/getGraph and SyncOps
 *                   built `where` with `tenantId: undefined`, which Prisma
 *                   DROPS, so they ran across every tenant.
 *   M7  (MED-3)   — the reverse-edge lookup that SETS `reciprocated` was not
 *                   tenant-scoped while the CLEAR was, so a cross-tenant edge
 *                   left a permanent, unrevokable consent grant.
 *   Phase 8       — `getRelationships` loaded the whole edge set and applied an
 *                   unclamped caller limit in application memory.
 *
 * Opt-in: needs DATABASE_URL (or TEST_DB_URL via the graph-lane config)
 * pointing at a Postgres carrying the trellis schema. Skipped otherwise.
 *
 * REQUIRES THE M7 MIGRATION (20260816090000_m7_relationship_tenant_unique_key).
 * Half of these tests put the same (user, target) pair in two tenants, which
 * the old tenant-blind unique key makes impossible — and a database still
 * carrying that key fails here with a raw
 * `Unique constraint failed on the fields: (user_id, target_type, target_id)`,
 * which reads like a test bug rather than an un-migrated database. `beforeAll`
 * therefore checks for the new index up front and says so. It does NOT skip:
 * a security suite that quietly disappears when the schema is stale is worse
 * than one that fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import {
  MAX_RELATIONSHIP_PAGE_SIZE,
  RelationshipOps,
} from "../../../src/lib/graph/postgres/relationships.js";
import { SyncOps } from "../../../src/lib/graph/postgres/sync.js";
import { GraphAuthorizationError } from "../../../src/lib/graph/errors.js";

const TEST_DB_URL = process.env.DATABASE_URL ?? process.env.TEST_DB_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const T1 = "t-iso-tenant-one";
const T2 = "t-iso-tenant-two";
const USER_A = "iso-user-a";
const USER_B = "iso-user-b";
const ENTITIES = ["iso-e1", "iso-e2", "iso-e3", "iso-e4", "iso-e5"];

suite("graph tenant isolation (live Postgres)", () => {
  let prisma: PrismaClient;
  let ops: RelationshipOps;
  let sync: SyncOps;

  const inT1 = <T>(fn: () => T): T => runWithTenantContext(tenantId(T1), fn);
  const inT2 = <T>(fn: () => T): T => runWithTenantContext(tenantId(T2), fn);

  /** Read a raw edge row, bypassing the adapter, to check what is on disk. */
  async function edge(tenant: string, userId: string, targetId: string) {
    return prisma.relationship.findFirst({
      where: { tenantId: tenant, userId, targetType: "user", targetId },
      select: { reciprocated: true, tenantId: true },
    });
  }

  async function wipeEdges() {
    await prisma.relationship.deleteMany({
      where: { tenantId: { in: [T1, T2] } },
    });
  }

  async function wipe() {
    await wipeEdges();
    await prisma.entity.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    ops = new RelationshipOps(prisma);
    sync = new SyncOps(prisma);

    // Fail fast and legibly on an un-migrated database (see the module doc).
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'relationships'
    `;
    const names = indexes.map((i) => i.indexname);
    if (
      !names.includes("relationships_tenant_id_user_id_target_type_target_id_key")
    ) {
      throw new Error(
        "This database predates migration 20260816090000_m7_relationship_tenant_unique_key. " +
          "The relationships unique key is still tenant-blind, so the same (user, target) " +
          "pair cannot exist in two tenants and these tests cannot express the attack. " +
          `Apply migrations first. Indexes present: ${names.join(", ")}`,
      );
    }

    await wipe();
    for (const id of [T1, T2]) {
      await prisma.tenant.create({
        data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
      });
    }
    for (const id of [USER_A, USER_B]) {
      await prisma.user.create({
        data: { id, email: `${id}@example.com`, handle: id },
      });
    }
    // Entities live in T1 only — the page-size tests need several targets.
    for (const e of ENTITIES) {
      await prisma.entity.create({
        data: { id: e, tenantId: T1, name: e, entityType: "dog" },
      });
    }
  });

  beforeEach(wipeEdges);

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // M7 — reciprocated must be set and cleared within the same tenant
  // -------------------------------------------------------------------------
  describe("reciprocated set/clear symmetry (M7)", () => {
    it("a reverse edge in ANOTHER tenant does not grant reciprocity here", async () => {
      // The attack, verbatim from the review: A→B in T1; B creates B→A in T2.
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_B,
          targetType: "user",
          targetId: USER_A,
        }),
      );

      // Before the fix BOTH rows flipped to reciprocated = true, so T1 believed
      // B had consented back with no T1 edge from B existing at all.
      expect(await edge(T1, USER_A, USER_B)).toMatchObject({
        reciprocated: false,
      });
      expect(await edge(T2, USER_B, USER_A)).toMatchObject({
        reciprocated: false,
      });
    });

    it("a reverse edge in the SAME tenant still grants it (non-vacuity)", async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT1(() =>
        ops.createRelationship({
          userId: USER_B,
          targetType: "user",
          targetId: USER_A,
        }),
      );

      expect(await edge(T1, USER_A, USER_B)).toMatchObject({
        reciprocated: true,
      });
      expect(await edge(T1, USER_B, USER_A)).toMatchObject({
        reciprocated: true,
      });
    });

    it("the grant is revocable: removing the reverse edge clears it", async () => {
      // The half that made MEDIUM-3 an authorization bug rather than a
      // bookkeeping one — the pre-fix clear was tenant-scoped while the set was
      // not, so a cross-tenant grant could never be taken back.
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT1(() =>
        ops.createRelationship({
          userId: USER_B,
          targetType: "user",
          targetId: USER_A,
        }),
      );
      expect(await edge(T1, USER_A, USER_B)).toMatchObject({
        reciprocated: true,
      });

      await inT1(() => ops.removeRelationship(USER_B, "user", USER_A));

      expect(await edge(T1, USER_A, USER_B)).toMatchObject({
        reciprocated: false,
      });
    });

    it("removing an edge in one tenant leaves the other tenant's edge alone", async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );

      await inT1(() => ops.removeRelationship(USER_A, "user", USER_B));

      expect(await edge(T1, USER_A, USER_B)).toBeNull();
      expect(await edge(T2, USER_A, USER_B)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // L3b — reads and deletes refuse rather than widening
  // -------------------------------------------------------------------------
  describe("fail-closed without an ambient tenant (L3b)", () => {
    it("getRelationships refuses instead of returning every tenant's edges", async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );

      // No tenant context. Pre-fix this returned BOTH rows.
      await expect(ops.getRelationships(USER_A)).rejects.toBeInstanceOf(
        GraphAuthorizationError,
      );
    });

    it("SyncOps.removeUser refuses instead of deleting across every tenant", async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );

      await expect(sync.removeUser(USER_A)).rejects.toBeInstanceOf(
        GraphAuthorizationError,
      );

      // Both rows survive. Pre-fix, an unscoped deleteMany took them all.
      expect(await edge(T1, USER_A, USER_B)).not.toBeNull();
      expect(await edge(T2, USER_A, USER_B)).not.toBeNull();
    });

    it("scoped removeUser deletes only the calling tenant's edges", async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );

      await inT1(() => sync.removeUser(USER_A));

      expect(await edge(T1, USER_A, USER_B)).toBeNull();
      expect(await edge(T2, USER_A, USER_B)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Tenant-scoped reads return only the calling tenant's rows
  // -------------------------------------------------------------------------
  describe("scoped reads", () => {
    beforeEach(async () => {
      await inT1(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
      await inT2(() =>
        ops.createRelationship({
          userId: USER_A,
          targetType: "user",
          targetId: USER_B,
        }),
      );
    });

    it("getRelationships returns one row per tenant, not the union", async () => {
      const inOne = await inT1(() => ops.getRelationships(USER_A));
      const inTwo = await inT2(() => ops.getRelationships(USER_A));

      expect(inOne.items).toHaveLength(1);
      expect(inTwo.items).toHaveLength(1);
    });

    it("getRelationship resolves the edge in the calling tenant only", async () => {
      await inT1(() => ops.removeRelationship(USER_A, "user", USER_B));

      expect(await inT1(() => ops.getRelationship(USER_A, "user", USER_B))).toBeNull();
      expect(
        await inT2(() => ops.getRelationship(USER_A, "user", USER_B)),
      ).not.toBeNull();
    });

    it("getRelationshipGraph is tenant-scoped too", async () => {
      const graph = await inT1(() => ops.getRelationshipGraph(USER_A));
      expect(graph.nodes).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 8 — the page size is enforced by the database
  // -------------------------------------------------------------------------
  describe("page-size clamp is executed in SQL", () => {
    beforeEach(async () => {
      for (const e of ENTITIES) {
        await inT1(() =>
          ops.createRelationship({
            userId: USER_A,
            targetType: "entity",
            targetId: e,
          }),
        );
      }
    });

    it("returns exactly the requested page and reports hasMore", async () => {
      const page = await inT1(() =>
        ops.getRelationships(USER_A, { pagination: { limit: 3 } }),
      );

      expect(page.items).toHaveLength(3);
      expect(page.hasMore).toBe(true);
      expect(page.cursor).not.toBeNull();
    });

    it("survives an absurd caller limit rather than honouring it", async () => {
      // The unclamped path applied this number AFTER loading the full edge set.
      const page = await inT1(() =>
        ops.getRelationships(USER_A, { pagination: { limit: 10_000_000 } }),
      );

      expect(page.items.length).toBeLessThanOrEqual(MAX_RELATIONSHIP_PAGE_SIZE);
      expect(page.items).toHaveLength(ENTITIES.length);
    });

    it("walks every edge across pages without dropping or repeating one", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page: Awaited<ReturnType<typeof ops.getRelationships>> =
          await inT1(() =>
            ops.getRelationships(USER_A, {
              pagination: { limit: 2, cursor: cursor ?? undefined },
            }),
          );
        seen.push(...page.items.map((r) => r.targetId));
        cursor = page.cursor;
        if (!page.hasMore) break;
      }

      expect(seen.sort()).toEqual([...ENTITIES].sort());
    });
  });
});
