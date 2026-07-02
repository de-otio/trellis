/**
 * Directory search — query builder + executor.
 *
 * Public, opt-in tenant directory search across THREE independent filter axes
 * (name / category / location), spanning all tenants (this is a cross-tenant
 * discovery surface, not a tenant-scoped resource — there is deliberately no
 * `getCurrentTenantId()` scoping here). Matches the raw-SQL + PostGIS idiom of
 * `graph/postgres/discovery.ts` and `geo/entity-geo-repository.ts` rather than
 * inventing a new one.
 *
 * SECURITY — the load-bearing invariants (security review S3/S10/S18):
 *
 *  - **S3 (location triangulation).** `CITY`/`HIDDEN` rows are *structurally
 *    excluded from the distance-sorted / radius query path itself*, not merely
 *    stripped from the response. Coarsening a response payload doesn't stop the
 *    response *ordering* from leaking the true coordinate: a `CITY` row's rank
 *    in a distance-sorted result set is a binary distance oracle an attacker can
 *    triangulate against. The fix is in the query shape — the radius branch adds
 *    `location_precision IN ('EXACT','NEIGHBORHOOD')` to the same `WHERE` that
 *    computes `ST_DWithin`, so no distance is ever computed for a `CITY`/`HIDDEN`
 *    row. Those rows remain reachable by name/category search or an explicit
 *    `locationLabel` equality match (a coarse quantized filter, not a distance
 *    computation).
 *  - **S10 (enumeration/DoS).** Minimum trigram query length is enforced before
 *    the query reaches Postgres; a `statement_timeout` backstops an expensive
 *    plan; per-user rate limiting is applied at the route.
 *  - **S18 (bulk scrape).** No "list everything" shape — at least one real filter
 *    is required — and page size + page depth are bounded via runtime config.
 *
 * Response shaping is per-precision (never expose more than the tenant opted
 * into): `EXACT` → true `lat`/`lng`; `NEIGHBORHOOD` → fuzzed `displayLat`/
 * `displayLng` + `locationLabel`; `CITY` → `locationLabel` only; `HIDDEN` →
 * neither. Exact distance is never surfaced (it would re-open the triangulation
 * channel for `NEIGHBORHOOD` rows); ordering-by-distance is preserved.
 */

import type { PrismaClient } from "@prisma/client";
import { resolveDescendantCategoryIds, type CategoryNode } from "../org-category/tree.js";
import type { DirectorySearchConfig } from "../org-category/directory-search-config.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Raw (string) query inputs, as pulled from `URLSearchParams`. */
export interface RawDirectorySearchInput {
  name?: string | null;
  categoryId?: string | null;
  categoryCode?: string | null;
  lat?: string | null;
  lng?: string | null;
  radius?: string | null;
  locationLabel?: string | null;
  page?: string | null;
  pageSize?: string | null;
}

/** A validated location-radius filter (all three fields present + in range). */
export interface LocationRadius {
  lat: number;
  lng: number;
  radiusMeters: number;
}

/** Normalized, validated, clamped search parameters ready for the query builder. */
export interface NormalizedSearchParams {
  name?: string;
  categoryId?: string;
  categoryCode?: string;
  location?: LocationRadius;
  locationLabel?: string;
  page: number; // 0-indexed, clamped to [0, maxPageDepth - 1]
  pageSize: number; // clamped to [1, maxPageSize]
  offset: number;
  limit: number;
}

export type ValidationResult =
  | { ok: true; params: NormalizedSearchParams }
  | { ok: false; error: string; message: string };

/** One directory search result, shaped per the row's `locationPrecision`. */
export interface DirectorySearchResult {
  tenantId: string;
  slug: string;
  displayName: string;
  shortDescription?: string;
  locationPrecision: string;
  locationLabel?: string;
  /** Present only at EXACT precision. */
  lat?: number;
  lng?: number;
  /** Present only at NEIGHBORHOOD precision. */
  displayLat?: number;
  displayLng?: number;
}

