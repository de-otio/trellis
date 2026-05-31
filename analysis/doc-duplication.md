# Doc Duplication & Misplacement: trellis ⇄ trellis

> **Executed 2026-05-31.** See the "Execution log" at the end of this file for
> exactly what was changed. Decisions taken: trellis removal via `git rm`;
> the 1b deployment/ops set kept in *both* repos (intentional fork, no change);
> full content port of the diverged docs done in this pass.


**Date:** 2026-05-31
**Author:** analysis pass (Claude)
**Question:** Trellis was factored out of trellis. Which documentation/analysis
files still in `trellis` belong in `trellis` (the generic core), and where is
the same doc now maintained in *both* repos? Goal: eliminate duplication.

> Scope note: this is the "separate pass" that
> [`trellis/plans/doc-realignment/PLAN.md`](../../trellis/plans/doc-realignment/PLAN.md)
> explicitly deferred — its non-goals list "Touching trellis docs (separate
> repo, separate pass)." That plan realigns trellis docs to post-redesign
> reality *in place*; it does not move anything across the repo boundary. This
> document is the cross-repo boundary analysis.

---

## TL;DR

- **126 docs exist at identical relative paths in both repos** — the clearest
  duplication. Of these, **75 are byte-identical** and **51 have diverged**
  (trellis's copies are *newer*: they carry `> Updated 2026-05 for redesign`
  banners and graph-layer/repo-split content that trellis's copies lack, mixed
  with trellis-specific framing). These were copied into trellis during the
  extraction and never removed from trellis.
- The 126 split by *canonical owner*, not by a single direction:
  - **~95 are trellis-canonical** (generic-core: getting-started, ai-strategy,
    most architecture, core dev/testing, cross-cutting analysis). Trellis should
    stop maintaining its copies.
  - **~31 are arguably trellis-canonical** (deployment/ops that describe the
    *live* AWS environment trellis owns: CDK structure, deployment,
    cost-estimates, disaster-recovery, deploy-role). Trellis holds these as
    *design-target* docs; whether trellis should carry them at all is a
    decision flagged below — they are the one place the "everything generic →
    trellis" reflex is wrong.
- **A small set of trellis-only docs are squarely about the trellis core** and
  are genuine *move* candidates (not yet copied): `spyware-defense/`,
  `chaoskb-reuse/`, `crypto-envelope-package/`, `structural-echo-chambers.md`,
  `plans/mvp/10-trellis-stages/`, parts of `plans/redesign/`, and
  `architecture/14-graph-and-circles.md`.
- **The 754-file `doc/01-business/features/` tree is overwhelmingly trellis's**
  (dog vertical + product/business feature specs). Some describe generic
  platform mechanisms (feed, followers, gamification, …) but they are *product
  specs* in trellis's business tree. Trellis deliberately has **no
  `doc/01-business/` tree** — only `00-getting-started/` and `02-technical/`.
  Recommendation: leave these in trellis unless/until trellis grows a
  product-docs surface. They are not duplication.

---

## Method

```
trellis: find analysis doc -name '*.md'          → 200 files
trellis: find analysis doc plans -name '*.md'     → 1008 files

comm of sorted relative paths:
  exact-path overlap (in both repos)              → 126
  trellis-only                                    → 882
per-file diff of the 126 overlap                  → 75 identical, 51 diverged
```

The divergence is directional and consistent (sampled `architecture/00-overview.md`,
`00-getting-started/glossary.md`, `architecture/03-database.md`): **trellis's
copy is the more recently edited one.** It contains the redesign banner, the
Neo4j AuraDB / entity-graph / circles material, the repo-split note, and
trellis-specific naming (`@trellis/ext-dogs`, `{stage}-trellis`); trellis's copy
is an older snapshot that was genericized (Trellis naming) but never received
the redesign updates. So "duplication" here means *the same technical doc is
maintained in two places and has drifted apart* — not clean copies.

---

## The split convention already in force

Trellis has already established the correct pattern in two places, and this
analysis judges every candidate against it:

