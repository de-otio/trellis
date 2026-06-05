/**
 * Integration Tests: EntityGeoRepository (PostGIS)
 *
 * Exercises the spatial read/write surface that the graph layer's geo-discovery
 * delegates to (C7 — Neptune has no spatial type, so proximity lives in
 * Postgres/PostGIS). Verifies `ST_DWithin` radius filtering, `<->` KNN ordering,
 * the `MIN`-over-anchors nearby-recommendations query, tenant scoping, and the
 * upsert/remove writes — against a real PostGIS instance.
 *
 * Opt-in: set GEO_TEST_DATABASE_URL to a PostGIS database that has the
 * `entity_location` table + GiST index (e.g. the local docker `postgis/postgis`
 * dev DB). Skipped otherwise so the default integration run needs no PostGIS.
 *
 *   GEO_TEST_DATABASE_URL=postgresql://trellis:trellis_dev_password@localhost:5432/trellis_dev \
 *     npm run test:integration -- test/integration/entity-geo-repository.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { EntityGeoRepository } from "../../src/lib/geo/entity-geo-repository.js";

const TEST_DB_URL = process.env.GEO_TEST_DATABASE_URL;
const suite = TEST_DB_URL ? describe : describe.skip;

// Berlin-ish reference point; 0.001° latitude ≈ 111 m, so distances are easy to
// reason about (all sample points share the reference longitude).
const REF_LAT = 52.52;
const REF_LNG = 13.405;

const TENANT = "t-geo-itest";
const OTHER_TENANT = "t-geo-itest-other";

// Entity ids (TENANT)
const anchorA = "geo-anchorA"; // at the reference point
const anchorB = "geo-anchorB"; // ~20 km north
const near1 = "geo-near1"; // ~111 m from anchorA
const near2 = "geo-near2"; // ~1.33 km from anchorA
const nearB = "geo-nearB"; // ~111 m from anchorB, ~20 km from anchorA
const far = "geo-far"; // ~50 km from anchorA
// Entity id (OTHER_TENANT) — physically close to anchorA but must never match.
const otherClose = "geo-otherClose";

suite("EntityGeoRepository (PostGIS)", () => {
  let prisma: PrismaClient;
  let repo: EntityGeoRepository;

  async function seedTenant(id: string) {
    await prisma.tenant.create({
      data: { id, slug: id, displayName: id, type: "ORGANIZATION" },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DB_URL! }),
    });
    repo = new EntityGeoRepository(prisma);

    // Clean slate (cascade clears any entity_location rows for these tenants).
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
    await seedTenant(TENANT);
    await seedTenant(OTHER_TENANT);

    await repo.upsertLocation(anchorA, TENANT, REF_LAT, REF_LNG);
    await repo.upsertLocation(anchorB, TENANT, REF_LAT + 0.18, REF_LNG); // ~20 km N
    await repo.upsertLocation(near1, TENANT, REF_LAT + 0.001, REF_LNG); // ~111 m
    await repo.upsertLocation(near2, TENANT, REF_LAT + 0.012, REF_LNG); // ~1.33 km
    await repo.upsertLocation(nearB, TENANT, REF_LAT + 0.181, REF_LNG); // ~111 m from B
    await repo.upsertLocation(far, TENANT, REF_LAT + 0.45, REF_LNG); // ~50 km
    await repo.upsertLocation(otherClose, OTHER_TENANT, REF_LAT + 0.0005, REF_LNG); // ~55 m, wrong tenant
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
    await prisma.$disconnect();
  });

  describe("findNearby", () => {
    it("returns tenant-scoped entities within the radius, nearest first, with true distances", async () => {
      const results = await repo.findNearby(TENANT, REF_LAT, REF_LNG, 5000, 50);
      const ids = results.map((r) => r.entityId);

      // Within 5 km of the reference: anchorA (0 m), near1 (~111 m), near2 (~1.33 km).
      expect(ids).toContain(near1);
      expect(ids).toContain(near2);
      // far (~50 km) is outside the radius; otherClose is the wrong tenant.
      expect(ids).not.toContain(far);
      expect(ids).not.toContain(otherClose);

      // Nearest-first ordering (KNN via <->).
      const byId = new Map(results.map((r) => [r.entityId, r.distanceMeters]));
      expect(byId.get(near1)!).toBeLessThan(byId.get(near2)!);
      // True distances (not coarsened): ~111 m and ~1332 m.
      expect(byId.get(near1)!).toBeGreaterThan(90);
      expect(byId.get(near1)!).toBeLessThan(140);
      expect(byId.get(near2)!).toBeGreaterThan(1250);
      expect(byId.get(near2)!).toBeLessThan(1420);
    });

    it("honours a tight radius (ST_DWithin filter)", async () => {
      const results = await repo.findNearby(TENANT, REF_LAT, REF_LNG, 500, 50);
      const ids = results.map((r) => r.entityId);

      expect(ids).toContain(near1); // ~111 m, inside 500 m
      expect(ids).not.toContain(near2); // ~1.33 km, outside 500 m
    });

    it("respects the limit", async () => {
      const results = await repo.findNearby(TENANT, REF_LAT, REF_LNG, 5000, 1);
      expect(results).toHaveLength(1);
      // The single nearest within radius is anchorA (distance 0).
      expect(results[0].entityId).toBe(anchorA);
    });
  });

  describe("findNearAnchors", () => {
    it("returns candidates near ANY anchor by nearest-anchor distance, excluding the anchors", async () => {
      const results = await repo.findNearAnchors(TENANT, [anchorA, anchorB], 5000, 50);
      const ids = results.map((r) => r.entityId);

      // near1/near2 are near anchorA; nearB is near anchorB.
      expect(ids).toContain(near1);
      expect(ids).toContain(near2);
      expect(ids).toContain(nearB);
      // The anchors themselves are excluded; far is beyond 5 km of both.
      expect(ids).not.toContain(anchorA);
      expect(ids).not.toContain(anchorB);
      expect(ids).not.toContain(far);

      const byId = new Map(results.map((r) => [r.entityId, r.distanceMeters]));
      // nearB's distance is to its NEAREST anchor (B, ~111 m) — proving MIN-over
      // -anchors, not distance to anchorA (~20 km).
      expect(byId.get(nearB)!).toBeGreaterThan(90);
      expect(byId.get(nearB)!).toBeLessThan(140);
      // Overall nearest-first ordering.
      expect(results[0].distanceMeters).toBeLessThanOrEqual(results[results.length - 1].distanceMeters);
    });

    it("is tenant-scoped (a physically-close other-tenant point never matches)", async () => {
      const results = await repo.findNearAnchors(TENANT, [anchorA], 5000, 50);
      expect(results.map((r) => r.entityId)).not.toContain(otherClose);
    });

    it("returns [] for an empty anchor set", async () => {
      const results = await repo.findNearAnchors(TENANT, [], 5000, 50);
      expect(results).toEqual([]);
    });
  });

  describe("upsertLocation / removeLocation", () => {
    it("upsert overwrites an existing point", async () => {
      const id = "geo-upsert-target";
      await repo.upsertLocation(id, TENANT, REF_LAT + 0.001, REF_LNG); // ~111 m
      let hit = (await repo.findNearby(TENANT, REF_LAT, REF_LNG, 5000, 100)).find((r) => r.entityId === id);
      expect(hit).toBeDefined();

      // Move it ~50 km away — it should drop out of a 5 km radius.
      await repo.upsertLocation(id, TENANT, REF_LAT + 0.45, REF_LNG);
      hit = (await repo.findNearby(TENANT, REF_LAT, REF_LNG, 5000, 100)).find((r) => r.entityId === id);
      expect(hit).toBeUndefined();

      await repo.removeLocation(id);
    });

    it("removeLocation deletes the point (and is idempotent)", async () => {
      const id = "geo-remove-target";
      await repo.upsertLocation(id, TENANT, REF_LAT + 0.001, REF_LNG);
      await repo.removeLocation(id);
      await repo.removeLocation(id); // no-op, must not throw

      const ids = (await repo.findNearby(TENANT, REF_LAT, REF_LNG, 5000, 100)).map((r) => r.entityId);
      expect(ids).not.toContain(id);
    });
  });
});
