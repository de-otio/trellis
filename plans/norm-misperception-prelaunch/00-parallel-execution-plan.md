# Parallel execution plan — norm-misperception pre-launch changes

Implements [`analysis/algorithmic-norm-misperception/02-prelaunch-actions.md`](../../analysis/algorithmic-norm-misperception/02-prelaunch-actions.md)
(items 1–5), derived from Brady et al., *Nature* 2026
([10.1038/s41586-026-10536-1](https://doi.org/10.1038/s41586-026-10536-1)).

> **Scope discipline.** This lays the five cheap-now / expensive-later changes
> only. It does **not** build ranking-strategy dispatch, bridging scores,
> cohort/experiment services, or per-viewer impression logging (the last is
> *refused*, not deferred — data-minimization). It does **not** re-tune any
> scoring-engine weight. MVP behaviour changes in exactly one place: the
> ordering of `/api/discovery/recommendations` results becomes
> diversity-capped — acceptable pre-launch because no recommendation has ever
> been served.

## Relationship to existing plans (read first)

- [`plans/attention-mechanics-mvp/01-ranking-policy-boundary.md`](../attention-mechanics-mvp/01-ranking-policy-boundary.md)
  (S1) already designs the `RankingPolicy` module, the `RANKING_POLICIES`
  registry, and the tenant `policy Json?` column. **This plan does not
  duplicate any of it.** Item 4 here only adds the *diversity-constraint
  requirement* and the Brady citation to the invariant docs S1 will be built
  against; when S1 lands, its registry guard must also enforce clause (d)
  below.
- [`plans/research-foundations-mvp/00-parallel-execution-plan.md`](../research-foundations-mvp/00-parallel-execution-plan.md)
  already shipped `FEED_RANKING_VERSION`, `SCORING-CODEBOOK.md`, the `ux_*`
  toggle convention, and `feature_toggle.changed` audit events. This plan
  extends those artefacts to the discovery surface; it re-creates none of them.

## Decisions locked

- **#1 Cap key:** per-**owner** (not per-entity — dedup already handles
  entities). An entity counts against *every* active owner; multi-owner
  entities are admitted only if all owners are under the cap. Ownerless
  entities (if representable) are exempt. `MAX_RECOMMENDATIONS_PER_OWNER = 2`.
- **#1 Fill order:** round-robin across the signal sources
  (shared-connections → same-breed → nearby), each source pre-sorted by score
  descending, candidates skipped while any owner is at cap. If the page is
  underfilled after the capped pass, **one** second pass re-admits the
  highest-scoring skipped candidates ignoring the cap (fill beats starve;
  bounded passes per the infinite-loop-prevention rules — test the degenerate
  all-one-owner case).
- **#2 Version semantics:** `DISCOVERY_RANKING_VERSION = 1` **includes** the
  diversity cap — version 1 is the first version ever served, so the cap is
  part of it, not a bump from it. Items 1 and 2 therefore land together
  (same agent, same files).
- **#3 Counter shape:** DynamoDB atomic counters in the existing single table,
  keyed `discexposure:{yyyy-mm}:{entityId}` (monthly buckets so drift is
  time-resolved), incremented once per entity per served page,
  **fire-and-forget off the critical path with observable failure** (stderr +
  metric — mirror the `audit.emit.failure` pattern, never block or fail the
  response). **No viewer identity anywhere in the key or item.**
- **Execution:** three agents in isolated worktrees, disjoint file sets,
  merged on completion.

## Why three agents (file-ownership map)

| File | Items that touch it | Owner |
|------|--------------------|-------|
| `apps/api/src/lib/graph/postgres/discovery.ts` | 1, 2 | **Agent A** |
| `apps/api/src/lib/graph/SCORING-CODEBOOK.md` | 2, 5 | **Agent A** |
| `apps/api/test/unit/graph/postgres/discovery.test.ts` | 1 | **Agent A** |
| `apps/api/test/integration/graph/discovery-postgres.integration.test.ts` | 1 | **Agent A** |
| `apps/api/src/lib/discovery-exposure.ts` (new) | 3 | **Agent B** |
| `apps/api/src/lib/discovery-handler.ts` | 3 | **Agent B** |
| `apps/api/src/lib/graph/EXPOSURE-METRICS.md` (new) | 3 | **Agent B** |
| `analysis/enshittification-resistance/05-tenant-policy-floor.md`, `07-binding-your-own-hands.md` | 4 | **Agent C** |
| `doc/02-technical/development/audit-and-toggle-conventions.md` | 4 | **Agent C** |

Items 1+2+5 share `discovery.ts`/codebook, so they share an owner (A). Item 3
touches only the handler layer and a new module (B). Item 4 is docs-only (C).
No agent depends on another's output. (A and B both *relate to* the
recommendations path but touch disjoint files: A changes what
`getRecommendations` returns; B counts what the handler serves — B counts
whatever it is given and needs nothing from A's change.)

## Model assignment

| Agent | Model | Rationale |
|-------|-------|-----------|
| **A — Diversity cap + version + codebook** | **Opus** | Three recursive-CTE SQL queries gain an owner aggregation; a merge algorithm with a cap, round-robin fill, and a bounded relaxation pass; the one behaviour change in the plan. Most likely to be subtly wrong. |
| **B — Exposure counters** | **Sonnet** | Pattern-following: `atomicIncrement` already exists (`openai-budget.ts:133`), observable-failure pattern already exists. Well-scoped. |
| **C — Policy-floor deltas** | **Sonnet** | Markdown deltas to three existing docs. Low blast radius. |

Orchestration and the final integration gate are done by the main agent.

---

## Agent A — Diversity cap, ranking version, codebook (items 1, 2, 5) · Opus · worktree

### A1. Per-owner diversity cap in `getRecommendations` (item 1)

Target: `apps/api/src/lib/graph/postgres/discovery.ts:258–291` (merge) and the
three signal queries (`computeSharedConnections`, `computeSameBreed`,
`computeNearbyRecommendations`).

1. **Surface owners.** Each signal query additionally returns the candidate's
   active owner user-ids (join `entity_ownerships` `WHERE status = 'ACTIVE'`,
   `ARRAY_AGG(DISTINCT user_id) AS owner_ids`). Verify tenant scoping on the
   join (`tenant_id = $n`) — an unscoped ownership join would be a cross-tenant
   read.
2. **Extract the merge into a pure function** (project default: pure functions
   for business logic) — e.g. `mergeRecommendations(signals, limit)` in the
   same file or a sibling, taking the per-signal row arrays and returning the
   final page. The existing dedup-by-entity-keep-highest-score stays as step 1
   inside it.
3. **Capped round-robin fill** per the locked decision: sources pre-sorted by
   score desc; cycle shared → breed → nearby; admit a candidate iff every
   owner in `owner_ids` is below `MAX_RECOMMENDATIONS_PER_OWNER = 2`; on
   admit, increment all its owners' counts. After one full cycle over all
   candidates, if `results.length < limit`, run **one** relaxation pass
   admitting remaining candidates by global score desc (cap ignored). Hard
   bound: two passes, no loop on external state.
4. **Preserve existing semantics that tests pin:** dedup keeps highest score
   per entity; `owner_proximity` reason still maps to `shared_connections`
   client-side; confidence clamped to [0,1]; `[]` without tenant context.
   Read the existing unit tests (`test/unit/graph/postgres/discovery.test.ts:295`)
   before touching the merge — the "respects the limit after merge" and
   "dedups keeping the highest score" tests will need *extension*, not
   weakening.

**PITFALL (why A is Opus):** the `owner_proximity` signal averages the user's
relationship score with the entity's owners — owner data already flows through
part of this path. Make sure the new `owner_ids` aggregation and the existing
owner-proximity computation don't double-join or disagree about which
ownerships count (both must filter `status = 'ACTIVE'` and the same tenant).

**New tests (boundary + degenerate, per the testing defaults):**
- one owner owning every candidate → capped pass yields ≤ 2, relaxation pass
  fills to `limit` (the degenerate case the infinite-loop rules require);
- multi-owner entity counts against all owners;
- cap binds across *signals* (same owner surfacing via breed and nearby);
- underfill with no skipped candidates (fewer candidates than `limit`) — no
  spin, no duplicates;
- ownerless candidate (empty `owner_ids`) admitted regardless of cap;
- integration: extend `discovery-postgres.integration.test.ts` with a fixture
  where a hub owner's entities would fill the page pre-cap and assert the
  capped composition (runs under `vitest.graph.config.ts`, Docker PG).

### A2. `DISCOVERY_RANKING_VERSION` + codebook coverage (item 2)

- Export `DISCOVERY_RANKING_VERSION = 1 as const` next to the signal constants
  in `discovery.ts`, with a doc-comment mirroring `FEED_RANKING_VERSION`
  (`feed-pagination.ts:89`): bump on any change to signals, weights, merge, or
  cap semantics. Version 1 **includes** A1's cap (locked decision).
- Extend `SCORING-CODEBOOK.md` (keep its existing section style; it currently
  ends at "Keeping the Codebook in Sync" — insert before that) with a
  **"Discovery Recommendation Signals"** section: shared = `count/10`,
  same-breed = `0.6` fixed, nearby = `(1 − d/10 000) × 0.5` (5 km radius),
  owner-proximity pass-through and its client-side mapping, merge/dedup
  semantics, `MAX_RECOMMENDATIONS_PER_OWNER`, the two-pass fill, and
  `DISCOVERY_RANKING_VERSION`. Each constant gets value + meaning + rationale,
  same as the existing entries.

### A3. Name the tier-assignment exposure pathway (item 5)

- New codebook section **"Exposure Pathways"**: the scoring engine's weights
  (0.35 engagement depth / 0.25 frequency) never order the feed
  (`ALLOWED_SORT_FIELDS` invariant), but they assign circle tiers and **tiers
  gate feed composition** — the platform's one engagement-driven exposure
  mechanism; `owner_proximity` (0.15 pass-through) compounds hub effects.
  Documentation only; no behaviour change.

### A verification
`npm test -- test/unit/graph/postgres/discovery.test.ts` plus the graph
integration suite via `vitest.graph.config.ts` (Docker Compose up, foreground
— never background per CLAUDE.md); typecheck.

---

## Agent B — Aggregate exposure baseline (item 3) · Sonnet · worktree

### B1. `discovery-exposure.ts` (new)

Follow the `OpenAiBudget.atomicIncrement` pattern
(`apps/api/src/lib/openai-budget.ts:133–151`: single-table `UpdateItemCommand`
with `ADD`):

- `recordServedRecommendations(entityIds: string[]): Promise<void>` —
  increments `pk = "discexposure:{yyyy-mm}:{entityId}"`, `sk = "v"`, one
  increment per entity per served page. Monthly bucket from the current date,
  UTC. **No TTL** (it's a baseline), **no viewer identity, no tenant of the
  *viewer*** — the entity id alone. Batch politely (the page is ≤ `limit`
  items; sequential or small `Promise.all` is fine).
- Failures are **observable, never blocking**: `.catch` → stderr log +
  `exposure.record.failure` metric, response unaffected (mirror the
  `audit.emit.failure` handling from the research-foundations plan).

### B2. Wire into the handler

`discovery-handler.ts:161–188` (`handleGetRecommendations`): after the service
returns, fire-and-forget `recordServedRecommendations(results.map(r => r.entityId))`.
Do not await on the response path beyond local error attachment; do not let it
change status codes.

### B3. `EXPOSURE-METRICS.md` (new, sibling to the codebook)

Define the derived metric so the baseline has meaning:
- **Concentration share:** fraction of the month's served-recommendation
  increments going to the top 1% / top 10% of entities (computed offline from
  a scan of the month's `discexposure:` partition; no new infrastructure).
- Optionally Gini over the same counters.
- State the invariant: this is **aggregate-only** instrumentation; per-viewer
  impression logs are refused (link
  [`enshittification-resistance/04`](../../analysis/enshittification-resistance/04-data-minimization.md)
  and [`02-prelaunch-actions.md §3`](../../analysis/algorithmic-norm-misperception/02-prelaunch-actions.md)).
- State why the baseline must predate launch (cannot be backfilled).

### B verification
Unit test the new module with a mocked DynamoDB client (success, failure-is-
observable-and-non-blocking, key shape `discexposure:{yyyy-mm}:{entityId}`);
unit test the handler wiring (response unchanged when recording fails);
typecheck.

---

## Agent C — Ranking-policy floor pre-commitment (item 4) · Sonnet · worktree

Docs-only. Three small deltas; **do not** build dispatch, do not edit any file
under `plans/attention-mechanics-mvp/` (that plan is referenced, not modified).

### C1. `analysis/enshittification-resistance/05-tenant-policy-floor.md`

In the **"Design change: the merge enforces a floor"** section, add the
ranked-surface pre-commitment:

1. **Chronological is the floor** — no tenant, extension, or experiment makes
   an engagement-ranked feed the default surface; ranked surfaces are
   tributaries.
2. Any future ranked surface must be **(a)** versioned
   (`FEED_RANKING_VERSION` / `DISCOVERY_RANKING_VERSION`), **(b)** auditable
   (`feature_toggle.changed` history), **(c)** per-tenant opt-in via the
   reserved `ux_feed_ranking_*` namespace, **(d)** **diversity-constrained by
   default** — a distributional cap is part of the definition of a ranked
   surface, not an option.
3. Note for S1: when the `RANKING_POLICIES` registry
   ([`attention-mechanics-mvp/01`](../attention-mechanics-mvp/01-ranking-policy-boundary.md))
   is built, its guard must enforce (d) for any registered policy.
4. Cite Brady et al. 2026 (link
   [`analysis/algorithmic-norm-misperception/01-insights.md`](../../analysis/algorithmic-norm-misperception/01-insights.md))
   as evidence the floor costs no measured satisfaction.

### C2. `analysis/enshittification-resistance/07-binding-your-own-hands.md`

Under **"Concrete, cheap-now bindings" → "B. Wire each invariant to a
tripwire"**, extend the existing "Ranking guard test" bullet: the guard now
also covers the discovery surface (`DISCOVERY_RANKING_VERSION` pinned by test;
diversity cap pinned by Agent A's invariant tests). One bullet, not a section.

### C3. `doc/02-technical/development/audit-and-toggle-conventions.md`

In the toggle-naming section, add one row/line: the `ux_feed_ranking_*` prefix
is **reserved** for future per-tenant ranking-strategy selection; no key under
it may be created before the ranked-surface pre-commitment in
enshittification-resistance/05 is satisfied. No dispatch code exists or is
built now.

### C verification
Relative links resolve (the docs live at different depths — check each);
markdown renders; no edits outside the three files.

---

## Sequencing & merge

1. Launch A, B, C concurrently (`isolation: worktree`).
2. Each agent self-verifies in its worktree (typecheck + own tests; A also
   runs the graph integration suite against Docker PG, foreground).
3. Merge in any order — file sets are disjoint. Convention: A → B → C.
4. **Integration gate (main agent):** full typecheck; `npm test` foreground
   (the known `post-editing.property.test.ts` full-suite flake is pre-existing
   and not a blocker — passes in isolation); graph integration suite; confirm
   `/api/discovery/recommendations` behaviour change is limited to ordering/
   composition (status codes and response shape unchanged); marker grep per
   the global confidentiality rule.
5. Update `analysis/algorithmic-norm-misperception/02-prelaunch-actions.md`
   with ✅ annotations per item (the research-foundations/08 pattern).
6. Do not commit/push unless asked.

## Deliberately deferred / refused (do NOT build)

- Ranking-strategy dispatch (the `ux_feed_ranking_*` prefix is *reserved*,
  nothing is wired).
- Bridging score / cross-circle signals (`structural-echo-chambers.md` Tier 1).
- Cohort/experiment services (deferred in research-platform/08; unchanged).
- **Per-viewer impression logging — refused**, not deferred
  (data-minimization; item 3's aggregates carry the detection power).
- Any scoring-engine weight change.
