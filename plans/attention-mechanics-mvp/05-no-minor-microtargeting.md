# 05 · S5 — No behavioural/micro-targeting of minors

## Goal

Guarantee minors are never subject to behavioural targeting or personalized
ranking — enforced at a single guard point that any present or future
targeting/personalization surface **must** consult, so the guarantee can't be
forgotten when an ad or recommendation surface is eventually added.

## Current state

- **No advertising / monetization / microtargeting module exists** anywhere in
  `apps/api/src` (confirmed by search). So today this is a *latent* risk, not a
  live one — exactly when it's cheapest to fence off.
- The one personalization vector that exists: `FeedHandler.getHomeFeed()` applies
  a taxonomy-tag filter **only when `options.personalized` is true**
  (`feed-handler.ts:288-327`, via `feed-personalization.ts`).
- `analyticsOptOut` defaults true for CHILD/TEEN (`privacy-defaults.ts`); CHILD
  locks it (`LOCKED_FIELDS`).

## Design

Two parts — a constraint and a guard:

1. **Written platform constraint** (in this plan + a code comment at the guard):
   Trellis runs no real-time-bidding / behavioural ad surface. If any
   ad/recommendation/personalization surface is ever added, it **must** call the
   guard below, and minors are excluded from behavioural targeting *and*
   personalization unconditionally.

2. **Single guard point**, sourced from S4's policy
   ([`04`](04-minor-protection-bundle.md)) so there is one definition:

```ts
// apps/api/src/lib/minor-protection/targeting-guard.ts
export function assertPersonalizationAllowed(ageTier: AgeTier): void {
  if (!minorProtectionFor(ageTier).personalizationAllowed)
    throw new ForbiddenPersonalizationError(ageTier);
}
export function behavioralTargetingAllowed(ageTier: AgeTier): boolean {
  return minorProtectionFor(ageTier).behavioralTargetingAllowed; // false: CHILD,TEEN
}
```

- Wire the **existing** personalization path through it: in `getHomeFeed`, force
  `options.personalized = options.personalized && behavioralTargetingAllowed(ageTier)`
  — a minor request can never enter the taxonomy-personalization branch, even if
  a caller passes `personalized:true`.
- Export `behavioralTargetingAllowed` as the documented contract any future ad
  surface consumes. (No ad code is written now — only the guard it will be
  required to call.)

## Changes

| File | Change |
|---|---|
| `apps/api/src/lib/minor-protection/targeting-guard.ts` | **new** — guard fns over S4's policy + `ForbiddenPersonalizationError` |
| `apps/api/src/lib/feed-handler.ts` | gate the `personalized` branch through `behavioralTargetingAllowed(ageTier)` |
| (future ad/reco surface) | **must** call the guard — recorded as a constraint |

No schema change.

## Tests

- CHILD/TEEN request with `personalized:true` ⇒ personalization branch is **not**
  taken (assert taxonomy filter absent from the query); ADULT ⇒ unchanged.
- `behavioralTargetingAllowed` is `false` for CHILD/TEEN, `true` for ADULT.
- `assertPersonalizationAllowed` throws for CHILD/TEEN.
- Regression guard: a test that fails if a new feed/targeting code path reads
  `personalized`/targeting flags without going through the guard (lint-style —
  e.g. grep test or an architectural test asserting the guard is the only gate).

## Effort / priority

Low (a guard + one call-site today). **Priority: medium** — cheap insurance that
makes the "minors are never targeted" promise structural before any ad surface
exists to violate it.
