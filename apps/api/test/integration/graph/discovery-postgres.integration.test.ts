/**
 * Integration Tests: PostgresGraphService.DiscoveryOps — the recursive CTE
 *
 * The ≤2-hop undirected traversal in `discoverByGraph` (and the same-shape
 * shared-connections recommendation signal) is the one query that has to be
 * proven against a live Postgres — the unit tests only assert the emitted SQL
 * shape. This suite seeds entities / ownerships / entity_relationships /
 * relationships and asserts hop semantics, the hop cap, already-related
 * exclusion, discoverability, breed-from-metadata filtering, and tenant
 * isolation against real CTE evaluation.
 *
 * Opt-in: set DATABASE_URL to a Postgres database migrated to the current
 * schema (e.g. the local docker dev DB). Skipped otherwise so the default run
 * needs no DB.
 *
 *   DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev \
 *     npm run test:integration -- test/integration/graph/discovery-postgres.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import { DiscoveryOps } from "../../../src/lib/graph/postgres/discovery.js";

const TEST_DB_URL = process.env.DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

const TENANT = tenantId("t-pg-disc-itest");
const OTHER_TENANT = tenantId("t-pg-disc-itest-other");

// User owns A. A —PLAYMATE— B (hop 1). B —SIBLING— C (hop 2). C —PACK_MATE— D (hop 3, must be unreachable).
// A —WALK_BUDDY— P, but P is PENDING (must not traverse).
// related: user already RELATES_TO B (must be excluded from results).
// hidden: hop-1 neighbour with metadata.discoverable=false (must be excluded).
// otherEnt: in OTHER_TENANT, edge-connected, must never appear.
const U = "pgdisc-user";
const A = "pgdisc-A";
const B = "pgdisc-B";
const C = "pgdisc-C";
const D = "pgdisc-D";
const P = "pgdisc-P";
const HIDDEN = "pgdisc-HIDDEN";
const OTHER_ENT = "pgdisc-OTHER";

suite("PostgresGraphService.DiscoveryOps (live CTE)", () => {
  let prisma: PrismaClient;
  let ops: DiscoveryOps;

  async function seedTenant(id: string) {
    await prisma.tenant.create({ data: { id, slug: id, displayName: id, type: "ORGANIZATION" } });
  }

  async function seedEntity(id: string, tenant: string, opts?: { breed?: string; discoverable?: boolean }) {
    const metadata: Prisma.InputJsonObject = {
      ...(opts?.breed ? { breed: opts.breed } : {}),
      ...(opts?.discoverable === false ? { discoverable: false } : {}),
    };
    await prisma.entity.create({
      data: { id, tenantId: tenant, name: id, entityType: "dog", metadata },
    });
  }

  async function ownership(entityId: string, tenant: string) {
    await prisma.entityOwnership.create({
      data: {
        tenantId: tenant,
        entityId,
        userId: U,
        role: "PRIMARY_OWNER",
        addedByUserId: U,
        status: "ACTIVE",
      },
    });
  }

  async function edge(
    a: string,
    b: string,
    type: "PLAYMATE" | "SIBLING" | "PACK_MATE" | "WALK_BUDDY",
    status: "CONFIRMED" | "PENDING",
    tenant: string,
  ) {
    await prisma.entityRelationship.create({
      data: { tenantId: tenant, entityId: a, relatedEntityId: b, type, status, proposedByUserId: U },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    ops = new DiscoveryOps(prisma);

    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
    await prisma.user.deleteMany({ where: { id: U } });

    await seedTenant(TENANT);
    await seedTenant(OTHER_TENANT);
    await prisma.user.create({
      data: { id: U, email: `${U}@example.com`, role: "END_USER", personalTenantId: TENANT },
    });

    await seedEntity(A, TENANT, { breed: "Labrador" });
    await seedEntity(B, TENANT, { breed: "Poodle" });
    await seedEntity(C, TENANT, { breed: "Husky" });
    await seedEntity(D, TENANT);
    await seedEntity(P, TENANT);
    await seedEntity(HIDDEN, TENANT, { discoverable: false });
    await seedEntity(OTHER_ENT, OTHER_TENANT);

    await ownership(A, TENANT);

    await edge(A, B, "PLAYMATE", "CONFIRMED", TENANT); // hop 1
    await edge(B, C, "SIBLING", "CONFIRMED", TENANT); // hop 2
    await edge(C, D, "PACK_MATE", "CONFIRMED", TENANT); // hop 3 (unreachable at cap 2)
    await edge(A, P, "WALK_BUDDY", "PENDING", TENANT); // pending — not traversed
    await edge(A, HIDDEN, "PLAYMATE", "CONFIRMED", TENANT); // hop 1 but non-discoverable
    // cross-tenant edge: A (this tenant) to OTHER_ENT, recorded under OTHER_TENANT.
    await edge(A, OTHER_ENT, "PLAYMATE", "CONFIRMED", OTHER_TENANT);

    // The user already relates to B → B must be excluded from discovery.
    await prisma.relationship.create({
      data: {
        tenantId: TENANT,
        userId: U,
        targetType: "entity",
        targetId: B,
        connectionMethod: "discovery",
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
    await prisma.user.deleteMany({ where: { id: U } });
    await prisma.$disconnect();
  });

  const run = <T>(fn: () => Promise<T>) => runWithTenantContext(TENANT, fn);

  describe("discoverByGraph", () => {
    it("traverses ≤2 hops undirected, excludes already-related / non-discoverable / pending / hop-3 / cross-tenant", async () => {
      const results = await run(() => ops.discoverByGraph(U, 2));
      const ids = results.map((r) => r.entityId);

      expect(ids).toContain(C); // hop 2, discoverable, not related
      expect(ids).not.toContain(A); // own entity
      expect(ids).not.toContain(B); // already related
      expect(ids).not.toContain(D); // hop 3 — beyond the cap
      expect(ids).not.toContain(P); // pending edge — not traversed
      expect(ids).not.toContain(HIDDEN); // discoverable=false
      expect(ids).not.toContain(OTHER_ENT); // other tenant

      const c = results.find((r) => r.entityId === C);
      expect(c?.hops).toBe(2);
      expect(c?.breed).toBe("Husky");
    });

    it("hop cap 1 reaches only direct neighbours (C at hop 2 disappears)", async () => {
      const results = await run(() => ops.discoverByGraph(U, 1));
      const ids = results.map((r) => r.entityId);
      expect(ids).not.toContain(C);
      // B is a hop-1 neighbour but already-related; HIDDEN is hop-1 but non-discoverable.
      // So with only A owned, hop-1 discoverable+unrelated set is empty here.
      expect(ids).not.toContain(B);
      expect(ids).not.toContain(HIDDEN);
    });

    it("a caller hops value > 2 is clamped to 2 (D at hop 3 stays unreachable)", async () => {
      const results = await run(() => ops.discoverByGraph(U, 99));
      expect(results.map((r) => r.entityId)).not.toContain(D);
    });

    it("breed filter matches metadata->>'breed'", async () => {
      const husky = await run(() => ops.discoverByGraph(U, 2, { breed: "Husky" }));
      expect(husky.map((r) => r.entityId)).toEqual([C]);

      const none = await run(() => ops.discoverByGraph(U, 2, { breed: "Beagle" }));
      expect(none).toHaveLength(0);
    });

    it("returns [] with no tenant in context", async () => {
      const results = await ops.discoverByGraph(U, 2);
      expect(results).toEqual([]);
    });
  });

  describe("getRecommendations shared-connections signal (same CTE shape, no geo)", () => {
    it("surfaces ≤2-hop candidates as shared_connections, excluding owned/related", async () => {
      // No geoLookup → only shared-connections + same-breed signals run.
      const results = await run(() => ops.getRecommendations(U, 10));
      const byId = new Map(results.map((r) => [r.entityId, r]));

      // C is reachable (hop 2) and not owned/related → shared_connections candidate.
      expect(byId.has(C)).toBe(true);
      // B is already related, A is owned → never recommended.
      expect(byId.has(B)).toBe(false);
      expect(byId.has(A)).toBe(false);
      // D IS surfaced: getRecommendations seeds from OWNS|RELATES_TO (owned +
      // followed), and the user follows B, so D is 2 hops from B — within the
      // *1..2 shared-connections traversal (matches the Neo4j semantics). It is
      // only D's distance FROM THE OWNED entity A that is 3; the related-B seed
      // brings it in range. HIDDEN (non-discoverable) stays excluded.
      expect(byId.has(D)).toBe(true);
      expect(byId.has(HIDDEN)).toBe(false);
      // reason is the client-facing union (owner_proximity never surfaces).
      for (const r of results) {
        expect(["shared_connections", "same_breed", "nearby"]).toContain(r.reason);
      }
    });
  });
});
