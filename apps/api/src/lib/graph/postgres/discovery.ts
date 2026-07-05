/**
 * Discovery + recommendation operations on Postgres.
 *
 * Phase 1 · B4 (long pole). PORT from neo4j-graph-service.ts.
 * `discoverByGraph` is the ≤2-hop undirected recursive CTE (sketch in the graph-DB
 * revisit doc, "The one query that needs proving"); `getRecommendations`'
 * shared-connections signal is the same shape; `discoverNearby` delegates to
 * Postgres/PostGIS via EntityGeoLookup and re-homes the read-time coarsening.
 *
 * SEMANTIC NOTES (port fidelity):
 *  - Edges live in `entity_relationships` (undirected: either column may hold the
 *    near/far end). Confirmed edges only (`status = 'CONFIRMED'`), restricted to
 *    the traversal label set.
 *  - The Neo4j nodes only ever stored entityType/name/breed/lifeStage (see
 *    syncEntity); `discoverable` was never written, so Cypher's
 *    "discoverable IS NULL OR = true" was always true. In Postgres `breed` lives
 *    in `entities.metadata->>'breed'`, `lifeStage` in `entities.life_stage`,
 *    `entityType` in `entities.entity_type`. There is NO `discoverable` column, so
 *    the faithful equivalent reads it out of metadata and defaults to true:
 *    `COALESCE((metadata->>'discoverable')::boolean, true) = true` — a no-op when
 *    the key is absent, exactly like the graph. See report for the schema note.
 *  - Tenant scoping: every graph-shaped table carries `tenant_id`. The Neo4j
 *    discovery path returned [] with no tenant in context for the geo signals;
 *    the Postgres path makes that uniform — all three methods resolve the ambient
 *    tenant up front and return [] when absent, and every table touch is
 *    `tenant_id = $tenant` scoped (defence in depth; the graph DB had no
 *    tenant labels at all).
 */
