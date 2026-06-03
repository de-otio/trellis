# Attention-mechanics MVP

**Date:** 2026-06-02
**Status:** Plan — not yet built.
**Source:** Implements suggestions **S1–S5** from
[`analysis/safer-social-design/09-attention-regulation-and-age-limits/03-suggested-changes.md`](../../analysis/safer-social-design/09-attention-regulation-and-age-limits/03-suggested-changes.md).
**S6** (privacy-preserving age assurance) is **deferred** — but this plan lays the
design seam so it slots in without reworking call sites (see
[`06-age-assurance-seam.md`](06-age-assurance-seam.md)).

## What this delivers

The research (Watzl / GoodAttention 2026) says regulators will target attention
*mechanisms* and ask for *transparency*; minors should be protected at the
*mechanism* level, not by exclusion. Trellis already behaves well here — the work
is mostly **making the good behaviour explicit, single-sourced, inspectable, and
hard to regress**, plus one genuinely new feature (S2) and one guard (S5).

| File | Suggestion | One-line |
|---|---|---|
| [`01-ranking-policy-boundary.md`](01-ranking-policy-boundary.md) | S1 | Extract feed ordering into one named, documented, inspectable ranking policy |
| [`02-ranking-transparency.md`](02-ranking-transparency.md) | S2 | "Why am I seeing this / why is this person in this tier" — surface the score breakdown |
| [`03-notification-policy.md`](03-notification-policy.md) | S3 | Notification cadence/quiet-hours/batching as one explicit, tenant-configurable policy |
| [`04-minor-protection-bundle.md`](04-minor-protection-bundle.md) | S4 | Consolidate the scattered `ageTier` protections into one minor-protection policy |
| [`05-no-minor-microtargeting.md`](05-no-minor-microtargeting.md) | S5 | A behavioural-targeting guard minors can never be subject to |
| [`06-age-assurance-seam.md`](06-age-assurance-seam.md) | S6 (prep) | Provider seam + provenance field so S6 is a drop-in later |

## Compliance constraint (non-negotiable)

The age-tier machinery already in the codebase — `dateOfBirth`, `ageTier`
(`CHILD`/`TEEN`/`ADULT`), `ParentalLink`, `privacy-defaults.ts`,
`age-tier-transition.ts`, `age-gate.ts` — is **required for near-term compliance
and stays**. S4 *consolidates and hardens* it; it does not replace it. S6-prep
keeps **self-declared age tiers as the default** assurance method. Nothing here
weakens minor protection.

## Two cross-cutting seams this plan introduces

Both are small, both unblock later work (S6, and S8's "calm tenant preset"):

1. **Tenant policy config.** There is no per-tenant config table today (Tenant
   has `region`, IdP, members — `prisma/schema.prisma:1515`). S1 and S3 need a
   place for per-tenant overrides. Introduce a single narrow, validated
   `policy Json?` column on `Tenant` (Zod-validated in the app layer), defaulting
   to platform defaults. Detailed in [`01`](01-ranking-policy-boundary.md);
   reused by [`03`](03-notification-policy.md).
2. **Age-assurance provider seam.** `identityVerificationProvider`
   (`schema.prisma:200`) is *identity*, not *age*, and has no flow wired. Age is
   self-declared. Introduce an `AgeAssuranceProvider` interface + an
   `ageAssuranceMethod` provenance field with only the self-declared
   implementation now, so S6 registers a ZK/token provider later without
   touching `computeAgeTier` call sites. Detailed in
   [`06`](06-age-assurance-seam.md).

## Implementation order (differs from file numbering)

File numbers mirror the S-numbers for traceability; build order is by dependency:

1. **Seams first** — tenant policy config column + age-assurance interface
   scaffolding ([`01`](01-ranking-policy-boundary.md) §Seam, [`06`](06-age-assurance-seam.md)). Cheap, unblocks the rest.
2. **S4** minor-protection bundle ([`04`](04-minor-protection-bundle.md)) — the
   substrate S1/S5 reference (pagination caps, personalization gate).
3. **S1** ranking policy boundary ([`01`](01-ranking-policy-boundary.md)).
4. **S5** no-minor-microtargeting guard ([`05`](05-no-minor-microtargeting.md)) —
   depends on S4's policy + S1's personalization path.
5. **S3** notification policy ([`03`](03-notification-policy.md)) — independent of
   the feed; needs the tenant-config seam.
6. **S2** ranking transparency ([`02`](02-ranking-transparency.md)) —
   independent (scoring only); can be built in parallel any time.

## Testing posture

S1/S3/S4 are refactors of live behaviour. Per the project's verification
defaults, favour **behaviour comparison over code comparison**: capture current
feed ordering, notification gating, and per-tier privacy/feature output on a
representative fixture set, and assert the consolidated policy modules reproduce
it **byte-for-byte** before adding new knobs. S2 and S5 are new and get
boundary + failure-path unit tests (the `apps/api/test/unit/` pattern).

## Deployment note

Per `CLAUDE.md`, Trellis ships via npm and is verified end-to-end in Skybber's
environment, not here. Each step is independently shippable; the tenant-policy
column is the only schema migration in the MVP (S6-prep adds one nullable field).
