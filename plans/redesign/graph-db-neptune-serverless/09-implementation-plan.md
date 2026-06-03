# 09 — Implementation plan (parallelized)

The actionable conclusion of this folder: how to get trellis + its first
consumer onto Neptune Serverless, with the work parallelized where the
dependency graph allows.

## Givens that shape the plan

- **Greenfield — no data to migrate.** Migration path A in
  [`07`](07-data-migration.md) (Neo4j → Neptune bulk load) is **dropped
  entirely**. Only the greenfield data-model guidance in `07`/[`04`](04-opencypher-compatibility.md)
  applies.
- **First consumer = `skybber`, in development, not yet live.** The
  deploying repo is `skybber` (`~/repos/dot/skybber`); it owns the AWS env
  and the CDK. There is **no production cutover, soak, or rollback** — deploy
  straight to a skybber dev environment and iterate.
- **trellis is library-only.** It gets runtime changes only (driver factory,
  Cypher, schema init, reconnection). The CDK construct + `IGraphConnection`
  live in **skybber's** CDK — not a `saas-foundation` package yet (promote
  later: second consumer **and** `@aws-cdk/aws-neptune-alpha` stable).

The two heavy efforts — **standing up the cluster (skybber)** and
**auditing/fixing Cypher (trellis)** — have no dependency on each other and
run fully concurrently. That is the core parallelization win.

## Status (2026-06-02)

- **Phase 0:** DEC1 (IAM auth), DEC3 (no Lambda graph access → **C6 dropped**),
  DEC4 (construct lives in `skybber/infra/lib/constructs/`) settled. DEC2 locked
  via the geo work + audit.
- **Track A — A1 + A2 DONE and verified.** `graph-connection.ts`
  (`IGraphConnection`) and `neptune-serverless-connection.ts`
  (`NeptuneServerlessConnection`) written in skybber; `@aws-cdk/aws-neptune-alpha@2.251.0-alpha.0`
  added. **Repo-wide `tsc` clean; full infra suite 325/325 green** incl. a new
  6-case synth test. The synth test caught + fixed a real bug (cluster
  `vpcSubnets` defaulted to PRIVATE_WITH_EGRESS in an isolated VPC).
- **C1 — DONE and verified (trellis).** IAM-auth path added: `GraphAuthConfig`
  gains `{type:"iam",region}` (`types.ts`); `neptune-auth.ts` does the SigV4
  signing + a `bearer` `AuthTokenManager` that re-signs before the ~5-min
  expiry; `connect()` wires the manager + TLS for `bolt://`; `graph-factory.ts`
  adds the `GRAPH_DB_AUTH_MODE=iam` path (Bolt URI from `GRAPH_DB_URI`, creds
  from the task role — no SSM secret). **Repo-wide `tsc` clean; a new 6-case
  unit test exercises the real SigV4 signing and passes.** Not verifiable
  without a cluster: the live TLS handshake + Neptune's signature verification +
  token refresh (→ Track D).
- **D1 — DONE and verified (trellis).** Static openCypher linter
  (`apps/api/test/lint/neptune-opencypher-lint.ts` + 10 fixture tests, green).
  Run over `src/lib/graph` it **reproduces the audit's findings exactly** (45
  error-level: constraint 3, index 5, show 2, foreach 3, limit-expr 9, call 1,
  exists 8, spatial 13, reduce 1) — independently confirming the audit's
  completeness. Doubles as the migration tracker: counts → 0 as C2/C3/C7 land,
  then flip on the strict CI gate.
