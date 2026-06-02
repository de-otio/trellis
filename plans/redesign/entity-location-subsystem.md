# Entity-location subsystem (trellis core)

**Date:** 2026-06-01
**Status:** Design — not yet built.
**Trigger:** The Neptune Serverless migration ([`graph-db-neptune-serverless/`](graph-db-neptune-serverless/README.md))
removes spatial from the graph layer ([audit F1](graph-db-neptune-serverless/10-opencypher-audit.md));
geo-proximity must move to Postgres. Rather than a minimal port, this is the
design for a **generic, multi-vertical entity-location capability** in trellis
core — geo is a Postgres/PostGIS concern; the graph does relationships only.

## Scope & principles

- **Generic trellis core, not skybber-specific.** Keys on `entity` (any
  vertical's entity), tenant-scoped with RLS, no domain assumptions.
- **The graph never does geo.** Neptune has no spatial type. All proximity
  lives in Postgres (PostGIS). The graph contributes relationship facts only;
  results are merged app-side.
- **Precision is stored; exposure is policy.** (The central decision — see
  below.)

## Requirements

| Requirement | Source |
|---|---|
| Owner can **set** an entity's location (authoritative) | product |
| App **may suggest** a location to the owner (owner confirms) | product (future) |
| May **record location changes over time** (history) | product (potential future) |
| **True radius** search, **distance-ranked**, **dense-area scaling** | product |
| Flexible beyond skybber's needs | platform |

## The central decision: store precise, control exposure at query time

Today coordinates are **coarsened at write** to ~1 km (`types.ts:72`, security
Finding 15) and exact distances are withheld in `discoverNearby` — an
anti-triangulation control (prevent an attacker from binary-searching an
entity's exact location via repeated proximity queries).

Coarsening **at storage** is the wrong layer: it destroys the precision that
true distance-ranking requires. The chosen model separates the two concerns:

- **Store full precision** → enables `ST_DWithin` true radius and `<->` KNN
  distance ranking server-side.
- **Control exposure at the query/response boundary**, driven by the existing
  per-subject **`locationAnonymizationLevel`** (`schema.prisma:182`,
  alongside `locationVisible` / `locationTrackingEnabled`):
  - banded (not exact) distances in responses,
  - snap/quantize the *query* point to a grid,
  - k-anonymity (suppress results in sparse areas / below a min count),
  - min-radius floor, max-results cap, rate-limiting, optional jitter.

**Accepted tension (explicit):** true distance-ranked search inherently leaks
*some* relative-location signal, and repeated queries can triangulate. Storing
precise data does not create this risk — *exposing ranking* does. The privacy
control is therefore the **exposure policy**, tuned per vertical/feature via
`locationAnonymizationLevel`, not storage mutilation. This is the deliberate
trade-off the product accepts in exchange for true ranking.

## Data model (Postgres + PostGIS, trellis core)

PostGIS is enabled on the RDS/Aurora PostgreSQL instance (`CREATE EXTENSION
postgis;` via migration; confirmed supported on both engines). Two tables:

### `entity_location_history` — append-only

```
id               cuid / uuid   PK
tenant_id        text          (RLS; location is sensitive)
entity_id        text          FK -> entities
location         geography(Point,4326)
source           enum          'owner' | 'suggested' | 'derived'
accuracy_m       float?        optional reported accuracy
sensitivity      text          'benign' | 'sensitive' | 'decoy'  (mirrors post_geo_index)
recorded_at      timestamptz
```

This *is* the "location over time" feature — no extra work when that product
feature lands. Append a row per authoritative change.

### `entity_current_location` — one row per entity (the hot path)

```
entity_id        text          PK, FK -> entities
tenant_id        text          (RLS)
location         geography(Point,4326)   -- GiST indexed
source           enum
sensitivity      text
updated_at       timestamptz
```

Denormalized "latest authoritative point," what proximity queries hit. GiST
index on `location` → index-assisted `ST_DWithin` and `<->` KNN. (A bitemporal
single-table `valid_from/valid_to` design is the alternative; the
current+history split keeps the hot query simplest.)

Both tables mirror `post_geo_index`'s posture: own `tenant_id` for direct RLS
and a `sensitivity` classification (for Border-Safety-Mode selective wiping).

### Prisma ↔ PostGIS friction

Prisma has **no native `geography` type**. The column is declared
`Unsupported("geography(Point, 4326)")`, so Prisma Client **cannot
filter/order on it** — all spatial queries go through **`$queryRaw`** with
hand-written SQL against the GiST index. Non-spatial columns stay in the
normal Prisma model. This is the standard PostGIS-on-Prisma pattern; the geo
read path is raw SQL by necessity.

## Write paths

| Path | Behaviour |
|---|---|
| **Owner sets location** | Insert `entity_location_history` (`source='owner'`) + upsert `entity_current_location`. Full precision. |
| **App suggests** (future) | A suggestion is a candidate, not authoritative — surfaced to the owner; on confirm it becomes an `owner` write. Model later (a `source='suggested'` row that doesn't promote to current until confirmed, or a separate suggestions table). **Deferred.** |
| **Derived** (future) | e.g. inferred from posts (`post_geo_index`) or profile — `source='derived'`, lower trust. **Deferred.** |

The existing dual-write that currently coarsens and writes `entity.lat/lng`
**into the graph** is redirected to write **precise** coords into these
Postgres tables instead. The coarsening step is removed from the write path
(precision now lives in storage; exposure is handled at read).

## Read paths (proximity)

Raw-SQL PostGIS over `entity_current_location`, then merge with graph
relationship facts app-side:

- **`discoverNearby`** → `ST_DWithin(location, $p, $r)` + `ORDER BY location
  <-> $p LIMIT k`, RLS-scoped, filtered by `locationVisible`/discoverable;
  exclude entities the user already relates to (**graph** fact) → merge.
  Apply the exposure policy (banding, snapping, k-anon) before returning.
- **Recommendations "nearby" signal** → same `ST_DWithin`/`<->` to get nearby
  candidate IDs + true distance, then score alongside the graph signals
  (shared-connections, same-breed) app-side.

This removes the two `point.distance()` Cypher queries (and the `reduce()`
loop) from the graph entirely.

## Multi-vertical flexibility

- Keys on generic `entity_id`; no vertical-specific fields.
- Exposure policy is per-subject (`locationAnonymizationLevel`) — each vertical
  picks its posture; a high-privacy vertical can default to coarse bands or
  exclude entities from discovery, a low-sensitivity one can expose more.
- History is available but optional to consume.
- `source`/`sensitivity` give room for suggestion, derivation, and selective
  wiping without schema churn.

## Relationship to the Neptune decision

This *resolves* audit F1 and **preserves the Neptune choice intact** — geo was
never the graph's job (`Entity` model comment, `schema.prisma:47`:
"Relationships … live in the graph DB … not Prisma"). The graph keeps doing
relationships; Postgres owns geo, now as a first-class indexed subsystem.

## Sizing

~3–5 dev-days for the core (PostGIS enablement, the two tables + GiST + RLS,
write-path redirect, the two raw-SQL read paths + graph merge, the exposure
policy), excluding the deferred suggestion/derived features. Geo read path is
raw SQL (Prisma can't express PostGIS).

## Open questions

- **Source-of-truth wiring.** Owner-set is clear; where in the trellis API /
  skybber UI the owner sets it, and whether an entity may have multiple
  locations (home + current) or exactly one current point. Affects whether
  `entity_current_location` is 1:1 or needs a `kind` discriminator.
- **Exposure-policy parameters.** The concrete mapping from
  `locationAnonymizationLevel` values → (band size, snap grid, k-anon
  threshold, min radius, rate limit). Needs a small policy spec.
- **`current` table vs materialized view vs bitemporal single table.** Leaning
  denormalized `entity_current_location` for query simplicity; revisit if
  history-vs-current consistency becomes awkward.
- **Suggestion feature shape.** Deferred; note the `source` enum leaves room.
- **Accuracy/uncertainty.** Whether to store + expose `accuracy_m` and factor
  it into banding.
