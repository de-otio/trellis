import type { PrismaClient } from "@prisma/client";

/** An entity within the search radius, with its true distance in metres. */
export interface NearbyEntity {
  entityId: string;
  distanceMeters: number;
}

/**
 * Entity geo-proximity over PostGIS (C7). Amazon Neptune (the graph DB) has no
 * spatial type, so geo-proximity lives in Postgres: a `geography(Point,4326)`
 * column on `entity_location`, queried with `ST_DWithin` (GiST-indexed radius
 * filter) + `<->` KNN ordering. All spatial access is raw SQL ($queryRaw /
 * $executeRaw) — Prisma Client cannot express the geography type. Tenant scoping
 * is app-level (`WHERE tenant_id = …`), matching the rest of the codebase (no
 * RLS). The graph contributes relationship facts; proximity is merged in at the
 * call site. See plans/redesign/entity-location-subsystem.md.
 */
export class EntityGeoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert an entity's authoritative location (called from the dual-write when
   * an entity's location is set/changed). Full precision is stored; exposure
   * coarsening happens at read time (see the discovery layer).
   */
  async upsertLocation(entityId: string, tenantId: string, lat: number, lng: number): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO entity_location (entity_id, tenant_id, location, lat, lng, updated_at)
      VALUES (
        ${entityId}, ${tenantId},
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${lat}, ${lng}, NOW()
      )
      ON CONFLICT (entity_id) DO UPDATE SET
        tenant_id  = EXCLUDED.tenant_id,
        location   = EXCLUDED.location,
        lat        = EXCLUDED.lat,
        lng        = EXCLUDED.lng,
        updated_at = NOW()
    `;
  }

  /** Remove an entity's location (entity deleted / location cleared). */
  async removeLocation(entityId: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM entity_location WHERE entity_id = ${entityId}`;
  }

  /**
   * Entities within `radiusMeters` of (lat, lng), nearest first, tenant-scoped.
   * `ST_DWithin` uses the GiST index for the radius filter; `<->` orders by true
   * distance (KNN). Returns true distances — the caller applies any exposure
   * coarsening (e.g. distance bands) before surfacing to a user.
   */
  async findNearby(
    tenantId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    limit: number,
  ): Promise<NearbyEntity[]> {
    const rows = await this.prisma.$queryRaw<Array<{ entity_id: string; distance_meters: number }>>`
      SELECT
        entity_id,
        ST_Distance(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS distance_meters
      FROM entity_location
      WHERE tenant_id = ${tenantId}
        AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})
      ORDER BY location <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ entityId: r.entity_id, distanceMeters: Number(r.distance_meters) }));
  }
}