// ─── Validation / normalization (pure) ───────────────────────────────────────

function parseIntOr(raw: string | null | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * Validate + normalize raw query inputs into `NormalizedSearchParams`.
 *
 * Pure (no I/O) so the abuse-limit and no-empty-filter rules are unit-testable
 * in isolation. Enforces: min trigram query length (S10); lat/lng range; a
 * complete lat+lng+radius triple for a radius filter; at least one real filter
 * (S18); and clamps page/pageSize to the configured bounds.
 */
export function validateAndNormalize(
  raw: RawDirectorySearchInput,
  config: DirectorySearchConfig,
): ValidationResult {
  const name = (raw.name ?? "").trim();
  const categoryId = (raw.categoryId ?? "").trim();
  const categoryCode = (raw.categoryCode ?? "").trim();
  const locationLabel = (raw.locationLabel ?? "").trim();

  // --- name: enforce minimum trigram length before it reaches Postgres (S10) ---
  let normalizedName: string | undefined;
  if (name.length > 0) {
    if (name.length < config.minQueryLength) {
      return {
        ok: false,
        error: "QUERY_TOO_SHORT",
        message: `Name query must be at least ${config.minQueryLength} characters`,
      };
    }
    normalizedName = name;
  }

  // --- location radius: needs a complete lat+lng+radius triple, all in range ---
  let location: LocationRadius | undefined;
  const hasAnyLocationField =
    (raw.lat ?? "").trim().length > 0 ||
    (raw.lng ?? "").trim().length > 0 ||
    (raw.radius ?? "").trim().length > 0;
  if (hasAnyLocationField) {
    const lat = Number.parseFloat((raw.lat ?? "").trim());
    const lng = Number.parseFloat((raw.lng ?? "").trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: "INVALID_LOCATION", message: "lat and lng must both be valid numbers" };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return {
        ok: false,
        error: "INVALID_LOCATION",
        message: "lat must be -90..90 and lng must be -180..180",
      };
    }
    // Radius defaults to the configured maximum when omitted; always clamped to
    // a bounded window so a caller can't request an unbounded-radius scan.
    const requestedRadius = parseIntOr(raw.radius, config.maxRadiusMeters);
    const radiusMeters = clampInt(requestedRadius, 1, config.maxRadiusMeters);
    location = { lat, lng, radiusMeters };
  }

  // --- S18: no "list everything" — at least one real filter must be present ---
  const hasFilter =
    normalizedName !== undefined ||
    categoryId.length > 0 ||
    categoryCode.length > 0 ||
    location !== undefined ||
    locationLabel.length > 0;
  if (!hasFilter) {
    return {
      ok: false,
      error: "EMPTY_FILTER",
      message: "At least one of name, category, or location must be provided",
    };
  }

  // --- bounded pagination (S18) ---
  const pageSize = clampInt(parseIntOr(raw.pageSize, config.maxPageSize), 1, config.maxPageSize);
  const page = clampInt(parseIntOr(raw.page, 0), 0, config.maxPageDepth - 1);

  return {
    ok: true,
    params: {
      name: normalizedName,
      categoryId: categoryId.length > 0 ? categoryId : undefined,
      categoryCode: categoryCode.length > 0 ? categoryCode : undefined,
      location,
      locationLabel: locationLabel.length > 0 ? locationLabel : undefined,
      page,
      pageSize,
      offset: page * pageSize,
      limit: pageSize,
    },
  };
}

// ─── Query builder (pure) ────────────────────────────────────────────────────

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the directory-search SQL + positional params. Pure and DB-free so the
 * S3 structural-exclusion invariant is testable without a live Postgres: when a
 * radius filter is present the generated `WHERE` restricts to
 * `location_precision IN ('EXACT','NEIGHBORHOOD')` *in the same clause* that
 * computes `ST_DWithin`, guaranteeing no `CITY`/`HIDDEN` row participates in the
 * distance path.
 *
 * @param categoryIds concrete descendant id set for a category filter, or null
 *                    when no category filter is active. An empty array is a
 *                    valid "category requested but resolved to nothing" state
 *                    and yields zero rows (`= ANY('{}')`).
 */