- **Framework design → trellis. Adoption/rollout → trellis, cross-referencing
  trellis.** See [`trellis/doc/02-technical/architecture/identity-federation-adoption.md`](../../trellis/doc/02-technical/architecture/identity-federation-adoption.md):
  *"How Trellis consumes the trellis … framework feature … The framework design
  itself … is in trellis at `trellis/doc/02-technical/identity-federation/`."*
  And [`trellis/.../architecture/DATA_MODEL.md`](../../trellis/doc/02-technical/architecture/DATA_MODEL.md):
  *"Multi-tenant identity is a trellis framework feature; canonical design at
  `trellis/doc/02-technical/identity-federation/`."*
- **MVP work is already partitioned by repo:**
  [`trellis/plans/mvp/10-trellis-stages/`](../../trellis/plans/mvp/10-trellis-stages/)
  (schema migration, cognito triggers, tenant/IdP CRUD, audit log, sign-in
  routing, agent surface) vs `20-trellis-stages/` (trellis bump, CDK, Flutter,
  static site, dogfood).

Implication: trellis is the home for **generic-core technical design +
cross-cutting platform analysis**; trellis is the home for **product/business
feature specs, the dog vertical, deployment/ops of the live environment, and
adoption docs**. Docs that cross the boundary should become a pointer, not a
second copy.

---

## Category 1 — Exact-path duplicates (126 files, in *both* repos)

These are the unambiguous duplication. Resolve by picking a canonical owner per
group; the non-owner keeps at most a one-line pointer.

### 1a. Trellis-canonical — trellis should drop/thin its copy (~95 files)

| Group (path prefix) | Files | Identical / diverged | Action |
|---|---|---|---|
| `doc/00-getting-started/` | 4 | 0 / 4 | Trellis canonical. Trellis's copies carry redesign + trellis naming → **port the generic redesign updates into trellis**, then replace trellis copies with pointers. |
| `doc/02-technical/ai-strategy/` | 10 | 4 / 6 | Trellis canonical (AI-SDLC strategy is core, domain-agnostic). Reconcile the 6 diverged into trellis; drop from trellis. |
| `doc/02-technical/architecture/` (00–13) | 14 | 0 / 14 | **All 14 diverged.** Trellis canonical for the *design* (system-design, database schema, auth, async, activitypub, dynamodb, security, agents). Trellis's copies hold the post-redesign graph/Neo4j content trellis is missing → port generic parts to trellis. **Exception: see 1b** for the deployment-flavored ones. |
| `doc/02-technical/development/` (+ `testing/`, `misc/`) | ~17 | ~6 / ~11 | Trellis canonical for core dev/test docs (local-setup, migrations, testing strategy, csrf-guide, scaling, pool capacity). `github-deploy-role.md` is trellis-leaning (see 1b). |
| `analysis/agentcore/` | 6 | 6 / 0 | Identical. Trellis canonical (AI-SDLC tooling strategy). Delete from trellis. |
| `analysis/monetization/**` | 46 | 45 / 1 | Identical except `value-exchange-social-platform/README.md`. Platform monetization analysis = trellis. Delete from trellis (reconcile the one README). |
| `analysis/on-device-ai/` | 7 | 7 / 0 | Identical. Trellis canonical. Delete from trellis. |
| `analysis/safer-social-design/` (01–06) | 6 | 3 / 3 | Trellis canonical (platform-level safety design; trellis already added `07`/`08`). Reconcile 3 diverged into trellis; delete from trellis. |
| `analysis/security-review.md` | 1 | 0 / 1 | Diverged. Decide which review is current; keep one. |

> The "diverged" copies are listed in full in the Appendix. For every diverged
> trellis-canonical doc the recommended order is: **(1) port trellis's generic
> redesign updates into the trellis copy, stripping trellis-specifics; (2)
> replace the trellis file with a one-line pointer (or delete if unlinked).**
> Do not simply delete trellis's copy first — it currently holds content trellis
> lacks.

### 1b. Trellis-canonical (or genuinely shared) — the reflex-trap set (~31 files)