- **A4 — DONE and verified (skybber).** `DataStack` instantiates the construct
  (explicit isolated subnets as RDS uses, Bolt ingress from the Fargate SG,
  config-driven RETAIN/DESTROY) and publishes `neptune-cluster-resource-id`;
  the construct publishes `neptune-bolt-uri`. `ApiStack` swaps the graph env to
  `GRAPH_DB_AUTH_MODE=iam` + `GRAPH_DB_URI` (dropping the AuraDB creds param),
  adds a `neptune-db:*` task-role policy scoped to the cluster ARN, and retags
  the graph alarms. `bin/app.ts` updated (Neptune is in-CDK now). **Repo-wide
  `tsc` clean; full infra suite 333/333** (+8 new Neptune assertions). Also
  fixed a test fixture so Neptune's ≥2-subnet requirement is met.
- **A3 + GraphStack split — DONE (deployed 2026-06-02).** Cheap dev Neptune
  live in the dot-dev account / eu-central-1, in its **own `Skybber-dev-Graph`
  stack** (split out of DataStack for an independent, disposable lifecycle):
  engine **1.3.2.1**, serverless **1.0–2.5 NCU**, single writer, IAM auth,
  deletion-protection off, ≈ $10/mo. Bolt URI + cluster-resource-id published
  to SSM; DataStack holds no Neptune; **ApiStack unchanged by the move**
  (SSM-decoupled — proves the pattern). Deploy-time-only lessons (synth/diff
  can't catch): engine `1.3.2.0` isn't deployable → `1.3.2.1`; cluster-param-group
  family must match the engine line → `neptune1.3`. Early failures rolled back
  without touching RDS/DynamoDB. Infra suite 335/335.
- **Not deployed: `Skybber-dev-Api`.** Its env-swap (`GRAPH_DB_AUTH_MODE=iam`)
  would point the *running* API at Neptune before trellis ships C1 + the
  openCypher rewrites — cut over only after a new trellis image is built.
- **C2c (FOREACH) — DONE and verified (trellis).** The 3 `FOREACH`
  conditional-writes in `addRelationship`/`removeRelationship` → `CASE`-in-`SET`
  + bare `DELETE` (null-no-op; no FOREACH/subquery). Verified against **Docker
  Neo4j: relationship-crud 35/35 green** (behavior preserved) and **linter
  no-foreach → 0**. Verification loop established: `NEO4J_TEST_DATABASE=neo4j
  NEO4J_TEST_ALLOW_DEFAULT_DB=1 … npm run test:graph`. (Neptune's own
  null-`SET`/`DELETE` behaviour is the residual to confirm against the cluster.)
- **C2d (LIMIT sweep) — DONE and verified (trellis).** 9 `LIMIT toInteger($x)`
  → `LIMIT $x`, with the limit params wrapped in `neo4j.int(...)` (the driver
  sends bare JS numbers as floats; Neptune/Neo4j `LIMIT` needs an integer).
  `toInteger($radiusInt)` in `syncPost` left as-is (a `SET` coercion, valid on
  Neptune). Verified: **graph integration 100/100** (relationship-crud +
  circle-resolution + discovery-scoring), tsc clean, linter
  no-expression-skiplimit → 0.
- **C2b (CALL/UNION feed) — DONE and verified (trellis).** `getVisiblePostIds`
  (cursor-paginated circle feed) rewritten from a `CALL{}`/UNION subquery to two
  separate branch queries (each ORDER BY createdAt,id + LIMIT limit+1) merged
  app-side — dedupe by postId (min tier), sort createdAt-then-postId DESC,
  paginate. Global top-k ⊆ union of per-branch top-k, so the merge is exact.
  Verified: **circle-resolution 40/40**, tsc clean, linter no-call-subquery → 0.
- **C2a (EXISTS) — DONE and verified (trellis).** All 8 `EXISTS { MATCH … }`
  → bare **pattern predicates** (`NOT (me)-[:RELATES_TO]->(candidate)`),
  supported on both Neo4j 5 and Neptune openCypher; preserves AND/OR structure.
  Verified: **full graph suite 7 files / 172 tests green** (C2a+b+c+d together),
  tsc clean, linter no-exists-subquery → 0.
- **All self-contained Cypher rewrites are DONE** (C2a/b/c/d). `neo4j-graph-service.ts`
  now has **zero** error-level linter findings (no-spatial + no-reduce cleared by
  C7, below).
- **C3 (schema-init → health check) — DONE and verified (trellis), 2026-06-03.**
  `graph-schema-init.ts` reduced to a connectivity probe (`RETURN 1`):
  `CREATE CONSTRAINT` ×3 / `CREATE INDEX` ×5 / `SHOW` ×2 all removed (F6/F7/F8),
  `initGraphSchema`/`verifyGraphSchema` signatures kept (verify returns `[]`).
  **DEC2 nuance:** business `id` stays a *regular* (Neptune-auto-indexed)
  property rather than rewriting ~80 MATCH/RETURN sites to Neptune's `~id`
  accessor — uniqueness is already guaranteed upstream (Postgres PKs minted
  there; the graph only MERGE-mirrors them, never mints an id) and `~id` is
  not settable on Docker Neo4j, so keeping `id` preserves engine parity for
  the local test loop with the same guarantee. Audit sized C3 at 0.25d, which
  matches this narrow scope (not a full `~id` query rewrite). **Verified:**
  repo-wide `tsc` clean; linter no-create-constraint/-index/-show → 0; the
  rewritten `schema-init.integration` (4 cases: probe succeeds, idempotent,
  verify reports nothing missing, **issues no DDL**) green against Docker Neo4j.
- **Graph layer is now at ZERO error-level lint findings** (C2a–d + C7 + C3).
  The D1 informational scan was **flipped to a strict gate** —
  `neptune-opencypher-lint.test.ts` now asserts `findings === []` over
  `src/lib/graph` and fails the build on any new incompatible Cypher. It runs
  under the default `npm test` (matches `test/**/*.test.ts`, not excluded), so
  **D1's CI gate (and D4) is satisfied** — no separate wiring needed.
- **C7 (geo → Postgres/PostGIS) — DONE and verified (trellis), 2026-06-02.**
  Dev Docker Postgres switched to `postgis/postgis:16-3.4`; `entity_location`
  table (`geography(Point,4326)` + GiST) + migration; `EntityGeoRepository`
  (`findNearby` / `findNearAnchors` / `upsert` / `remove`) injected into
  `Neo4jGraphService` via an `EntityGeoLookup` (graph tests inject a fake, prod
  wires the repo through the factory). `syncEntity` writes location to PostGIS at
  **full precision** (coarsening is now a read-time policy, not a write-time
  mutilation) and no longer stores `lat`/`lng` on the graph node; `discoverNearby`
  + the recommendations nearby-signal use the repo (a `MIN`-over-anchors query
  replaces `reduce()`/`point.distance()`) merged with graph facts (discoverable,
  exclude-already-related). **Verified:** linter no-spatial + no-reduce → 0;
  graph unit 326 + integration 174 + a new `entity-geo-repository.integration` 8
  (real PostGIS — `ST_DWithin` radius, `<->` KNN, MIN-over-anchors, tenant
  scoping, upsert/remove) green; tsc clean. Deploy prereq: `CREATE EXTENSION
  postgis` on the consuming RDS (as master) before the migration deploys. See
  [`../entity-location-subsystem.md`](../entity-location-subsystem.md).
- **C5 (errors.ts host-redaction) — DONE and verified (trellis), 2026-06-03.**
  `sanitize()` gains a `NEPTUNE_HOST` rule (`*.neptune.amazonaws.com[:port]` →
  `[neptune-host-redacted]`) so a Neptune cluster/reader endpoint can't leak via
  `Error.message` → logs / 5xx bodies (the Bolt-URI rule already covered the
  `bolt+s://…neptune…` scheme form). Aura + password rules kept. **Verified:**
  `errors-sanitize` 17/17 (3 new Neptune cases), tsc clean.
- **C4 (failover reconnection) — DONE and verified (trellis), 2026-06-03.**
  `executeQuery` (the central query chokepoint — all reads/writes route through
  it) now retries once on a Neptune writer failover: catches
  `ServiceUnavailable`/`SessionExpired` (`neo4j.error.*` codes), rebuilds the
  driver from a retained `config` (fresh pool + DNS to the promoted writer) via
  a **single-flight `reconnect()`** (concurrent in-flight queries share one
  rebuild, not a race), and retries on a new session. Non-transient (query)
  errors fail fast with no rebuild; a persistent outage surfaces as
  `GraphQueryError` → 5xx. Mirrors the factory's `closeSharedGraphService`
  drop-and-recreate but in-process, so an in-flight request recovers without
  bubbling a 5xx. **Verified:** new `reconnection.test.ts` 5/5 (retry-then-
  succeed, both transient codes, fail-fast on query error, at-most-once retry,
  single-flight under concurrency); full graph unit+lint 340 + integration lane
  173 green; tsc clean. *Live D3 (kill the real writer, assert reconnect) still
  pending the cluster.*
- **Not yet:** **C8** (datetime — settle via the against-cluster spike; pin
  engine ≥ 1.3.2.0 and verify, epoch-millis rewrite only if it fails). Then the
  converging live Track D — **D2** integration vs the real cluster and **D3**
  failover (need A3 + the runtime work, now all landed) — and the API cutover
  (`Skybber-dev-Api` env-swap after a new trellis image ships C1 + the
  rewrites). **C1/C4/C5 + D1/D4 are DONE**; the residual is C8 + the live
  cluster tests + cutover.

## Phase 0 — Decisions & kickoff (small, unblocks the tracks)

Do these first; each is fast and removes a fork from a downstream task.

| ID | Decision | Recommendation | Unblocks |
|---|---|---|---|
| DEC1 | IAM auth vs no-IAM + security group | **SETTLED → IAM** (no stored secret, CloudTrail-audited — [`05`](05-connection-protocol.md); all graph access is from the ECS task, so `grantConnect(taskRole)` is clean) | A2, C1 |
| DEC2 | Data-model conventions | Lock now (per audit [`10`](10-opencypher-audit.md)): string business `id` as Neptune `~id`; **no list properties**; uniqueness app-layer; **geo lives in Postgres as a PostGIS entity-location subsystem** ([`../entity-location-subsystem.md`](../entity-location-subsystem.md)) — precise storage + query-exposure privacy policy, not in the graph; timestamps keep `datetime()` on **engine ≥ 1.3.2.0** (epoch-millis only if a spike fails) | C3, C7, C8, all new Cypher |
| DEC3 | Is any graph access in a Lambda? | **SETTLED → no.** None of trellis's 20 lambda handlers import the graph layer; all graph access is from the ECS API task. **⇒ C6 dropped** | scopes/cancels C6 |
| DEC4 | Construct placement | skybber CDK app (confirmed) | A1 |

## Parallel tracks (all start after Phase 0)

```
Phase 0 ─┬─────────────────────────────────────────────────────────────┐
         │                                                               │
   TRACK A (skybber CDK)        TRACK B (trellis audit)                  │
   A1 IGraphConnection          B1 audit neo4j-graph-service.ts ┐        │
        │                       B2 audit graph-schema-init.ts   ├─► fix- │
   A2 NeptuneServerlessConn     B3 audit list-props / id()      ┘  list  │
        │  (DEC1)                        │                               │
   A3 deploy DEV cluster ◄──────────────┼───────────── (live test target)
        │                               ▼                               │
   A4 ECS task wiring          TRACK C (trellis runtime)                 │
        │                       C2 Cypher rewrites (needs B)             │
        │                       C3 schema-init rework (needs B2,DEC2)    │
        │                       C1 auth path (needs DEC1) ── audit-indep │
        │                       C4 failover reconnection ── audit-indep  │
        │                       C5 errors.ts host regex  ── audit-indep  │
        │                       C6 Lambda HTTPS (DEC3)    ── likely skip  │
         └──────────────┬──────────────┘                                 │
                        ▼                                                 │
              TRACK D (converge): D2 integration vs DEV cluster,          │
              D3 failover test   (need A3 + C1/C2/C3/C4)                  │
              D1 static openCypher lint ── audit-indep, build early ──────┘
```

### Track A — skybber CDK + live dev cluster *(independent of trellis Cypher)*

| Task | Depends on | Notes |
|---|---|---|
| **A1** `IGraphConnection` interface in skybber CDK | DEC4 | the swappable contract ([`05`](05-connection-protocol.md)) |
| **A2** `NeptuneServerlessConnection` construct | A1, DEC1 | per [`06`](06-cdk-construct.md): writer + **tier-0 reader** (HA), IAM auth, isolated subnets, audit logs, SSM bolt-URI param |
| **A3** Deploy **dev** Neptune cluster | A2 | the real test target for Track D — **get this up early**; there is no local Neptune emulator |
| **A4** ECS task wiring | A2 | `grantConnect(taskRole)`, inject bolt-URI SSM param into the task env |

Track A is internally sequential but needs nothing from trellis. Start day 0.

### Track B — openCypher audit *(independent; sizes Track C)*

| Task | Depends on | Notes |
|---|---|---|
| **B1** Audit `neo4j-graph-service.ts` (78 KB) | — | split by section across readers; flag every Neptune-incompatible statement. **Known: `FOREACH` ×3** (lines 223/255/259) |
| **B2** Audit `graph-schema-init.ts` | — | **Known: 3× `CREATE CONSTRAINT … IS UNIQUE`** (User/Entity/Post `.id`) — unsupported on Neptune |
| **B3** Audit list-property + `id()` assumptions across the graph layer | — | data-model + string-ID checks ([`04`](04-opencypher-compatibility.md)) |

B1–B3 run concurrently; consolidate into **one fix-list with a sizing
estimate**. This is the gate that turns "1–2 days?" into a real number.

### Track C — trellis runtime *(split: audit-independent fill vs audit-dependent core)*

| Task | Depends on | Can start |
|---|---|---|
| **C5** `errors.ts` host-redaction regex (Aura → `*.neptune.amazonaws.com`) | — | **✅ DONE 2026-06-03** (NEPTUNE_HOST rule; 17/17) |
| **C4** Failover reconnection wrapper (catch `ServiceUnavailable`/`SessionExpired`, reuse `closeSharedGraphService`) | — | **✅ DONE 2026-06-03** (in-`executeQuery` single-flight reconnect+retry; 5/5; live D3 pending cluster) |
| **C1** Auth path in `graph-factory.ts` (SigV4 token provider, or `AUTH_MODE`/`auth.none()`) | DEC1 | after Phase 0 |
| ~~C6~~ Lambda HTTPS path | — | **DROPPED** — DEC3 confirmed no Lambda graph access |
| **C2a** `EXISTS{}` → anti-join (8 sites) | **B** | after audit |
| **C2b** `CALL{}`/UNION feed query → app-side merge | **B** | after audit |
| **C2c** `FOREACH` conditional writes (3 sites) | **B** | after audit |
| **C2d** `LIMIT toInteger($x)` → `LIMIT $x` sweep (9 sites) | **B** | after audit (trivial) |
| **C3** Schema-init → connectivity check only (Neptune auto-indexes; no `CREATE CONSTRAINT/INDEX`/`SHOW`) | **B, DEC2** | **✅ DONE 2026-06-03** (verified; `id` kept as regular prop, not `~id` — see status) |
| **C7** Geo → Postgres entity-location subsystem ([`../entity-location-subsystem.md`](../entity-location-subsystem.md)): PostGIS `ST_DWithin`/`<->`, precise-store + exposure-policy; delete spatial Cypher; graph returns relationship signals only (merged app-side) | **B, DEC2** | **✅ DONE 2026-06-02** (verified; was the long pole) |
| **C8** datetime: pin engine ≥ 1.3.2.0 + **verify** on the cluster; epoch-millis rewrite only if the spike fails | **B, DEC2, A3** | small unless fallback |

C1/C4/C5 are "free" parallel fill — do them while Track A brings up the
cluster and Track B audits. **C2a–d are independent methods → parallelize.**
**C7 was the long pole** — now done (it was largely *Postgres-side* work; the
graph just stopped doing geo, so it parallelized against the trellis-Cypher
tasks). The remaining Track C work is **C3** (schema-init), **C8** (datetime —
small unless the spike fails), and the small **C4/C5**. The audit
([`10`](10-opencypher-audit.md)) originally put Track C at **~3–5 days**; with
C7 + C2a–d landed, the residual is C3 + C8 + C4/C5.

### Track D — testing *(static part independent; live part converges)*

| Task | Depends on | Notes |
|---|---|---|
| **D1** Static openCypher lint / CI guard | — | **✅ DONE** — strict `findings===[]` gate over `src/lib/graph`, runs under default `npm test` (= in CI) |
| **D2** Integration tests against the **dev Neptune cluster** | A3 + C1/C2/C3 | the real verification; replaces the Docker-only suite for graph code |
| **D3** Failover test (kill writer, assert reconnect) | A3 + C4 | validates the reconnection wrapper |
| **D4** Wire D1 into CI | D1 | **✅ DONE** — D1 lives in the default vitest suite, so CI already runs it; no extra job |

## Critical path

```
Phase 0 → max(  A1 → A2 → A3  ,  B → C2/C3  ) → D2 → done
                └ cluster bring-up ┘   └ audit + rewrite ┘
```

The two long poles run concurrently. Whichever is longer (cluster bring-up
vs audit+rewrite) sets the timeline; C1/C4/C5/D1 absorb the slack on the
trellis side. A4 + C1 must both land before D2 (the task can reach a cluster
*and* authenticate).

## Definition of done

- [ ] Dev Neptune Serverless cluster (writer + tier-0 reader) reachable from a skybber dev ECS task via IAM auth.
- [ ] `graph-factory.ts` connects with the chosen auth mode and survives a forced failover (D3 green).
- [ ] Zero `FOREACH`-in-write, zero `CREATE CONSTRAINT`, zero list-property, zero integer-`id()` assumptions remain (B fix-list fully closed).
- [x] `graph-schema-init.ts` provisions no DDL (connectivity probe only); uniqueness enforced via Postgres-origin business ids + MERGE-keyed upsert (kept `id` as a regular auto-indexed property rather than `~id` — see C3 status).
- [x] D1 openCypher lint runs in CI and is green (strict `findings===[]` gate over `src/lib/graph`, in the default suite).
- [ ] D2 integration suite passes against real Neptune (not Docker).
- [ ] Greenfield data-model conventions (DEC2) documented in the trellis graph layer so new Cypher stays compliant.

## Explicitly out of scope (greenfield)

- Data migration / bulk load ([`07`](07-data-migration.md) path A).
- Production cutover, soak window, rollback runbook (skybber isn't live).
- Promoting the construct to a `saas-foundation` package (deferred to second
  consumer + alpha-stable).

## Open questions

- **Local dev loop.** With prod/dev on Neptune and no local Neptune emulator,
  does local development keep using Docker Neo4j (fast loop, but full-Cypher —
  relies on D1 lint to catch divergence), or point at a shared dev Neptune?
  Leaning Docker-local + D1 lint as the guard. Confirm.
- **Audit sizing (B) is the one real unknown.** Everything downstream of
  Track C's core is estimated only after B closes. Treat the first
  deliverable as B's fix-list + estimate, then commit the rest of the schedule.