export function buildDirectorySearchQuery(
  params: NormalizedSearchParams,
  categoryIds: string[] | null,
  _config: DirectorySearchConfig,
): BuiltQuery {
  const bound: unknown[] = [];
  const where: string[] = ["tdp.is_discoverable = true", "t.status = 'ACTIVE'"];
  let joinClassification = false;
  let orderBy = "t.display_name ASC";

  let nameParam: string | undefined;
  if (params.name !== undefined) {
    bound.push(params.name);
    nameParam = `$${bound.length}`;
    // `%` uses the pg_trgm similarity operator (GIN-indexed) on either field.
    where.push(`(t.display_name % ${nameParam} OR COALESCE(tdp.short_description, '') % ${nameParam})`);
  }

  if (categoryIds !== null) {
    joinClassification = true;
    bound.push(categoryIds);
    where.push(`tc.category_id = ANY($${bound.length})`);
  }

  if (params.locationLabel !== undefined) {
    // Coarse, quantized equality — the CITY-reachable path. Never a distance
    // computation, so it cannot feed the triangulation channel.
    bound.push(params.locationLabel);
    where.push(`tdp.location_label = $${bound.length}`);
  }

  if (params.location !== undefined) {
    bound.push(params.location.lng);
    const lngParam = `$${bound.length}`;
    bound.push(params.location.lat);
    const latParam = `$${bound.length}`;
    bound.push(params.location.radiusMeters);
    const radiusParam = `$${bound.length}`;

    const profilePoint = `ST_SetSRID(ST_MakePoint(tdp.lng, tdp.lat), 4326)::geography`;
    const queryPoint = `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

    // ── S3 STRUCTURAL FIX ──────────────────────────────────────────────────
    // CITY/HIDDEN are excluded from the distance path in the SAME WHERE that
    // computes ST_DWithin — no distance is ever computed for them, so neither
    // radius membership nor sort order can leak their true coordinate.
    where.push(`tdp.location_precision IN ('EXACT', 'NEIGHBORHOOD')`);
    where.push(`tdp.lat IS NOT NULL AND tdp.lng IS NOT NULL`);
    where.push(`ST_DWithin(${profilePoint}, ${queryPoint}, ${radiusParam})`);

    // Distance sort (nearest first) — only EXACT/NEIGHBORHOOD rows are in scope.
    orderBy = `${profilePoint} <-> ${queryPoint} ASC`;
  } else if (nameParam !== undefined) {
    // No radius: rank by trigram relevance across both searchable fields.
    orderBy = `GREATEST(similarity(t.display_name, ${nameParam}), similarity(COALESCE(tdp.short_description, ''), ${nameParam})) DESC`;
  }

  // Deterministic tiebreaker so pagination is stable across pages/requests.
  orderBy = `${orderBy}, t.id ASC`;

  // limit/offset are clamped integers derived from config bounds — safe to
  // inline as numeric literals (never user string data).
  const limit = Math.floor(params.limit);
  const offset = Math.floor(params.offset);

  const sql = `
    SELECT
      t.id                     AS tenant_id,
      t.slug                   AS slug,
      t.display_name           AS display_name,
      tdp.short_description    AS short_description,
      tdp.location_precision   AS location_precision,
      tdp.location_label       AS location_label,
      tdp.lat                  AS lat,
      tdp.lng                  AS lng,
      tdp."displayLat"         AS display_lat,
      tdp."displayLng"         AS display_lng
    FROM tenant_directory_profiles tdp
    JOIN tenants t ON t.id = tdp.tenant_id${
      joinClassification ? "\n    JOIN tenant_classifications tc ON tc.tenant_id = t.id" : ""
    }
    WHERE ${where.join("\n      AND ")}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { sql, params: bound };
}

// ─── Response shaping (pure) ─────────────────────────────────────────────────

interface DirectorySearchRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  short_description: string | null;
  location_precision: string;
  location_label: string | null;
  lat: number | null;
  lng: number | null;
  display_lat: number | null;
  display_lng: number | null;
}