These describe the **live AWS deployment**, which trellis's own CLAUDE.md says
trellis does *not* own ("Trellis is not (yet) deployed standalone … Trellis owns
the live AWS environment"). Trellis carries them only as *design-target* docs.
**Decision needed:** keep them in trellis as design targets, or treat trellis as
canonical and thin trellis's copies?

| Doc(s) | Why trellis-leaning |
|---|---|
| `architecture/08-cdk-structure.md` | CDK lives in trellis. |
| `architecture/12-cost-estimates.md` | Costs are of the trellis-deployed env. |
| `operations/deployment.md`, `operations/runbooks/*` (disaster-recovery, rollback, high-error-rate, database-issues, deploy-role-security) | Operate the live trellis env. |
| `development/misc/github-deploy-role.md`, `aws-ecs-database-connections.md` | Deploy role + ECS tuning of the running deployment. |
| `development/testing/post-deploy-speed.md`, `postdeployment-connection-design.md` | Post-deploy behavior of the live env. |

Recommendation: **trellis-canonical.** Trellis keeps a short "deployment is
realised by the consuming app; see the consumer's ops docs" pointer rather than
drifting copies. (If trellis is ever deployed standalone, revisit.)

---

## Category 2 — Trellis-only docs that are about the trellis core (MOVE candidates)

Not yet in trellis; their *subject* is the generic core. These are the clearest
"belongs in trellis" items beyond the exact-path dups.

| Trellis path | Files | Verdict | Reason |
|---|---|---|---|
| `analysis/spyware-defense/` | 5 | **Move to trellis** | Self-titled *"Spyware Defense — Trellis-side Changes."* Threat-model + core-platform hardening, no dog specificity. |
| `analysis/chaoskb-reuse/` | 5 | **Move to trellis** | Assesses reusing chaoskb crypto for the trellis core (`@trellis/crypto`, E2E-DM). Core-platform. |
| `analysis/crypto-envelope-package/` | 7 | **Move (or to a shared/foundation home)** | Productizing a de-otio crypto-envelope npm package used by chaoskb + trellis. Cross-cutting; aligns with the `saas-foundation` direction. Not trellis-specific. |
| `analysis/structural-echo-chambers.md` | 1 | **Move to trellis** | "Architectural levers for Trellis/**Trellis**" — platform-design levers against echo chambers; domain-agnostic. |
| `plans/mvp/10-trellis-stages/` | 10 | **Move / mirror to trellis** | Explicitly the *trellis* multi-tenancy MVP stages (schema, cognito triggers, tenant/IdP CRUD, audit log, sign-in routing, agent surface). Currently orchestrated from trellis; the work is trellis's. At minimum trellis should own the canonical copy. |
| `plans/redesign/` (graph-db hosting decision/runbook/analysis, phase-2-graph-layer, db-connection-management) | ~8 | **Genericize → trellis design docs** | The redesign that *produced* trellis. The graph-layer + DB-connection material is core-platform design. Note REDESIGN_REALITY marks `plans/redesign/` as the live source — coordinate before moving; mirror rather than cut if it's still driving trellis work. |
| `doc/02-technical/architecture/14-graph-and-circles.md` | 1 | **Genericize → trellis** (mixed) | The entity-graph + circles design is a core-platform primitive (trellis already has `analysis/redesign/02-new-core-primitives.md`, `03-schema-design.md`). Doc is trellis-flavored ("shifts Trellis from…") → genericize. |

**Stay in trellis (correctly trellis-side), for the record:**
`architecture/identity-federation-adoption.md` and `architecture/DATA_MODEL.md`
(both explicitly product-side rollout docs that already point at trellis as
canonical) and `architecture/15-database-connection-management.md` (operates
trellis's RDS+AuraDB deployment).

---

## Category 3 — Generic feature specs in trellis's business tree (NOT duplication; default-keep)

A sweep of `doc/01-business/features/` (754 files) found subdirectories that
describe *generic* platform mechanisms with little/no dog specificity:

- **Generic-mechanism feature specs:** `b2c-features/feed/`, `feed-filtering/`,
  `followers/`, `friend-invitations/`, `gamification/`, `community-guidelines/`,
  `live-streaming/`, `media-collection/`, `multilingual-user-features/`,
  `sentiment-prediction/`, `sub-communities/`, `ephemeral-content/`;
  `b2b-and-b2c/encryption/`, `export-user-data/`, `payment-features/`,
  `user-profile/`.
- **Mixed (generic mechanism, dog-flavored):** `ai-slop-minimization/`,
  `misinformation/`, `content-creators/`, `crime-related-features/`,
  `border-safety-mode/`, `b2b-features/{ai-b2b-features,b2b-api-integration,b2b-crm-features,business-intelligence,influencer-content-tools,smb-features}/`,
  `ai-saas-strategy/`, `internal-features/`.

**These are product/business feature specifications, not core design docs.**
Trellis intentionally has no `doc/01-business/` tree. Moving them would mean
inventing a product-docs surface in trellis and would blur the
core/product line. **Recommendation: keep in trellis.** Revisit only if trellis
deliberately decides to publish reference product specs for the generic
mechanisms it ships (e.g. a generic "feed" or "gamification" capability doc) —
in which case extract a *genericized* core spec and leave the trellis product
spec in place. This is a deliberate decision, not a dedup chore.

---

## Category 4 — Clearly stays in trellis (dog vertical + business)

For completeness, the bulk of `doc/01-business/features/` and several analysis
dirs are dog-vertical / product / partnership and are correctly trellis's:
dog-profile, dog-seller-app, breeder/kennel-club/groomer/shelter features,
dog-food-manufacturers, dog-insurers, dog-pharma, air-travel/road-trips/
renting-with-dogs, NFC dog tags, a vertical partnership analysis (external
company), `funny-captions/` (dog images), `doc/01-business/roadmaps/`, and
the trellis-side MVP stages. No action.

---

## Recommendation (sequencing)

1. **Quick wins — delete the 75 byte-identical trellis copies** that fall in the
   trellis-canonical groups (agentcore, monetization, on-device-ai, and the
   identical getting-started/ai-strategy/dev files). Pure duplication, zero
   reconciliation. (Skip any in the 1b trellis-canonical set.)
2. **Reconcile the 51 diverged trellis-canonical docs**: port trellis's generic
   redesign updates into trellis, strip trellis-specifics, then replace the
   trellis file with a pointer. Architecture (00–13) and getting-started are the
   priority — that is where trellis is most stale.
3. **Decide direction for the 1b deployment/ops set** (CDK, cost, runbooks,
   deploy-role). Recommended: trellis-canonical; trellis keeps pointers.
4. **Move the Category-2 trellis-core docs** (`spyware-defense/`,
   `chaoskb-reuse/`, `crypto-envelope-package/`, `structural-echo-chambers.md`,
   `10-trellis-stages/`, graph-layer redesign docs) into trellis, genericizing
   where trellis-flavored. Coordinate `plans/redesign/` since it is still live.
5. **Leave Category 3 & 4 in trellis.** Treat any core-spec extraction from
   Category 3 as a separate, deliberate decision.

> All cross-repo moves should use `git mv` within each repo (history is
> per-repo; true history transfer would need `git filter-repo`/subtree, likely
> overkill here). Where trellis keeps a pointer instead of a copy, make it a
> one-line link to the trellis canonical doc, mirroring the
> `identity-federation-adoption.md` precedent.

---

## Appendix — the 51 diverged exact-path duplicates

Trellis's copy is newer in every sampled case. `*` marks the ~31 in the
trellis-canonical (1b) deployment/ops set.

```
analysis/monetization/value-exchange-social-platform/README.md
analysis/safer-social-design/02-current-state-audit.md
analysis/safer-social-design/05-age-verification-and-minor-safety.md
analysis/safer-social-design/06-competitive-differentiation.md
analysis/security-review.md
doc/00-getting-started/for-developers.md
doc/00-getting-started/for-operations.md
doc/00-getting-started/glossary.md
doc/00-getting-started/README.md
doc/02-technical/ai-strategy/ai-dlc-adoption.md
doc/02-technical/ai-strategy/aws-mcp-investigation.md
doc/02-technical/ai-strategy/phase-1-assistance.md
doc/02-technical/ai-strategy/principles.md
doc/02-technical/ai-strategy/README.md
doc/02-technical/ai-strategy/tool-selection.md
doc/02-technical/architecture/00-overview.md
doc/02-technical/architecture/01-system-design.md
doc/02-technical/architecture/02-compute.md
doc/02-technical/architecture/03-database.md
doc/02-technical/architecture/04-storage-cdn.md
doc/02-technical/architecture/05-auth.md
doc/02-technical/architecture/06-async-processing.md
doc/02-technical/architecture/07-activitypub.md
doc/02-technical/architecture/08-cdk-structure.md            *
doc/02-technical/architecture/09-security.md
doc/02-technical/architecture/10-observability.md            *
doc/02-technical/architecture/11-dynamodb-single-table.md
doc/02-technical/architecture/12-cost-estimates.md           *
doc/02-technical/architecture/13-agents.md
doc/02-technical/development/local-setup.md
doc/02-technical/development/migrations.md
doc/02-technical/development/misc/003-scaling-to-millions.md
doc/02-technical/development/misc/aws-ecs-database-connections.md   *
doc/02-technical/development/misc/capacity-estimate-in-process-pool.md
doc/02-technical/development/misc/csrf-guide.md
doc/02-technical/development/misc/github-deploy-role.md      *
doc/02-technical/development/misc/magic-link-abuse-protection-analysis.md
doc/02-technical/development/testing.md
doc/02-technical/development/testing/ci-cd.md
doc/02-technical/development/testing/debugging.md
doc/02-technical/development/testing/e2e.md
doc/02-technical/development/testing/maildummy.md
doc/02-technical/development/testing/post-deploy-speed.md    *
doc/02-technical/development/testing/postdeployment-connection-design.md   *
doc/02-technical/development/testing/strategy.md
doc/02-technical/operations/deployment.md                   *
doc/02-technical/operations/runbooks/database-issues.md     *
doc/02-technical/operations/runbooks/deploy-role-security.md  *
doc/02-technical/operations/runbooks/disaster-recovery.md   *
doc/02-technical/operations/runbooks/high-error-rate.md     *
doc/02-technical/operations/runbooks/rollback.md            *
```

---

## Execution log (2026-05-31)

Executed on trellis branch **`docs/trellis-core-dedup`** (off `dev`) and on the
trellis working tree (current feature branch). **Nothing was committed** — all
changes left staged/working for review.

**Trellis — 131 files `git rm`'d (staged), 1 index fixed:**
- Phase 1: 75 byte-identical trellis-canonical duplicates removed.
- Phase 2: 38 diverged trellis-canonical duplicates removed (after their newer
  content was ported into trellis).
- Phase 3 (move set): 18 analysis files removed — `spyware-defense/` (5),
  `chaoskb-reuse/` (5), `crypto-envelope-package/` (7), `structural-echo-chambers.md` (1).
- `analysis/README.md` index updated: moved-doc sections replaced with a pointer
  to the trellis repo; trellis-owned sections (a vertical partnership analysis,
  Funny Captions, AI Strategy) kept.

**Trellis — content ported + docs added (working tree):**
- Phase 2: newer post-redesign content (entity-graph / Neo4j AuraDB / circles /
  Cognito) merged into the diverged trellis-canonical docs, genericized. Most
  `ai-strategy/`, `getting-started/`, `development/` docs needed no change (trellis
  copies were already genericized snapshots); the substantive ports landed in
  `architecture/00,01,03,05,06,07,09`, `getting-started/README`, `testing/strategy`.
  Fixed an internal inconsistency: removed the `followers-events` SQS queue from
  `06-async-processing.md` (follows moved to the graph).
- Phase 3 (move set): the 18 analyses added under `analysis/` (genericized).
- Phase 3 (mirror set, trellis copies KEPT): genericized copies added to trellis —
  `doc/02-technical/architecture/14-graph-and-circles.md`,
  `plans/multi-tenancy-mvp/` (was trellis `plans/mvp/10-trellis-stages/`, 10 files),
  and `plans/redesign/` graph-DB + connection-management docs (8 files). These
  mirror live trellis plans; trellis's copies should become pointers once the
  multi-tenancy MVP / redesign work lands.

**1b deployment/ops set (13 docs):** left unchanged in **both** repos per the
"keep in trellis too" decision — intentional fork (trellis = design-target,
trellis = live-env).

**Verification:** all ported/added trellis files pass a leak grep for
`trellis|ext-dogs|dog|dogs|breed|pack` (only intentional "trellis product repo"
external pointers remain, where a doc references a doc that correctly stays in
trellis).

**Known follow-ups (deferred to trellis's doc-realignment Phase 2):** cross-refs
*within* trellis feature docs (e.g. `border-safety-mode/*` → `spyware-defense/`,
and `funny-captions/02` → a moved analysis) now point at removed files and need
repointing or external-ref conversion.