import type { PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type { EntityGeoLookup } from "../../geo/entity-geo-repository.js";
import type {
  DiscoveryFilters,
  DiscoveryResult,
  NearbyFilters,
  Recommendation,
  RecommendationReason,
} from "../types.js";

/**
 * Entity-edge labels traversed during discovery. Mirrors the fixed Cypher label
 * set `PLAYMATE|PACK_MATE|SIBLING|PARENT|OFFSPRING|WALK_BUDDY`. Hard-coded (not
 * user input) so it is safe to bind as a single `= ANY($n)` array parameter.
 */
const TRAVERSAL_EDGE_TYPES = [
  "PACK_MATE",
  "SIBLING",
  "PLAYMATE",
  "PARENT",
  "OFFSPRING",
  "WALK_BUDDY",
] as const;

/** Radius (m) for the recommendations nearby signal. Mirrors the Neo4j constant. */
const NEARBY_RECO_RADIUS_METERS = 5000;

/**
 * Traversal bounds for the shared-connections signal (graph-DoS guards, same
 * family as the hop hard-cap above):
 *
 * - SEED_CAP — at most this many seed entities (owned + related) anchor the
 *   traversal; deterministic (ordered by id) so repeat queries see the same
 *   subgraph.
 * - DEGREE_CAP — per-node neighbour fan-out limit at each expansion level;
 *   deterministic (ordered by neighbour id). A hub node with thousands of
 *   edges contributes its first DEGREE_CAP neighbours instead of exploding
 *   the traversal (the old recursive CTE materialized
 *   O(seeds × hub-degree) duplicate paths — no visited set).
 *
 * Below both caps the traversal is EXACT (row-for-row identical to the old
 * recursive CTE — proven by EXCEPT-diff on a mixed-shape fixture); above
 * them it is deliberately truncated. Like the hop cap these are structural
 * DoS bounds baked into the traversal shape, not operator-tunable
 * thresholds, so they are compile-time constants (threshold-secrecy rule
 * does not apply — they are visible in the query shape anyway).
 */
export const SHARED_CONNECTIONS_SEED_CAP = 100;
export const SHARED_CONNECTIONS_DEGREE_CAP = 100;

/**
 * Discovery ranking version — increment whenever the recommendation signals,
 * their weights, the merge/dedup semantics, or the diversity cap change.
 *
 * Mirrors `FEED_RANKING_VERSION` (feed-pagination.ts): a version change is a new
 * experimental condition for `/api/discovery/recommendations` and must be
 * audited accordingly. The discovery surface is engagement-adjacent (signals are
 * derived from the relationship graph), so the same provenance discipline applies.
 *
 * Current version 1: shared-connections (count/10) + same-breed (0.6 fixed) +
 * nearby ((1 − d/10 000) × 0.5, 5 km) signals, dedup-by-entity-keep-highest, and
 * the per-owner diversity cap (`MAX_RECOMMENDATIONS_PER_OWNER`) with a single
 * relaxation pass. Version 1 is the FIRST version ever served, so the cap is part
 * of it — not a bump from an uncapped predecessor (no recommendation has been
 * served without the cap).
 */
export const DISCOVERY_RANKING_VERSION = 1 as const;

/**
 * Maximum recommendations a single owner may contribute to one page. The cap is
 * per-OWNER (entity dedup is handled separately): a multi-owner entity counts
 * against EVERY active owner and is admitted only if all its owners are under the
 * cap. Ownerless candidates (empty `ownerIds`) are exempt. See SCORING-CODEBOOK.md
 * "Discovery Recommendation Signals".
 */
export const MAX_RECOMMENDATIONS_PER_OWNER = 2;

/**
 * A merged recommendation candidate carried through the diversity-cap merge.
 * `ownerIds` are the candidate's ACTIVE owners (same tenant), surfaced by each
 * signal query so the merge can enforce the per-owner cap without an extra query.
 */
interface RecommendationCandidate {
  entityId: string;
  name: string;
  entityType: string;
  score: number;
  reason: string;
  ownerIds: string[];
}

/**
 * Pure merge for the recommendation signals (no I/O — business logic isolated for
 * verification). Three bounded steps, no loop on external state:
 *
 *  1. Dedup by entity, keeping the highest-scoring entry per entity (preserves the
 *     pre-cap semantics the tests pin).
 *  2. Capped round-robin fill across the signal sources IN ORDER (shared → breed →
 *     nearby), each source pre-sorted by score desc. A candidate is admitted iff
 *     every owner in `ownerIds` is below `MAX_RECOMMENDATIONS_PER_OWNER`; on admit
 *     all its owners' counts increment. Ownerless candidates are always admissible.
 *     One full cycle over all candidates.
 *  3. Relaxation: if still under `limit` after the capped pass, admit the remaining
 *     skipped candidates by GLOBAL score desc, ignoring the cap (fill beats starve).
 *
 * Hard bound: exactly two passes (capped, then relaxation). The dedup map and the
 * cap-count map are the only mutable state; neither can grow unbounded.
 *
 * @param signals per-source candidate arrays in fill order: [shared, breed, nearby]
 * @param limit   maximum page size
 */
export function mergeRecommendations(
  signals: RecommendationCandidate[][],
  limit: number,
): RecommendationCandidate[] {
  if (limit <= 0) return [];

  // Step 1: dedup by entity, keeping the highest score. Track which source the
  // surviving candidate came from so the round-robin order is stable.
  const winnerByEntity = new Map<string, { candidate: RecommendationCandidate; source: number }>();
  signals.forEach((source, sourceIndex) => {
    for (const candidate of source) {
      const existing = winnerByEntity.get(candidate.entityId);
      if (!existing || candidate.score > existing.candidate.score) {
        winnerByEntity.set(candidate.entityId, { candidate, source: sourceIndex });
      }
    }
  });

  // Re-bucket the de-duplicated winners back into their source lists, each sorted
  // by score desc, so the round-robin cycles shared → breed → nearby deterministically.
  const sourceCount = signals.length;
  const buckets: RecommendationCandidate[][] = Array.from({ length: sourceCount }, () => []);
  for (const { candidate, source } of winnerByEntity.values()) {
    buckets[source].push(candidate);
  }
  for (const bucket of buckets) bucket.sort((a, b) => b.score - a.score);

  const results: RecommendationCandidate[] = [];
  const ownerCounts = new Map<string, number>();
  const admitted = new Set<string>();
  const skipped: RecommendationCandidate[] = [];

  const ownersUnderCap = (c: RecommendationCandidate): boolean =>
    c.ownerIds.every((owner) => (ownerCounts.get(owner) ?? 0) < MAX_RECOMMENDATIONS_PER_OWNER);

  const admit = (c: RecommendationCandidate): void => {
    results.push(c);
    admitted.add(c.entityId);
    for (const owner of c.ownerIds) {
      ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    }
  };

  // Step 2: capped round-robin. One pointer per bucket; cycle through buckets in
  // order until every bucket is exhausted. The loop is bounded by the total
  // candidate count (each iteration advances exactly one pointer).
  const pointers = new Array(sourceCount).fill(0);
  const totalCandidates = buckets.reduce((n, b) => n + b.length, 0);
  let processed = 0;
  while (processed < totalCandidates && results.length < limit) {
    for (let s = 0; s < sourceCount && results.length < limit; s++) {
      const bucket = buckets[s];
      if (pointers[s] >= bucket.length) continue;
      const candidate = bucket[pointers[s]];
      pointers[s]++;
      processed++;
      if (ownersUnderCap(candidate)) {
        admit(candidate);
      } else {
        skipped.push(candidate);
      }
    }
  }

  // Step 3: single relaxation pass — admit remaining skipped candidates (the ones
  // a cap turned away, plus any never reached because the page filled) by global
  // score desc, cap ignored. No new state beyond the already-bounded `skipped`
  // list and the buckets' untouched tails.
  if (results.length < limit) {
    const remaining: RecommendationCandidate[] = [...skipped];
    for (let s = 0; s < sourceCount; s++) {
      for (let i = pointers[s]; i < buckets[s].length; i++) {
        remaining.push(buckets[s][i]);
      }
    }
    remaining.sort((a, b) => b.score - a.score);
    for (const candidate of remaining) {
      if (results.length >= limit) break;
      if (admitted.has(candidate.entityId)) continue;
      admit(candidate);
    }
  }

  return results;
}

interface DiscoveryRow {
  entity_id: string;
  name: string;
  entity_type: string | null;
  breed: string | null;
  hops: number | bigint;
}

interface FieldRow {
  entity_id: string;
  name: string;
  entity_type: string | null;
  breed: string | null;
  owner_ids: string[] | null;
}

export class DiscoveryOps {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly geoLookup?: EntityGeoLookup,
  ) {}

  /**
   * Discover entities through ≤2-hop UNDIRECTED entity-to-entity traversal.
   *
   * Starts from the user's owned entities, walks CONFIRMED typed edges (the fixed
   * label set), and returns entities the user does NOT already relate to and that
   * are discoverable. Recursive CTE bounded at the (server-clamped) hop count.
   *
   * SECURITY: hops are hard-capped at 2 regardless of input — a 3-hop traversal
   * can visit 100^3 nodes on a popular entity (graph DoS). The hop cap is a
   * numeric literal derived from clamped input; all other values are bound
   * parameters ($queryRawUnsafe with positional $n). Tenant-scoped on every table.
   */
  async discoverByGraph(
    userId: string,
    hops: number,
    filters?: DiscoveryFilters,
  ): Promise<DiscoveryResult[]> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return [];

    // Hard-cap at 2 regardless of caller input (DoS guard). 1 or 2 only.
    const maxHops: 1 | 2 = hops <= 1 ? 1 : 2;
    const limit = filters?.limit ?? 20;

    // Positional params. Order matters and is referenced by $n below.
    //   $1 userId   $2 tenant   $3 edgeTypes[]   $4 limit   then optional filters.
    const params: unknown[] = [userId, tenantId, TRAVERSAL_EDGE_TYPES as unknown as string[], limit];
    const filterClauses: string[] = [];
    if (filters?.entityType) {
      params.push(filters.entityType);
      filterClauses.push(`d.entity_type = $${params.length}`);
    }
    if (filters?.breed) {
      params.push(filters.breed);
      filterClauses.push(`d.metadata->>'breed' = $${params.length}`);
    }
    if (filters?.lifeStage) {
      params.push(filters.lifeStage);
      filterClauses.push(`d.life_stage = $${params.length}`);
    }
    const extraFilters = filterClauses.length > 0 ? `\n        AND ${filterClauses.join("\n        AND ")}` : "";

    // maxHops is a clamped numeric literal (1 or 2), never user string data.
    const sql = `
      WITH RECURSIVE my_entities AS (
        SELECT o.entity_id AS id
        FROM entity_ownerships o
        WHERE o.user_id = $1
          AND o.tenant_id = $2
          AND o.status = 'ACTIVE'
      ),
      reachable AS (
        -- hop 1: neighbours of the user's owned entities (undirected)
        SELECT
          CASE WHEN er.entity_id = m.id THEN er.related_entity_id ELSE er.entity_id END AS entity_id,
          1 AS hops
        FROM my_entities m
        JOIN entity_relationships er
          ON (er.entity_id = m.id OR er.related_entity_id = m.id)
        WHERE er.tenant_id = $2
          AND er.status = 'CONFIRMED'
          AND er.type = ANY($3)
        UNION ALL
        -- hop 2 (cap): neighbours of reachable, stop at maxHops
        SELECT
          CASE WHEN er.entity_id = r.entity_id THEN er.related_entity_id ELSE er.entity_id END,
          r.hops + 1
        FROM reachable r
        JOIN entity_relationships er
          ON (er.entity_id = r.entity_id OR er.related_entity_id = r.entity_id)
        WHERE r.hops < ${maxHops}
          AND er.tenant_id = $2
          AND er.status = 'CONFIRMED'
          AND er.type = ANY($3)
      )
      SELECT
        d.id          AS entity_id,
        d.name        AS name,
        d.entity_type AS entity_type,
        d.metadata->>'breed' AS breed,
        MIN(r.hops)   AS hops
      FROM reachable r
      JOIN entities d ON d.id = r.entity_id
      WHERE d.tenant_id = $2
        AND r.entity_id NOT IN (SELECT id FROM my_entities)
        AND COALESCE((d.metadata->>'discoverable')::boolean, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM relationships rel
          WHERE rel.user_id = $1
            AND rel.tenant_id = $2
            AND rel.target_id = d.id
        )${extraFilters}
      GROUP BY d.id, d.name, d.entity_type, d.metadata->>'breed'
      ORDER BY d.name ASC
      LIMIT $4
    `;

    const rows = await this.prisma.$queryRawUnsafe<DiscoveryRow[]>(sql, ...params);
    return rows.map((row) => {
      const discovery: DiscoveryResult = {
        entityId: row.entity_id,
        name: row.name,
        entityType: row.entity_type ?? "",
        hops: Number(row.hops),
      };
      if (row.breed) discovery.breed = row.breed;
      return discovery;
    });
  }

  /**
   * Discover entities by geographic proximity.
   *
   * Proximity + ranking come from Postgres/PostGIS (`this.geoLookup`); this method
   * supplies entity fields and filters to discoverable entities the user does NOT
   * already relate to.
   *
   * SECURITY: only a coarse distance band is returned (never exact distance) to
   * prevent location triangulation (Finding 15). Already-related entities are
   * excluded, so exact distance is never needed here.
   */
  async discoverNearby(
    userId: string,
    lat: number,
    lng: number,
    radiusMeters: number,
    filters?: NearbyFilters,
  ): Promise<DiscoveryResult[]> {
    if (!this.geoLookup) return [];
    const tenantId = getCurrentTenantId();
    if (!tenantId) return [];

    const limit = filters?.limit ?? 20;

    // Over-fetch so the field/already-related/discoverable filtering still leaves
    // up to `limit` results. Distance order is preserved from PostGIS.
    const candidates = await this.geoLookup.findNearby(
      tenantId,
      lat,
      lng,
      radiusMeters,
      Math.min(limit * 4, 200),
    );
    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.entityId);

    const fieldsById = await this.fetchDiscoverableFields(userId, tenantId, ids, {
      entityType: filters?.entityType,
      breed: filters?.breed,
    });

    // Preserve PostGIS distance ordering; drop graph-filtered candidates; expose
    // only a coarse band (never exact distance for unrelated entities).
    const out: DiscoveryResult[] = [];
    for (const c of candidates) {
      const f = fieldsById.get(c.entityId);
      if (!f) continue;
      const discovery: DiscoveryResult = {
        entityId: c.entityId,
        name: f.name,
        entityType: f.entityType,
        distanceBand: toDistanceBand(c.distanceMeters),
      };
      if (f.breed) discovery.breed = f.breed;
      out.push(discovery);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Entity recommendations merging four signals: shared-connections (≤2-hop
   * traversal), same-breed, nearby, and owner-proximity. Dedup by entity, keeping
   * the highest-scoring reason, then a per-owner DIVERSITY CAP
   * (`MAX_RECOMMENDATIONS_PER_OWNER`) applied via round-robin fill with a single
   * relaxation pass (see `mergeRecommendations`). The cap is part of
   * `DISCOVERY_RANKING_VERSION` 1 — see SCORING-CODEBOOK.md.
   *
   * SECURITY: owner_proximity is never surfaced as a client-facing reason — it is
   * folded into the shared-connections signal and always mapped to
   * "shared_connections" (exposing it would leak graph topology). See the
   * RecommendationReason doc comment.
   */
  async getRecommendations(userId: string, limit: number): Promise<Recommendation[]> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return [];

    const [sharedRows, breedRows, nearbyRows] = await Promise.all([
      this.computeSharedConnections(userId, tenantId, limit),
      this.computeSameBreed(userId, tenantId, limit),
      this.computeNearbyRecommendations(userId, tenantId, limit),
    ]);

    // Merge with dedup-by-entity-keep-highest, then a per-owner diversity cap with
    // round-robin fill (shared → breed → nearby) and a single relaxation pass.
    // The merge is a pure function so the cap/fill logic is verified in isolation.
    const merged = mergeRecommendations([sharedRows, breedRows, nearbyRows], limit);

    return merged.map((c) => ({
      entityId: c.entityId,
      name: c.name,
      entityType: c.entityType,
      // owner_proximity is mapped to shared_connections client-side (security).
      reason: (c.reason === "owner_proximity" ? "shared_connections" : c.reason) as RecommendationReason,
      confidence: Math.min(1.0, Math.max(0.0, c.score)),
    }));
  }

  // -------------------------------------------------------------------------
  // Recommendation signals
  // -------------------------------------------------------------------------

  /**
   * Shared-connections signal: ≤2-hop undirected traversal anchored from the
   * user's OWNED and RELATED entities, counting distinct source entities per
   * candidate. score = sharedCount / 10. Excludes entities the user already
   * owns or relates to, and non-discoverable ones.
   *
   * The traversal depth is FIXED at 2, so instead of a recursive CTE (which,
   * lacking a visited set, materialized O(seeds × hub-degree) duplicate path
   * rows and only deduped at the final aggregate) the two levels are explicit:
   * hop1 (seed → neighbour, DISTINCT pairs), frontier (DISTINCT hop-1 nodes,
   * expanded ONCE each), and hop2 (hop1 ⋈ expansion — a hash join instead of a
   * per-path re-walk). The UNION between levels dedupes (seed, entity) pairs
   * exactly like the old COUNT(DISTINCT) did, so the aggregate is unchanged.
   *
   * Seed-adjacent-seed graphs are handled exactly: a hop-1 neighbour that is
   * itself a seed still expands (its neighbours ARE 2 hops from the anchoring
   * seed); only the final candidate list excludes seeds — same as before.
   * Mid-traversal seed pruning was evaluated and rejected: it changes
   * COUNT(DISTINCT seed_id) whenever two seeds are adjacent.
   *
   * Bounds: seeds capped at SHARED_CONNECTIONS_SEED_CAP, per-node fan-out at
   * SHARED_CONNECTIONS_DEGREE_CAP (both deterministic, ordered by id). Below
   * the caps results are row-for-row identical to the recursive version.
   *
   * (`er.type` is a plain text column since the 0.16.0 schema end-state pass —
   * the old `::text` cast was an enum-era artifact and is dropped here.)
   */
  private async computeSharedConnections(
    userId: string,
    tenantId: string,
    limit: number,
  ): Promise<RecommendationCandidate[]> {
    const params: unknown[] = [userId, tenantId, TRAVERSAL_EDGE_TYPES as unknown as string[], limit];
    // SEED/DEGREE caps are compile-time integers (never user input) — safe to
    // inline as numeric literals, same pattern as the maxHops literal above.
    const seedCap = SHARED_CONNECTIONS_SEED_CAP;
    const degreeCap = SHARED_CONNECTIONS_DEGREE_CAP;
    const sql = `
      WITH seed AS (
        -- the user's owned entities (OWNS) plus entities they relate to
        -- (RELATES_TO), capped deterministically
        SELECT id FROM (
          SELECT o.entity_id AS id
          FROM entity_ownerships o
          WHERE o.user_id = $1 AND o.tenant_id = $2 AND o.status = 'ACTIVE'
          UNION
          SELECT rel.target_id AS id
          FROM relationships rel
          WHERE rel.user_id = $1 AND rel.tenant_id = $2 AND rel.target_type = 'entity'
        ) s
        ORDER BY id
        LIMIT ${seedCap}
      ),
      hop1 AS (
        -- level 1: distinct (seed, neighbour) pairs; per-seed fan-out capped
        SELECT DISTINCT s.id AS seed_id, n.nb AS entity_id
        FROM seed s
        CROSS JOIN LATERAL (
          SELECT er.related_entity_id AS nb
          FROM entity_relationships er
          WHERE er.entity_id = s.id AND er.tenant_id = $2
            AND er.status = 'CONFIRMED' AND er.type = ANY($3)
          UNION ALL
          SELECT er.entity_id AS nb
          FROM entity_relationships er
          WHERE er.related_entity_id = s.id AND er.tenant_id = $2
            AND er.status = 'CONFIRMED' AND er.type = ANY($3)
          ORDER BY nb
          LIMIT ${degreeCap}
        ) n
      ),
      frontier AS (SELECT DISTINCT entity_id FROM hop1),
      expanded AS (
        -- each distinct hop-1 node expands ONCE (not once per path)
        SELECT f.entity_id AS via, n.nb
        FROM frontier f
        CROSS JOIN LATERAL (
          SELECT er.related_entity_id AS nb
          FROM entity_relationships er
          WHERE er.entity_id = f.entity_id AND er.tenant_id = $2
            AND er.status = 'CONFIRMED' AND er.type = ANY($3)
          UNION ALL
          SELECT er.entity_id AS nb
          FROM entity_relationships er
          WHERE er.related_entity_id = f.entity_id AND er.tenant_id = $2
            AND er.status = 'CONFIRMED' AND er.type = ANY($3)
          ORDER BY nb
          LIMIT ${degreeCap}
        ) n
      ),
      reachable AS (
        SELECT seed_id, entity_id FROM hop1
        UNION
        -- level 2: seed attribution via hash join hop1 ⋈ expanded
        SELECT h.seed_id, e.nb AS entity_id
        FROM hop1 h
        JOIN expanded e ON e.via = h.entity_id
      )
      SELECT
        d.id          AS entity_id,
        d.name        AS name,
        d.entity_type AS entity_type,
        COUNT(DISTINCT r.seed_id)::float / 10.0 AS score,
        -- ACTIVE, tenant-scoped owners only (a multi-owner entity counts against
        -- every active owner under the per-owner diversity cap). LEFT JOIN so an
        -- ownerless entity yields NULL → coalesced to '{}' (exempt from the cap).
        COALESCE(ARRAY_AGG(DISTINCT own.user_id) FILTER (WHERE own.user_id IS NOT NULL), '{}') AS owner_ids
      FROM reachable r
      JOIN entities d ON d.id = r.entity_id
      LEFT JOIN entity_ownerships own
        ON own.entity_id = d.id AND own.tenant_id = $2 AND own.status = 'ACTIVE'
      WHERE d.tenant_id = $2
        AND r.entity_id NOT IN (SELECT id FROM seed)
        AND COALESCE((d.metadata->>'discoverable')::boolean, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM relationships rel
          WHERE rel.user_id = $1 AND rel.tenant_id = $2 AND rel.target_id = d.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM entity_ownerships o2
          WHERE o2.user_id = $1 AND o2.tenant_id = $2 AND o2.entity_id = d.id AND o2.status = 'ACTIVE'
        )
      GROUP BY d.id, d.name, d.entity_type
      ORDER BY score DESC, entity_id ASC
      LIMIT $4
    `;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ entity_id: string; name: string; entity_type: string | null; score: number; owner_ids: string[] | null }>
    >(sql, ...params);
    return rows.map((row) => ({
      entityId: row.entity_id,
      name: row.name,
      entityType: row.entity_type ?? "",
      score: Number(row.score),
      reason: "shared_connections",
      ownerIds: row.owner_ids ?? [],
    }));
  }

  /**
   * Same-breed signal: candidates whose breed matches any breed of the user's
   * owned entities. Fixed score 0.6. Excludes already-owned / already-related /
   * non-discoverable entities. Breed lives in `entities.metadata->>'breed'`.
   */
  private async computeSameBreed(
    userId: string,
    tenantId: string,
    limit: number,
  ): Promise<RecommendationCandidate[]> {
    const params: unknown[] = [userId, tenantId, limit];
    const sql = `
      WITH my_breeds AS (
        SELECT DISTINCT e.metadata->>'breed' AS breed
        FROM entity_ownerships o
        JOIN entities e ON e.id = o.entity_id
        WHERE o.user_id = $1 AND o.tenant_id = $2 AND o.status = 'ACTIVE'
          AND e.metadata->>'breed' IS NOT NULL
      )
      SELECT
        d.id          AS entity_id,
        d.name        AS name,
        d.entity_type AS entity_type,
        -- ACTIVE, tenant-scoped owners only (same filter as every other signal).
        COALESCE(ARRAY_AGG(DISTINCT own.user_id) FILTER (WHERE own.user_id IS NOT NULL), '{}') AS owner_ids
      FROM entities d
      LEFT JOIN entity_ownerships own
        ON own.entity_id = d.id AND own.tenant_id = $2 AND own.status = 'ACTIVE'
      WHERE d.tenant_id = $2
        AND d.metadata->>'breed' IN (SELECT breed FROM my_breeds)
        AND COALESCE((d.metadata->>'discoverable')::boolean, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM relationships rel
          WHERE rel.user_id = $1 AND rel.tenant_id = $2 AND rel.target_id = d.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM entity_ownerships o2
          WHERE o2.user_id = $1 AND o2.tenant_id = $2 AND o2.entity_id = d.id AND o2.status = 'ACTIVE'
        )
      GROUP BY d.id, d.name, d.entity_type
      LIMIT $3
    `;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ entity_id: string; name: string; entity_type: string | null; owner_ids: string[] | null }>
    >(sql, ...params);
    return rows.map((row) => ({
      entityId: row.entity_id,
      name: row.name,
      entityType: row.entity_type ?? "",
      score: 0.6,
      reason: "same_breed",
      ownerIds: row.owner_ids ?? [],
    }));
  }

  /**
   * Nearby signal: anchors are the user's owned entities; proximity + ranking come
   * from PostGIS (`findNearAnchors`). Candidates are filtered against graph facts
   * (not already related/owned, discoverable). score = (1 - minDist/10000) * 0.5,
   * nearest first. Empty when geo is unavailable or the user owns no located
   * entities.
   */
  private async computeNearbyRecommendations(
    userId: string,
    tenantId: string,
    limit: number,
  ): Promise<RecommendationCandidate[]> {
    if (!this.geoLookup) return [];

    const anchors = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT DISTINCT o.entity_id AS id
       FROM entity_ownerships o
       WHERE o.user_id = $1 AND o.tenant_id = $2 AND o.status = 'ACTIVE'`,
      userId,
      tenantId,
    );
    const anchorIds = anchors.map((a) => a.id);
    if (anchorIds.length === 0) return [];

    const candidates = await this.geoLookup.findNearAnchors(
      tenantId,
      anchorIds,
      NEARBY_RECO_RADIUS_METERS,
      Math.min(limit * 4, 200),
    );
    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.entityId);

    const fieldsById = await this.fetchDiscoverableFields(userId, tenantId, ids);

    const rows: RecommendationCandidate[] = [];
    for (const c of candidates) {
      const f = fieldsById.get(c.entityId);
      if (!f) continue;
      rows.push({
        entityId: c.entityId,
        name: f.name,
        entityType: f.entityType,
        score: (1.0 - c.distanceMeters / 10000.0) * 0.5,
        reason: "nearby",
        // ACTIVE, tenant-scoped owners surfaced by fetchDiscoverableFields (same
        // ownership filter as the SQL signals — no second source of truth).
        ownerIds: f.ownerIds,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Shared helper
  // -------------------------------------------------------------------------

  /**
   * Fetch name/entityType/breed for a PostGIS candidate set, restricted to
   * discoverable entities the user does NOT already relate to (and, by the
   * caller's convention, that pass optional entityType/breed equality filters).
   * The PostGIS candidate ids are the proximity-ranked set; this is the graph-fact
   * filter that the Neo4j path expressed as a `MATCH … WHERE id IN $ids …` query.
   */
  private async fetchDiscoverableFields(
    userId: string,
    tenantId: string,
    ids: string[],
    equality?: { entityType?: string; breed?: string },
  ): Promise<Map<string, { name: string; entityType: string; breed: string | null; ownerIds: string[] }>> {
    const out = new Map<string, { name: string; entityType: string; breed: string | null; ownerIds: string[] }>();
    if (ids.length === 0) return out;

    // $1 userId  $2 tenant  $3 ids[]  then optional equality filters.
    const params: unknown[] = [userId, tenantId, ids];
    const extra: string[] = [];
    if (equality?.entityType) {
      params.push(equality.entityType);
      extra.push(`d.entity_type = $${params.length}`);
    }
    if (equality?.breed) {
      params.push(equality.breed);
      extra.push(`d.metadata->>'breed' = $${params.length}`);
    }
    const extraFilters = extra.length > 0 ? `\n        AND ${extra.join("\n        AND ")}` : "";

    const sql = `
      SELECT
        d.id          AS entity_id,
        d.name        AS name,
        d.entity_type AS entity_type,
        d.metadata->>'breed' AS breed,
        -- ACTIVE, tenant-scoped owners only (same filter as the SQL signal queries;
        -- LEFT JOIN + FILTER so ownerless entities yield '{}', not a dropped row).
        COALESCE(ARRAY_AGG(DISTINCT own.user_id) FILTER (WHERE own.user_id IS NOT NULL), '{}') AS owner_ids
      FROM entities d
      LEFT JOIN entity_ownerships own
        ON own.entity_id = d.id AND own.tenant_id = $2 AND own.status = 'ACTIVE'
      WHERE d.id = ANY($3)
        AND d.tenant_id = $2
        AND COALESCE((d.metadata->>'discoverable')::boolean, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM relationships rel
          WHERE rel.user_id = $1 AND rel.tenant_id = $2 AND rel.target_id = d.id
        )${extraFilters}
      GROUP BY d.id, d.name, d.entity_type, d.metadata->>'breed'
    `;
    const rows = await this.prisma.$queryRawUnsafe<FieldRow[]>(sql, ...params);
    for (const row of rows) {
      out.set(row.entity_id, {
        name: row.name,
        entityType: row.entity_type ?? "",
        breed: row.breed,
        ownerIds: row.owner_ids ?? [],
      });
    }
    return out;
  }
}

/**
 * Convert an exact distance in metres to a coarse band string. Values match the
 * DiscoveryResult.distanceBand union exactly. Mirrors Neo4jGraphService.toDistanceBand.
 *
 * SECURITY: used by discoverNearby to prevent location triangulation.
 */
function toDistanceBand(meters: number): NonNullable<DiscoveryResult["distanceBand"]> {
  if (meters < 500) return "< 500m";
  if (meters < 1000) return "500m-1km";
  if (meters < 2000) return "1-2km";
  if (meters < 5000) return "2-5km";
  return "> 5km";
}
