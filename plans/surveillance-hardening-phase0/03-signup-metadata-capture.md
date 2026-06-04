# P3 — Signup Metadata Capture

**Recommended model:** Sonnet
**Effort:** ~2 days
**Blocks:** Phase 2 detection (cohort/clustering signals), Phase 1 signup friction
**Branch:** `feat/P3-signup-metadata-capture` off `main` (requires P1 merged)

## Goal

Record, at account-creation time: how the account was created
(`signupMethod`), which invitation it redeemed (`invitationId`), and the
client signals (IP/UA) — the latter as a retention-bound `SecurityEvent`,
never as columns on `User`. This is the data the "correlated account
clusters" signal needs and that can never be backfilled.

## Design reference

- [`08-implementation-roadmap.md §E2`](../../doc/02-technical/surveillance-threat-model/08-implementation-roadmap.md)
- [`06-registration-friction.md`](../../doc/02-technical/surveillance-threat-model/06-registration-friction.md) — friction-as-signal
- [`07-data-minimization.md`](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md) — why SecurityEvent, not User columns

## Scope

### In scope

1. **Discovery (first task in-stage):** enumerate every path that creates a
   `User` row — Cognito trigger Lambdas (`apps/api/src/lambda/`),
   invitation redemption (`apps/api/src/lib/invitation-handler.ts`),
   magic-link flow, any test/seed seam. The stage PR description lists
   them; missed paths are the failure mode of this stage.
2. **`User.signupMethod` + `User.invitationId`** populated on every path
   found in (1). Existing users stay NULL (unknown) — no fabricated
   backfill.
3. **`SecurityEvent` of a new `signup` type** emitted on every path,
   carrying IP + UA where a request context exists (Lambda triggers may
   have neither — record the event anyway with what's available, e.g.
   Cognito-provided source IP if present).
   - `retentionUntil` set from config (default 180 days — longer than
     InteractionEvent because signup cohorts are the slowest-moving
     signal; still bounded). Non-nullable after P1's tightening, so
     omission is a compile/DB error, not a silent retention escape.
   - Pruning is the hourly cron's `retentionUntil`-based `deleteMany` in
     `apps/api/src/lambda/hourly-cron.ts` (~lines 88–100) — **not** the
     `security-event-cleaner.ts` class, which is a no-op stub. The cron
     filters only on `retentionUntil` (no type allowlist), so `signup`
     events are covered with no new pruning code. P2 retrofits this
     deleteMany to batched form; verify the retrofit landed or coordinate.
4. Config in `env.ts` (retention days), per the threshold-secrecy
   invariant.

### Out of scope

- Acting on the data (velocity limits, cohort detection — Phase 1/2).
- Email-verification enforcement (Phase 1).
- Backfilling `signupMethod` for existing users.

## Acceptance criteria

- [ ] Every user-creation path sets `signupMethod`; invite-path users carry
      the correct `invitationId` (FK verified against the redeemed
      invitation).
- [ ] Every user-creation path emits exactly one `signup` SecurityEvent
      with `retentionUntil` set; cleanup verified against the hourly
      cron's `retentionUntil` deleteMany (no new pruning code needed —
      aged synthetic `signup` events removed in dev).
- [ ] Signup still succeeds when the SecurityEvent write fails (fail-open,
      logged) — account creation must never be blocked by telemetry.
- [ ] A user created with no request context (e.g. seed script) gets
      `signupMethod` but no fabricated IP/UA.

## Test requirements

1. Per-path unit tests (Cognito trigger event fixture, invitation
   redemption, magic link): assert User fields + SecurityEvent emission.
2. Fail-open test: SecurityEvent insert rejection doesn't fail signup.
3. FK test: `invitationId` links to the actual redeemed invitation row.
4. Retention test: emitted event's `retentionUntil` honors config.

## Files to add/modify

| File | Action |
|---|---|
| `apps/api/src/lambda/*` (signup-related triggers, per discovery) | modify |
| `apps/api/src/lib/invitation-handler.ts` | modify |
| `apps/api/src/lib/signup-metadata.ts` | new (shared helper: set fields + emit event) |
| `apps/api/src/env.ts` | modify (retention config) |
| `apps/api/test/unit/signup-metadata.test.ts` | new |

## Security considerations

security-reviewer subagent runs on this PR (it handles raw IP/UA — the
highest data-minimization risk in the plan).

- [ ] No IP/UA columns on `User` (P1 enforces; this stage must not work
      around it via a `metadata` JSON either).
- [ ] The shared helper is the **only** way signup metadata is written —
      one choke point to review, matching the client-metadata rule in
      [07](../../doc/02-technical/surveillance-threat-model/07-data-minimization.md).
- [ ] **Invitation-chain invariant**: `User.invitationId` →
      `Invitation.createdBy` makes the who-invited-whom tree cheaply
      traversable — useful for cluster detection, but under legal
      compulsion it maps a community's entire introduction network
      (threat model [01 §4](../../doc/02-technical/surveillance-threat-model/01-threat-landscape.md#4-legal-compulsion)).
      The chain was already reconstructable via `Invitation.usedBy`; this
      FK lowers the cost. Write the invariant into the helper module: no
      API endpoint (user-facing or admin) exposes transitive invitation
      chains; traversal is reserved for the Phase 2 detection path.
      Whether to null out `invitationId` after the detection window is a
      Phase 2 decision — record it as an open item there, not silently.

## Rollback plan

Additive writes; toggle off via config if a path misbehaves. NULL
`signupMethod` is already the legacy state, so partial rollout is safe.

## Open questions

- Whether the Cognito pre/post-confirmation events expose a usable source
  IP in this pool configuration — resolve during discovery; if not, the
  `signup` event records method + timestamp only (still useful for cohort
  windows).

## Definition of done

All acceptance criteria checked; discovery list in the PR body; merged to
`main`.
