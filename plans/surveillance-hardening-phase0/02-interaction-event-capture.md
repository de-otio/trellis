# P2 — Interaction Event Capture

**Recommended model:** Sonnet
**Effort:** ~2 days
**Blocks:** Phase 2 detection (the data-accumulation clock starts here)
**Branch:** `feat/P2-interaction-event-capture` off `main` (requires P1 merged)

## Goal

Write append-only `InteractionEvent` rows alongside the existing
aggregation, with retention pruning and a volume guard. After this stage,
the temporal signal that `Relationship.signals` counters destroy is
preserved — bounded to a rolling window.

## Design reference

- [`08-implementation-roadmap.md §E1`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)
- [`03-coordinated-inauthentic-behavior.md`](../../doc/02-technical/surveillance-threat-model/03-coordinated-inauthentic-behavior.md) — the three signals the data must support
- [`07-data-minimization.md`](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md) — retention invariant

## Scope

### In scope

1. **Dual-write in the graph layer**: where `recordInteraction()`
   aggregates (`apps/api/src/lib/graph/postgres/scoring.ts` and its
   call path in `postgres-graph-service.ts`), also insert an
   `InteractionEvent` row. Aggregation behavior unchanged.
   - Write failures on the event row must **not** fail the interaction
     (log + metric; same fail-open posture as audit logging in
     `media-handler.ts`).
2. **Volume guard**: high-volume low-signal types (`view`) are sampled or
   skipped per config; high-signal types (react, comment, share,
   profile_visit) always recorded. Per the threshold-secrecy invariant,
   the sampling rate and the enabled-types set are **runtime config**
   (`env.ts` + feature toggle), with conservative defaults.
3. **Retention**: `expiresAt = createdAt + retentionDays` where
   `retentionDays` comes from config (**default 120**: Phase 2 detection
   needs a 60–90-day lookback, and retention must exceed the detection
   window with margin — events expiring the day the analysis runs are a
   silent signal loss). Pruning added to the existing hourly cron
   (`apps/api/src/lambda/hourly-cron.ts`).
   - **Do NOT copy the existing SecurityEvent cleanup there**
     (`hourly-cron.ts` ~lines 88–100): it is a single unbounded
     `deleteMany` — a mass-expiry backlog would lock the table. (The
     `security-event-cleaner.ts` *class* is a no-op stub; the cron is the
     live path.) Implement batched deletes (config batch size, default
     1000) with a max-iteration circuit breaker per the Infinite Loop
     Prevention rules in `CLAUDE.md`. The bounded shape to imitate is the
     cron's media cleanup (`take: 100`).
   - **Retrofit** the SecurityEvent `deleteMany` in the same cron to the
     same batched helper while there (small, prevents the identical
     outage mode for P3's signup events).
4. **Erasure**: extend `deleteUserData()`
   (`apps/api/src/lib/services/user-data-deletion.ts`) to `deleteMany`
   `InteractionEvent` rows where `targetType = USER AND targetId = userId`
   (the actor side cascades via FK, the target side has no FK — and GDPR
   erasure must be prompt, not "ages out in ≤120 days"). Extend
   `DeletionResult` accordingly.
5. CloudWatch metric for events written + pruned (existing metrics
   pattern in `abuse-metrics.ts`).

### Out of scope

- Any *reading* of the events (Phase 2 heuristics).
- Backfill of historical interactions (impossible — that's the point).
- New interaction types beyond the existing `InteractionCounts` vocabulary.

## Acceptance criteria

- [ ] Every non-sampled `recordInteraction()` call produces exactly one
      `InteractionEvent` row with correct type/actor/target/`expiresAt`.
- [ ] Aggregation results (`signals`, `interactionCount`,
      `lastInteractionAt`) byte-identical to pre-change behavior
      (behavior-comparison test on a representative interaction sequence).
- [ ] Event-write failure does not fail or slow the user-facing operation
      (test with a mocked insert rejection).
- [ ] Hourly cron deletes only rows with `expiresAt < now()`, in bounded
      batches, with a max-iteration circuit breaker; SecurityEvent cleanup
      retrofitted to the same helper.
- [ ] Pruning failure (batch errors, circuit breaker tripping every run)
      raises a CloudWatch metric/alarm — silent retention failure converts
      the table into the unbounded log the design forbids.
- [ ] `deleteUserData()` removes target-side `InteractionEvent` rows;
      after running it for a user, zero rows reference that user as actor
      **or** target (test).
- [ ] Retention days / sampling config read from `env.ts`; no literal
      constants at call sites.

## Test requirements

Unit tests per the `CLAUDE.md` pattern (`vi.hoisted` mocks, success +
failure + degenerate cases):

1. Dual-write happy path per interaction type; sampled type skipped when
   config says so.
2. Insert-failure fail-open path.
3. Cron pruning: deletes expired, leaves unexpired, circuit breaker trips
   on a mocked never-empty result (degenerate case).
4. Behavior-comparison: aggregation output unchanged vs. a captured
   pre-change fixture.

Integration test (Docker Postgres): write events through the real graph
service, assert rows + prune.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lib/graph/postgres/scoring.ts` (or its caller) | modify (dual-write) |
| `apps/api/src/lib/graph/postgres/interaction-events.ts` | new (insert + prune helpers) |
| `apps/api/src/lambda/hourly-cron.ts` | modify (add prune step; retrofit SecurityEvent cleanup to batched helper) |
| `apps/api/src/lib/services/user-data-deletion.ts` | modify (target-side InteractionEvent erasure) |
| `apps/api/src/env.ts` | modify (retention + sampling + batch-size config) |
| `apps/api/test/unit/interaction-events.test.ts` | new |
| `apps/api/test/integration/interaction-events.integration.test.ts` | new (runs via `test:integration` — CI job added in P1) |

## Security considerations

security-reviewer subagent runs on this PR (it writes behavioral data).

- [ ] No content payloads in events — type + references only (enforced by
      P1 schema; don't smuggle content into a `metadata` JSON).
- [ ] **Read-access invariant**: 90+ days of who-interacted-with-whom-when
      is a behavioral fingerprint — the social graph + activity patterns a
      fusion platform would buy. Phase 0 ships **zero read paths**. Write
      it down in the module: any future read is restricted to the Phase 2
      detection path and moderator surfaces, requires
      MODERATOR/SUPER_ADMIN, and emits an audit event. No general-purpose
      query endpoint, ever.
- [ ] Config defaults documented in `env.ts` comments; deployed values are
      the consuming vertical's concern (threshold secrecy).

## Rollback plan

Feature-toggle the dual-write off (`interaction_events_enabled`, default
on); rows already written age out via retention. No schema rollback needed.

## Open questions

- Whether `view` events are skipped entirely or sampled at N% by default —
  decide in-stage based on observed dev write volume; either is acceptable,
  both are config.

## Definition of done

All acceptance criteria checked; events visibly accumulating in dev
(README done-definition item); merged to `main`.
