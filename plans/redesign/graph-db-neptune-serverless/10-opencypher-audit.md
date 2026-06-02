# 10 — openCypher compatibility audit (Track B output)

The gating deliverable from [`09-implementation-plan.md`](09-implementation-plan.md).
Audits the trellis graph layer against Neptune's openCypher subset
([`04`](04-opencypher-compatibility.md)) and sizes the rewrite.

## Scope & method

- **Files:** `apps/api/src/lib/graph/neo4j-graph-service.ts` (~2150 lines, all
  queries) and `graph-schema-init.ts`. Other graph-layer files
  (`dual-write*.ts`, `reconciliation-service.ts`, `scoring-engine.ts`,
  `graph-service.ts`, `types.ts`) contain no raw Cypher (verified by grep).
- **Method:** file-wide grep for every known openCypher gap class from
  [`04`](04-opencypher-compatibility.md) plus discovered patterns, then
  detailed read of every flagged region. Counts below are file-wide.
- **Confidence:** high for the enumerated incompatibilities (grep-complete for
  those patterns + read in context). Not a line-by-line read of all 2150
  lines — the **D1 static openCypher lint** ([`09`](09-implementation-plan.md))
  remains the ongoing guard.

## Verdict

**This is the "existing codebase, audit-then-rewrite" case, not greenfield.**
The *data model* is Neptune-friendly (custom string `id` properties, no
multi-valued properties, no `shortestPath`, no APOC/GDS). The debt is in
*query features*: subqueries, spatial, conditional writes, temporal, and
schema DDL. One finding (spatial) is a genuine **capability gap requiring
redesign**, not translation.

**Revised sizing: ~3–5 focused dev-days** (down from a first pass of 4–7 after
AWS-doc validation, below), dominated by the spatial move-to-Postgres —
materially more than [`08`](08-verdict.md)'s "an afternoon" estimate (which
assumed greenfield).

## AWS-doc validation (2026-06-01)

