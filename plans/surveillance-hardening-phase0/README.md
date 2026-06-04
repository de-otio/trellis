# Surveillance Hardening — Phase 0 enablers

> **STATUS: COMPLETE — 2026-06-04.** All 7 stages (P1–P7) merged to `main`
> (`f950dd6`…`e8234be`) and pushed. Full unit suite 7286 green, schema lane
> 74, integration lane 8; `tsc` + lint clean; Phase-0 coverage gate enforced.
> security-reviewer run on P1–P5: no criticals; the one HIGH (reversible
> erasure tombstone) fixed with a keyed HMAC, the cleanest MEDIUM (email
> subject escaping) fixed, the rest triaged. **Not yet released** — ships in
> `v0.9.0` via the `CLAUDE.md` release checklist (version bump + tag is a
> separate, deliberate step).

Implements **Phase 0** of
[`doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md):
the schema seams, data capture, and guarantees that must land **now** so the
post-MVP features (coordinated-behavior detection, account reporting, signup
friction, ActivityPub hardening) remain implementable later. No user-visible
features ship in this plan.

The driving constraint, from the roadmap:

> Detection features can only see data that was *recorded*. History not
> captured cannot be backfilled — the Phase 2 detection clock starts when
> P1–P3 land.

## Working directory

All work happens in `~/repos/dot/trellis/`.

## Stage list

| # | File | Recommended model | Effort | Blocks |
|---|---|---|---|---|
| P1 | [01-schema-enablers.md](./01-schema-enablers.md) | **Opus** | ~2d | P2, P3, P4, P5 |
| P2 | [02-interaction-event-capture.md](./02-interaction-event-capture.md) | Sonnet | ~2d | Phase 2 detection (data accumulation) |
| P3 | [03-signup-metadata-capture.md](./03-signup-metadata-capture.md) | Sonnet | ~2d | Phase 2 detection (data accumulation) |
| P4 | [04-report-model-adoption.md](./04-report-model-adoption.md) | **Opus** | ~2d | Phase 1 account reporting |
| P5 | [05-tenant-scoped-toggles.md](./05-tenant-scoped-toggles.md) | Sonnet | ~2d | Phase 1 signup friction, Phase 2 thresholds |
| P6 | [06-activitypub-preconditions.md](./06-activitypub-preconditions.md) | Sonnet | ~1d | AP enablement (gate, not code) |
| P7 | [07-guarantees-and-rules.md](./07-guarantees-and-rules.md) | Sonnet | ~1d | nothing (review leverage) |

Opus is assigned where work is irreversible or schema-foundational (P1;
P4's data migration cannot be reverted after a release ships). Everything
else is well-specified, test-gated work — Sonnet.

Total: ~12 days of agent-time.

### Parallel execution schedule

Critical path: **5 working days** with up to 4 agents in wave 2.

```
Wave 1 (days 1–2):  P1 (schema)            P6 (docs+spike — no P1 dependency)
Wave 2 (days 3–4):  P2 ∥ P3 ∥ P4 ∥ P5     (all branch off main after P1 merges)
Wave 3 (day 5):     P7 (references P1–P6 outcomes; bookkeeping)
```

Wave-2 coordination notes:

- P2 and P3 both touch `apps/api/src/env.ts` (config additions) — trivial
  merge conflict; whoever merges second rebases.
- P4 is the only wave-2 stage with a schema migration (the sanctioned
  exception) — it needs P1-owner sign-off but **not** serialization behind
  P2/P3/P5.
- P1 must not be split to widen wave 1: parallel edits to
  `prisma/schema.prisma` + competing migration timestamps cost more in
  conflicts than the ~2 days they'd save. The schema bottleneck is
  deliberate.

> **E8 supply-chain quick wins** (SHA-pinned actions, Dependabot, alerts)
> were completed 2026-06-04, before this plan — see roadmap §E8. The
> remaining E8 items (threshold-secrecy rule, go-public gate) are docs and
> land in P7.

## Common patterns

### Branching

`feat/P{N}-{slug}` branches off `main`, PR back to `main`. **No integration
branch** — unlike the multi-tenancy plan, every stage here is additive and
independently shippable; they ride the normal release train and ship
together as the next minor release (target **v0.9.0**).

### Schema ownership

P1 owns `prisma/schema.prisma` and ships **additive-only** migrations.
Exactly one exception: P4 ships a second migration (LinkReport → Report data
fold-in + drop), because data migration and the code switch must land
atomically. P4's migration requires P1-owner sign-off. No other stage
touches the schema; gaps found later are surfaced to the P1 owner, not
patched in parallel.

### Data-minimization invariant (from [07-data-minimization.md](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md))

Every new table or field that stores client metadata or behavioral events
**must carry an explicit retention bound** (a TTL/`expiresAt` column pruned
by the existing hourly-cron pattern, or SecurityEvent's `retentionUntil`).
An unbounded behavioral log is itself a compellable surveillance asset —
P1's review blocks on this.

### Threshold-secrecy invariant (from [09-public-project-exposure.md](../../doc/02-technical/surveillance-threat-model/09-public-project-exposure.md))

The npm tarball is public. Operational parameters (retention days, sampling
rates, future thresholds) are **runtime config** (env / feature toggles with
defaults), never bare compiled-in constants sprinkled at call sites. Stages
P2/P3 define their parameters in `env.ts` + toggle keys.

### Test-first invariant & coverage floor

New code lands with tests in the same PR, following the unit-test pattern in
`CLAUDE.md`. Schema stages add schema-shape tests in
`apps/api/test/integration/schema/` (pattern:
`tenant-shape.integration.test.ts`, run via `npm run test:schema`).
**Caution:** `npm test` excludes `test/integration/**`, and CI currently
runs no `test:schema`/`test:integration` job — P1 adds the CI jobs so this
plan's tests actually gate merges. **Never run tests in the background.**

**Coverage floor: 80%**, and it must be *enforced*, not aspirational.
`apps/api/vitest.config.ts` already sets 80% thresholds
(lines/functions/branches/statements), but CI runs `npm test` without
`--coverage`, so the thresholds are currently decorative. Therefore:

- Every stage PR runs `npm run test:coverage` locally and reports the
  summary in the PR body; new/modified files in the stage must individually
  meet 80% lines/branches.
- **P1 additionally adds a coverage-gated CI step** (see P1 scope): measure
  the current baseline first — if the existing codebase already passes the
  global 80% thresholds, wire `npm run test:coverage` into `ci.yml`; if it
  doesn't, gate coverage on changed files (e.g. vitest
  `coverage.thresholds` scoped via a separate config for CI) and record the
  baseline gap in the PR. Do not silently ship a gate that can't fail.

### Pull request shape

- Title: `feat(P{N}): <one line>`
- Body: link to the stage file, files added/changed, test coverage, any
  deviations from the stage spec (with rationale)
- security-reviewer subagent runs on **P1, P2, P3, P4, and P5** — P1/P4
  for schema + data migration, P2/P3 because they are the stages that
  actually write sensitive behavioral/client data, P5 because it changes
  an authorization boundary. P6/P7 (docs) need only the marker grep.

## Reference design

Canonical design:
[`doc/02-technical/surveillance-threat-model/`](../../doc/02-technical/surveillance-threat-model/)
— each stage file points to its specific design doc(s). The roadmap file
(08) is the source for *why now*; stage files repeat only what's needed to
implement.

## Done definition

- [x] All 7 stages merged to `main`, CI green. *(merged + pushed; locally
      verified tsc/lint/unit/schema/integration — CI runs on push.)*
- [x] `InteractionEvent` and signup-metadata rows visibly accumulating in a
      dev environment (the actual acceptance test for "the detection clock
      has started"). *(InteractionEvent verified via the real-Postgres
      integration test; signup metadata unit-tested — the live signup path is
      a Cognito post-confirmation trigger.)*
- [x] Retention pruning verified: aged synthetic rows are removed by the
      hourly cron in dev. *(batched prune + circuit breaker covered by the
      integration test.)*
- [x] Existing link-report API behavior unchanged after P4 (regression
      suite), modulo P4's two declared security exceptions (reason length
      validation, notification escaping).
- [x] GDPR erasure verified end-to-end: after `deleteUserData()`, no
      Phase 0 table carries the deleted user's ID (as actor, target,
      reporter, or reported resource). *(InteractionEvent actor+target and
      Report cascade+pseudonymization verified in integration.)*
- [x] security-reviewer subagent run on P1–P5 — no high-severity findings
      unaddressed. *(H1 fixed with a keyed HMAC; M1 fixed; M2–M4/L1–L4
      triaged in commit `e8234be`.)*
- [x] Roadmap §Phase 0 items marked done in
      `doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md`.
- [ ] Ships in `v0.9.0` via the release checklist in `CLAUDE.md`. *(pending —
      a deliberate, outward-facing step.)*
