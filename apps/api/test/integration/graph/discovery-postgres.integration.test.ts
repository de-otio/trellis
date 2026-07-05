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
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithTenantContext, tenantId } from "@de-otio/saas-foundation/tenant";
import {
  DiscoveryOps,
  SHARED_CONNECTIONS_DEGREE_CAP,
} from "../../../src/lib/graph/postgres/discovery.js";

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

  async function ownership(entityId: string, tenant: string, userId: string = U) {
    await prisma.entityOwnership.create({
      data: {
        tenantId: tenant,
        entityId,
        userId,
        role: "PRIMARY_OWNER",
        addedByUserId: userId,
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

  // entity_relationships / relationships / ownerships have no FK cascade from
  // tenant, so a tenant-only deleteMany leaks them — and the global unique
  // constraint on entity_relationships (entity_id, related_entity_id, type) then
  // breaks the next seed. Wipe children explicitly, in FK order.
  async function wipeTenants(ids: string[], userIds: string[]) {
    for (const t of ids) {
      await prisma.entityRelationship.deleteMany({ where: { tenantId: t } });
      await prisma.relationship.deleteMany({ where: { tenantId: t } });
      await prisma.entityOwnership.deleteMany({ where: { tenantId: t } });
      await prisma.entity.deleteMany({ where: { tenantId: t } });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    ops = new DiscoveryOps(prisma);

    await wipeTenants([TENANT, OTHER_TENANT], [U]);

    await seedTenant(TENANT);
    await seedTenant(OTHER_TENANT);
    await prisma.user.create({
      data: { id: U, email: `${U}@example.com`, handle: U, role: "END_USER", personalTenantId: TENANT },
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
    await wipeTenants([TENANT, OTHER_TENANT], [U]);
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

  describe("getRecommendations per-owner diversity cap (MAX_RECOMMENDATIONS_PER_OWNER = 2)", () => {
    // A separate, self-contained fixture: a single hub owner owns five entities
    // that all surface to the viewer via the shared-connections signal. Pre-cap,
    // the hub would fill the whole page; post-cap, at most two of the hub's
    // entities may appear (the relaxation pass only kicks in when the page would
    // otherwise be underfilled — here there are exactly five hub candidates and a
    // limit of 2, so the cap binds and no relaxation occurs).
    const CAP_TENANT = tenantId("t-pg-disc-cap");
    const HUB_TENANT = tenantId("t-pg-disc-cap-hub"); // hub user's personal tenant (personal_tenant_id is unique)
    const VIEWER = "pgcap-viewer";
    const HUB = "pgcap-hub";
    const VSEED = "pgcap-vseed"; // owned by the viewer; the traversal anchor
    const HUB_ENTITIES = ["pgcap-h1", "pgcap-h2", "pgcap-h3", "pgcap-h4", "pgcap-h5"];

    beforeAll(async () => {
      await wipeTenants([CAP_TENANT, HUB_TENANT], [VIEWER, HUB]);

      await prisma.tenant.create({
        data: { id: CAP_TENANT, slug: CAP_TENANT, displayName: CAP_TENANT, type: "ORGANIZATION" },
      });
      await prisma.tenant.create({
        data: { id: HUB_TENANT, slug: HUB_TENANT, displayName: HUB_TENANT, type: "ORGANIZATION" },
      });
      await prisma.user.create({
        data: { id: VIEWER, email: `${VIEWER}@example.com`, handle: VIEWER, role: "END_USER", personalTenantId: CAP_TENANT },
      });
      await prisma.user.create({
        data: { id: HUB, email: `${HUB}@example.com`, handle: HUB, role: "END_USER", personalTenantId: HUB_TENANT },
      });

      // Viewer owns the anchor entity.
      await prisma.entity.create({
        data: { id: VSEED, tenantId: CAP_TENANT, name: VSEED, entityType: "dog", metadata: {} },
      });
      await prisma.entityOwnership.create({
        data: {
          tenantId: CAP_TENANT, entityId: VSEED, userId: VIEWER,
          role: "PRIMARY_OWNER", addedByUserId: VIEWER, status: "ACTIVE",
        },
      });

      // The hub owns five entities, each a CONFIRMED hop-1 neighbour of the anchor.
      for (const hid of HUB_ENTITIES) {
        await prisma.entity.create({
          data: { id: hid, tenantId: CAP_TENANT, name: hid, entityType: "dog", metadata: {} },
        });
        await prisma.entityOwnership.create({
          data: {
            tenantId: CAP_TENANT, entityId: hid, userId: HUB,
            role: "PRIMARY_OWNER", addedByUserId: HUB, status: "ACTIVE",
          },
        });
        await prisma.entityRelationship.create({
          data: {
            tenantId: CAP_TENANT, entityId: VSEED, relatedEntityId: hid,
            type: "PLAYMATE", status: "CONFIRMED", proposedByUserId: VIEWER,
          },
        });
      }
    });

    afterAll(async () => {
      await wipeTenants([CAP_TENANT, HUB_TENANT], [VIEWER, HUB]);
    });

    const runCap = <T>(fn: () => Promise<T>) => runWithTenantContext(CAP_TENANT, fn);

    it("caps a single hub owner's contribution at 2 even when it would fill the page", async () => {
      // No geoLookup → only shared-connections + same-breed run. All five hub
      // entities are shared-connections candidates owned by the same user.
      const results = await runCap(() => ops.getRecommendations(VIEWER, 2));
      // Page limit 2; all candidates owned by HUB; cap holds the page to 2.
      expect(results).toHaveLength(2);
      const ids = new Set(results.map((r) => r.entityId));
      expect(ids.size).toBe(2); // no duplicates
      for (const id of ids) expect(HUB_ENTITIES).toContain(id);
    });

    it("admits at most 2 hub entities when more page slots exist (cap binds, relaxation would only add over-cap if underfilled)", async () => {
      // limit 10, but only the hub's five entities exist. The capped pass admits
      // exactly 2 (the cap); the page is then underfilled (2 < 10) so the single
      // relaxation pass admits the remaining hub entities ignoring the cap. This
      // asserts the documented "fill beats starve" behaviour: with no other owner
      // to diversify toward, the page fills rather than starving at 2.
      const results = await runCap(() => ops.getRecommendations(VIEWER, 10));
      const hubCount = results.filter((r) => HUB_ENTITIES.includes(r.entityId)).length;
      // All five hub entities are the only candidates, so relaxation fills them in.
      expect(hubCount).toBe(5);
      expect(new Set(results.map((r) => r.entityId)).size).toBe(results.length); // no dups
    });
  });

  describe("shared-connections fan-out bounds (hub fixture, hundreds of edges)", () => {
    // A realistic fan-out graph: the viewer owns three anchor entities, all
    // edge-connected to ONE hub entity; the hub has 300 leaf neighbours. The
    // old recursive CTE re-walked the hub once per (seed, path) — this pins
    // the rewritten two-level traversal's bounds: per-node fan-out stops at
    // SHARED_CONNECTIONS_DEGREE_CAP, seed attribution survives the join
    // (every admitted leaf keeps all three seeds → score 0.3).
    const FAN_TENANT = tenantId("t-pg-disc-fanout");
    const FAN_VIEWER = "pgfan-viewer";
    const ANCHORS = ["pgfan-a1", "pgfan-a2", "pgfan-a3"];
    const HUB = "pgfan-hub";
    const LEAF_COUNT = 300;
    const leafId = (i: number) => `pgfan-leaf-${String(i).padStart(3, "0")}`;

    beforeAll(async () => {
      await wipeTenants([FAN_TENANT], [FAN_VIEWER]);
      await seedTenant(FAN_TENANT);
      await prisma.user.create({
        data: {
          id: FAN_VIEWER,
          email: `${FAN_VIEWER}@example.com`,
          handle: FAN_VIEWER,
          role: "END_USER",
          personalTenantId: FAN_TENANT,
        },
      });

      await seedEntity(HUB, FAN_TENANT);
      for (const a of ANCHORS) {
        await seedEntity(a, FAN_TENANT);
        await ownership(a, FAN_TENANT, FAN_VIEWER);
        await edge(a, HUB, "PLAYMATE", "CONFIRMED", FAN_TENANT);
      }
      // Bulk-create the leaf entities + hub edges (300 of each).
      await prisma.entity.createMany({
        data: Array.from({ length: LEAF_COUNT }, (_, i) => ({
          id: leafId(i + 1),
          tenantId: FAN_TENANT,
          name: leafId(i + 1),
          entityType: "dog",
          metadata: {},
        })),
      });
      await prisma.entityRelationship.createMany({
        data: Array.from({ length: LEAF_COUNT }, (_, i) => ({
          tenantId: FAN_TENANT,
          entityId: HUB,
          relatedEntityId: leafId(i + 1),
          type: "PACK_MATE",
          status: "CONFIRMED" as const,
          proposedByUserId: FAN_VIEWER,
        })),
      });
    });

    afterAll(async () => {
      await wipeTenants([FAN_TENANT], [FAN_VIEWER]);
    });

    const runFan = <T,>(fn: () => Promise<T>) => runWithTenantContext(FAN_TENANT, fn);

    it("caps hub fan-out at the degree cap and keeps full seed attribution", async () => {
      // Reach the signal directly (private) — getRecommendations' diversity
      // cap/merge would obscure the traversal-shape assertions.
      const rows = await runFan(() =>
        (ops as unknown as {
          computeSharedConnections(
            u: string,
            t: string,
            l: number,
          ): Promise<Array<{ entityId: string; score: number }>>;
        }).computeSharedConnections(FAN_VIEWER, FAN_TENANT, 1000),
      );
      const ids = rows.map((r) => r.entityId);

      // Hub is a hop-1 candidate; its expansion is truncated at the degree
      // cap. The hub's neighbour list (ordered by id) starts with the three
      // anchors ("pgfan-a…" < "pgfan-leaf-…"), so the cap admits the anchors
      // plus the first (DEGREE_CAP − 3) leaves — deterministic truncation.
      expect(ids).toContain(HUB);
      const admittedLeaves = SHARED_CONNECTIONS_DEGREE_CAP - ANCHORS.length;
      const leaves = ids.filter((id) => id.startsWith("pgfan-leaf-"));
      expect(leaves).toHaveLength(admittedLeaves);
      expect(rows).toHaveLength(admittedLeaves + 1); // + the hub (anchors are owned → excluded)
      // Deterministic truncation: the first N leaves by id.
      expect([...leaves].sort()).toEqual(
        Array.from({ length: admittedLeaves }, (_, i) => leafId(i + 1)),
      );
      // Seed attribution survives the two-level join: every leaf is 2 hops
      // from ALL three anchors → COUNT(DISTINCT seed)/10 = 0.3. Same for hub.
      for (const row of rows) {
        expect(row.score).toBeCloseTo(0.3, 10);
      }
    });

    it("anchors below the caps traverse exactly (hop-1 candidate from every anchor)", async () => {
      // The hub itself: hop 1 from all three anchors, not owned/related →
      // candidate. Anchors: owned → excluded. (Exactness below the caps is
      // additionally EXCEPT-proven against the old recursive CTE in the AR8
      // fix; this pins the class-level behavior.)
      const rows = await runFan(() =>
        (ops as unknown as {
          computeSharedConnections(
            u: string,
            t: string,
            l: number,
          ): Promise<Array<{ entityId: string }>>;
        }).computeSharedConnections(FAN_VIEWER, FAN_TENANT, 1000),
      );
      const ids = rows.map((r) => r.entityId);
      for (const a of ANCHORS) expect(ids).not.toContain(a);
      expect(ids).toContain(HUB);
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