Findings checked against the authoritative
[Neptune openCypher compliance page](https://docs.aws.amazon.com/neptune/latest/userguide/feature-opencypher-compliance.html)
and the [RDS/Aurora PostGIS guide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.PostGIS.html):

- **Confirmed unsupported:** `point()`/spatial + `reduce()` (absent from the
  function list → F1/F9); `CALL[YIELD]` and mutation-`UNION` (F4 — note
  *read-only* `UNION` **is** supported, so only the `CALL{}` wrapper is the
  problem); non-static `SKIP`/`LIMIT` — the page's own example is
  `LIMIT toInteger(rand())` "does NOT work" (F10).
- **F2 datetime — DOWNGRADED.** On Neptune **engine ≥ 1.3.2.0** (or labmode
  `DatetimeMillisecond=enabled`), `datetime()` over stored properties and
  parameters **is supported**, plus `epochmillis()` for conversion. The
  trellis pattern (`post.createdAt > datetime($since)` + cursor) most likely
  works as-is on a current engine → **verify on the cluster; epoch-millis is
  the fallback, not a mandate.** ⇒ **pin engine ≥ 1.3.2.0** (update
  [`06`](06-cdk-construct.md), which currently says ≥ 1.2.0.1).
- **V1 VLP — RESOLVED to supported.** Neptune only restricts VLP on
  *non-constant property equality filters*; the trellis VLP has no property
  predicate, so the multi-type `*1..2` traversal is fine.
- **Custom IDs blessed.** Neptune supports custom ID values in
  `MATCH`/`CREATE`/`MERGE` and `id()` returns a **string** → the `.id`
  property strategy maps directly to Neptune `~id` (strengthens F6).
- **PostGIS confirmed** on both RDS for PostgreSQL and Aurora PostgreSQL
  (extension version tables through PG 17) → the F1 geo→Postgres resolution is
  solidly supported (`ST_DWithin`/GiST available).

## Findings — must fix

| # | Feature | Neptune | Count | Locations | Effort |
|---|---|---|---|---|---|
| F1 | **`point()` / `point.distance()` spatial** + `CREATE POINT INDEX` + `e.location` point type | **No spatial type at all** | 2 queries + index | `1239–1246`, `1354–1360`; `graph-schema-init:50` | **High (redesign)** |
| F2 | **`datetime()`** temporal fn + comparisons | Supported on engine ≥ 1.3.2.0 (verify) | 12 | `514,528,536,645,656,687,709,733,1460,1941,1954,1959` | **Low–Medium (verify; epoch-millis fallback)** |
| F3 | **`EXISTS { subquery }`** (anti/semi-join) | Not supported | 8 | `686,1162,1308,1309,1329,1330,1348,1349` | Medium |
| F4 | **`CALL { subquery }`** (UNION + ORDER BY/LIMIT) | Not supported | 1 | `523–539` (circle feed) | Medium-High |
| F5 | **`FOREACH`** conditional write | Not supported | 3 | `223,255,259` | Medium |
| F6 | **`CREATE CONSTRAINT … IS UNIQUE`** | Not supported (only `~id`) | 3 | `graph-schema-init:20,25,29` | Low |
| F7 | **`CREATE INDEX` / `CREATE POINT INDEX`** | Auto-indexed; unsupported | 5 | `graph-schema-init:41,46,50,54,58` | Low |
| F8 | **`SHOW CONSTRAINTS` / `SHOW INDEXES`** | Not supported | 2 | `graph-schema-init:99,110` | Low |
| F9 | **`reduce()`** | Not supported | 1 | `1352` (inside F1 geo) | — (folds into F1) |
| F10 | **`LIMIT toInteger($limit)`** (`LIMIT <expr>`) | Static only | 9 | `369,542,647,658,1184,1257,1319,1337,1372` | Trivial |

## Findings — verify on a real Neptune cluster (uncertain)

| # | Feature | Why uncertain | Locations |
|---|---|---|---|
| ~~V1~~ | ~~Multi-type undirected VLP `[:A\|B\|C…*1..2]`~~ | **RESOLVED — supported.** Neptune only restricts VLP on *non-constant property predicates*; this VLP has none | `1307` |
| V2 | `MERGE … ON CREATE/ON MATCH` (×19) | Supported, but Neptune MERGE semantics on full patterns can differ; high volume so verify the upsert paths | throughout |
| V3 | `toString(datetime)` / `MIN(CASE …)` aggregation | Supported individually; verify once F2 changes land | `529,537,540` |

## Confirmed clean (no action)

- **Data model:** custom string `id` property used everywhere (`{id: $x}`),
  **not** internal `id()`/`elementId()` (grep: zero hits) → maps cleanly to
  Neptune `~id`. No multi-valued/list node properties (the list-looking grep
  hits are JS arrays in `reconciliation-service.ts`).
- **No `shortestPath`/`allShortestPaths`, no APOC, no GDS** — the worst
  doc/04 dealbreakers are absent.
- Supported and used freely: `MATCH`/`OPTIONAL MATCH`, `MERGE`, `WITH`,
  `collect(DISTINCT)`, `count`, `MIN`, `CASE`, `toFloat/toInteger/toString`,
  `IN`, `<>`, `IS NOT NULL` (as a **predicate** — distinct from the
  `IS UNIQUE` constraint in F6).
- JS `.filter()`/`.reduce()` (`1636,1641`) are array methods, not Cypher.

## Rewrite notes for the hard ones

### F1 — spatial → move geo out of the graph into Postgres (RESOLVED)

Two discovery queries (`discoverByProximity` ~`1239`, recommendations
"nearby" signal ~`1354`) compute `point.distance()` server-side, plus a
`POINT INDEX` on `e.location`. Neptune has **no point type and no spatial
functions** — none of this translates.

**Confirmed 2026-06-01: geo-proximity discovery is an important MVP feature**,
so this is not deferrable. But the resolution is *not* to reinvent spatial in
Neptune — it is to **serve geo from Postgres, where it already lives and
belongs**:

- The `Entity` model comment (`prisma/schema.prisma:47`) already states
  *"Relationships and follower counts live in the graph DB … not Prisma."*
  The graph's job is **relationships/circles**, not geo.
- Postgres already has a dedicated, indexed, tenant-isolated geo table —
  **`PostGeoIndex`** (`schema.prisma:70`): `geohash` + `lat`/`lng` with a
  `@@index([geohash])`, plus `gpsLatitude/gpsLongitude` + index elsewhere.
  The graph's `point.distance()` queries duplicate this.

**Resolution:** geo-proximity discovery runs in **Postgres** (extend the
existing geohash index pattern to entities, or add **PostGIS** for native
`ST_DWithin`/KNN + GiST indexing) and returns candidate entity IDs by
proximity; the **graph contributes relationship signals only**. The
recommendations "nearby" signal splits into a Postgres proximity query + a
graph signal query, **merged app-side** (the same app-side-merge shape F4
already needs). This removes F1 *and* F9 (`reduce()`) from the graph entirely.

Net effect: F1 stops being a Neptune redesign and becomes "delete the spatial
Cypher; serve proximity from Postgres." It is **more correct and more
scalable** than geohash-in-Neptune (Postgres has real spatial indexing) and
**preserves the Neptune decision intact** — the one apparent capability gap
dissolves because spatial was never the graph's responsibility.

**Resolved into a trellis-core subsystem (2026-06-01).** Requirements
confirmed: owner-set location, optional app suggestion, location history over
time, and **true radius + distance-ranked + dense-area scaling** → this is
**PostGIS** (`geography(Point,4326)` + GiST, `ST_DWithin`/`<->` KNN), not
geohash. Privacy moves from storage-coarsening to a **query-exposure policy**
(store precise, apply `locationAnonymizationLevel` at read). Full design —
data model, write/read paths, Prisma↔PostGIS friction, exposure policy — is in
[`../entity-location-subsystem.md`](../entity-location-subsystem.md). C7 in the
plan now points there; it is a generic trellis-core feature (~3–5 d), not a
graph-Cypher task.

### F2 — datetime: verify on engine ≥ 1.3.2.0, epoch-millis as fallback

12 `datetime()` uses parse ISO strings (`datetime($since)`) and compare
(`post.createdAt > datetime($since)`, cursor pagination at `514`). Per the AWS
validation above, **Neptune engine ≥ 1.3.2.0 supports `datetime()` over
properties and parameters plus comparisons**, so this pattern most likely runs
unchanged. Action:

1. **Pin engine ≥ 1.3.2.0** in the construct ([`06`](06-cdk-construct.md)).
2. **Spike** the cursor/feed queries against the dev cluster (Track A3) — a
   ~1-hour test (the open question below).
3. **Only if a gap appears:** fall back to storing timestamps as **epoch-millis
   integers** (compare numerically), or use `epochmillis()` for conversion.
   That fallback touches the dual-write path, cursor encode/decode, and ~6 read
   queries — but is likely unnecessary on a current engine.

### F3 — `EXISTS { MATCH … }` → anti-join

The repeated `NOT EXISTS { MATCH (me)-[:RELATES_TO]->(x) }` becomes:

```cypher
OPTIONAL MATCH (me)-[exclRel:RELATES_TO]->(candidate)
WITH candidate, exclRel
WHERE exclRel IS NULL
```

Mechanical, but each call site adds a `WITH` stage — careful with the
surrounding aggregation pipelines.

### F4 — `CALL { }` UNION feed query (`getVisiblePostIds`)

The `CALL {}` exists specifically so `ORDER BY createdAt DESC LIMIT` spans
the entity-branch ∪ user-branch (the comment at `517` documents the bug that
motivated it). Without subqueries, options:

1. Run the two branches as **two separate queries**, merge + sort + limit +
   paginate **app-side**. Most robust; moves cursor logic to TS.
2. Express as a single `MATCH` with an `OR` over the two patterns if the
   shapes can be unified (they nearly can — both end at `Post`).

Recommended: option 1 (explicit, testable; pre-launch volume is small).

### F5 — `FOREACH` conditional writes

`FOREACH (_ IN CASE WHEN cond THEN [1] ELSE [] END | SET/DELETE …)` is the
"conditional mutation" trick. Since the guarded node comes from an
`OPTIONAL MATCH`, in most cases a plain `SET rev.reciprocated = true` /
`DELETE r` is a **no-op when the node is null** — verify Neptune matches
Neo4j's null-noop semantics; if not, split into a second statement the
service runs only when the condition holds (app-side branch). Affects
`addRelationship` (`223`) and `removeRelationship` (`255,259`).

### F6–F8 — schema-init becomes (almost) a no-op

Neptune auto-indexes all properties and supports no `CREATE CONSTRAINT`,
no `CREATE INDEX`, no `SHOW`. `graph-schema-init.ts` should be reduced to a
**connectivity/health check** (e.g. `RETURN 1`); uniqueness moves to using
the business `id` as the Neptune `~id` (inherently unique) + app-layer checks
(DEC2). `verifyGraphSchema` either drops or switches to a no-op.

### F10 — `LIMIT toInteger($limit)` → `LIMIT $limit`

Pass the limit as an integer parameter from TS and drop the `toInteger()`
wrapper. Trivial sweep across 9 sites.

## Impact on the plan ([`09`](09-implementation-plan.md))

- **DEC2 (data-model conventions) should now explicitly include:**
  timestamps as **epoch-millis integers** (F2), **no point type → `geohash`
  bucket property** (F1), business `id` as Neptune `~id` (F6).
- **Track C2 (Cypher rewrites)** is bigger than first scoped — break into:
  C2a EXISTS→anti-join (F3), C2b CALL/UNION feed (F4), C2c FOREACH (F5),
  C2d LIMIT sweep (F10). These parallelize across the four (independent
  methods).
- **New sub-tasks:** **C7 spatial redesign** (F1+F9) and **C8 datetime
  migration** (F2) — both touch the data model and the dual-write path, so
  schedule them with DEC2 locked first; they are the long poles of Track C.
- **C3 (schema-init)** shrinks to "reduce to health check" (F6–F8).
- **D1 static lint** must flag: `point(`, `datetime(`, `EXISTS {`, `CALL {`,
  `FOREACH`, `CREATE CONSTRAINT`, `CREATE INDEX`, `SHOW `, `LIMIT toInteger`.

## Revised sizing

| Work | Estimate |
|---|---|
| C7 geo → Postgres (F1/F9): remove spatial Cypher; PostGIS/geohash proximity in Postgres + app-side merge. *Mostly Postgres-side, not trellis-Cypher.* | 1–2 d |
| C8 datetime (F2): pin engine ≥ 1.3.2.0 + **verify** (epoch-millis only if it fails) | 0.25 d (+1–1.5 d only if fallback needed) |
| C2a EXISTS→anti-join (F3, 8 sites) | 0.5–1 d |
| C2b CALL/UNION feed (F4) | 0.5 d |
| C2c FOREACH (F5, 3 sites) | 0.5 d |
| C3 schema-init → health check (F6–F8) | 0.25 d |
| C2d LIMIT sweep (F10, 9 sites) | <0.25 d |
| Re-test all against real Neptune (no local emulator) | folded into D2 |
| **Total** | **~3–5 dev-days** (4–7 only if the datetime fallback is needed) |

## Open questions

- **Geo feature priority — ANSWERED (2026-06-01): geo-proximity discovery is
  important.** Resolution (F1): it moves to **Postgres** (PostGIS/geohash),
  not the graph — so it does not become a Neptune redesign and does not
  threaten the Neptune decision. Remaining sub-question: scope the
  Postgres-side entity-geo table (`entity_geo_index` analogous to the existing
  `post_geo_index`, or PostGIS columns) against skybber's exact geo
  requirements (radius? ranking? density?).
- **datetime spike (the one real query-feature unknown).** Pin engine
  ≥ 1.3.2.0 and run the cursor/feed queries against the dev cluster (Track A3).
  AWS docs say `datetime()` over properties/params is supported there, so this
  most likely passes and C8 stays ~0.25 d; the epoch-millis fallback is the
  contingency.