/**
 * Shape a raw row into a response object, exposing only what the row's
 * `locationPrecision` permits — the response half of the location-privacy
 * contract (the query half is the S3 structural exclusion above):
 *   EXACT        → true lat/lng (+ label if set)
 *   NEIGHBORHOOD → displayLat/displayLng + label
 *   CITY         → label only
 *   HIDDEN       → neither pin nor label
 * Exact distance is deliberately never included.
 */
export function shapeRow(row: DirectorySearchRow): DirectorySearchResult {
  const result: DirectorySearchResult = {
    tenantId: row.tenant_id,
    slug: row.slug,
    displayName: row.display_name,
    locationPrecision: row.location_precision,
  };
  if (row.short_description !== null) result.shortDescription = row.short_description;

  switch (row.location_precision) {
    case "EXACT":
      if (row.lat !== null) result.lat = row.lat;
      if (row.lng !== null) result.lng = row.lng;
      if (row.location_label !== null) result.locationLabel = row.location_label;
      break;
    case "NEIGHBORHOOD":
      if (row.display_lat !== null) result.displayLat = row.display_lat;
      if (row.display_lng !== null) result.displayLng = row.display_lng;
      if (row.location_label !== null) result.locationLabel = row.location_label;
      break;
    case "CITY":
      if (row.location_label !== null) result.locationLabel = row.location_label;
      break;
    // HIDDEN (and any unknown value): expose no location fields at all.
    default:
      break;
  }
  return result;
}

// ─── Executor (I/O) ──────────────────────────────────────────────────────────

/**
 * Resolve a requested category (by id or code, at any depth) to its concrete
 * active-descendant id set. Returns `null` when no category filter is active,
 * or an id array (possibly empty) when one is — an empty array is a valid
 * "category requested but not found / nothing under it" state and yields zero
 * results downstream.
 */
async function resolveCategoryFilter(
  prisma: PrismaClient,
  params: NormalizedSearchParams,
): Promise<string[] | null> {
  if (params.categoryId === undefined && params.categoryCode === undefined) return null;

  const rows = await prisma.platformCategory.findMany({
    where: { isActive: true },
    select: { id: true, code: true, parentCategoryId: true },
  });
  const nodes: CategoryNode[] = rows;

  let startId: string | undefined = params.categoryId;
  if (startId === undefined && params.categoryCode !== undefined) {
    startId = nodes.find((n) => n.code === params.categoryCode)?.id;
  }
  if (startId === undefined) return []; // unknown/inactive category → no matches

  return resolveDescendantCategoryIds(startId, nodes);
}

/**
 * Execute a directory search: resolve the category filter, build the query, run
 * it under a Postgres `statement_timeout` (defense-in-depth against an
 * expensive plan, S10), and shape each row per its precision.
 *
 * `params` must already be validated/normalized via {@link validateAndNormalize}.
 */
export async function executeDirectorySearch(
  prisma: PrismaClient,
  params: NormalizedSearchParams,
  config: DirectorySearchConfig,
): Promise<DirectorySearchResult[]> {
  const categoryIds = await resolveCategoryFilter(prisma, params);
  const { sql, params: bound } = buildDirectorySearchQuery(params, categoryIds, config);

  // statementTimeoutMs is a clamped positive integer from config — safe to
  // inline. SET LOCAL only takes effect inside a transaction, so the timeout and
  // the search run in one interactive transaction.
  const timeoutMs = Math.floor(config.statementTimeoutMs);

  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return tx.$queryRawUnsafe<DirectorySearchRow[]>(sql, ...bound);
  });

  return rows.map(shapeRow);
}
