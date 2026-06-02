import { Prisma, type PrismaClient } from "@prisma/client";

/** An entity within the search radius, with its true distance in metres. */
export interface NearbyEntity {
  entityId: string;
  distanceMeters: number;
}

/**
 * The geo surface the graph layer depends on. Production uses
 * {@link EntityGeoRepository} (PostGIS); the graph integration tests inject a
 * fake so that suite stays Neo4j-only. Covers both reads (proximity discovery
 * and the recommendations nearby-signal) and the writes that the graph's
 * `syncEntity` dual-write redirects here (Neptune has no spatial type).
 */
export interface EntityGeoLookup {
  /** Entities within `radiusMeters` of a single point, nearest first. */
  findNearby(
    tenantId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    limit: number,
  ): Promise<NearbyEntity[]>;
  /**
   * Entities within `radiusMeters` of *any* anchor (the user's owned entities),
   * ranked by distance to the nearest anchor. Replaces the graph's
   * `reduce(... point.distance ...)` nearby-recommendations signal. The anchors
   * themselves are excluded from the result.
   */
  findNearAnchors(
    tenantId: string,
    anchorIds: string[],
    radiusMeters: number,
    limit: number,
  ): Promise<NearbyEntity[]>;
  /** Upsert an entity's authoritative location (full precision). */
  upsertLocation(entityId: string, tenantId: string, lat: number, lng: number): Promise<void>;
  /** Remove an entity's location (entity deleted / location cleared). */
  removeLocation(entityId: string): Promise<void>;
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
export class EntityGeoRepository implements EntityGeoLookup {
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

  /**
   * Entities within `radiusMeters` of *any* of the `anchorIds`' locations,
   * ranked by distance to the nearest anchor (the `MIN` over the anchor
   * cross-join). This is the Postgres replacement for the graph's
   * `reduce(minD, e IN myEntities | … point.distance …)` nearby signal — the
   * GiST index serves the `ST_DWithin` join, and the aggregate picks the
   * nearest-anchor distance. The anchors themselves are excluded. Tenant-scoped.
   */
  async findNearAnchors(
    tenantId: string,
    anchorIds: string[],
    radiusMeters: number,
    limit: number,
  ): Promise<NearbyEntity[]> {
    if (anchorIds.length === 0) return [];
    const anchors = Prisma.join(anchorIds);
    const rows = await this.prisma.$queryRaw<Array<{ entity_id: string; distance_meters: number }>>`
      SELECT
        c.entity_id,
        MIN(ST_Distance(c.location, a.location)) AS distance_meters
      FROM entity_location c
      JOIN entity_location a
        ON a.tenant_id = ${tenantId}
       AND a.entity_id IN (${anchors})
       AND ST_DWithin(c.location, a.location, ${radiusMeters})
      WHERE c.tenant_id = ${tenantId}
        AND c.entity_id NOT IN (${anchors})
      GROUP BY c.entity_id
      ORDER BY distance_meters ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ entityId: r.entity_id, distanceMeters: Number(r.distance_meters) }));
  }
}
