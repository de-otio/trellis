# 04 · S4 — `ageTier`-keyed minor-protection bundle

## Goal

Consolidate the minor protections that are **already implemented but scattered**
into one named, single-source-of-truth `MinorProtectionPolicy` keyed on
`ageTier`, so protection is structural (one place to audit, one place to test)
rather than spread across three files — and so finite-views / no-personalization
become **non-overridable** for minors. **Builds on the compliance-required
age-tier work; does not replace it.**

## Current state (scattered across three modules)

- **Privacy defaults:** `apps/api/src/lib/privacy-defaults.ts`
  `getPrivacyDefaults(ageTier)` (`:75-77`), `LOCKED_FIELDS` (`:25-34`),
  `applyPrivacyLocks()` (`:83-93`). CHILD locks location/analytics/dmAccess; TEEN
  locks nothing.
- **Feature access:** `apps/api/src/lib/age-gate.ts` `getFeatureAccess(ageTier)`
  (`:65-115`): `maxFeedPages`, `sessionTimeLimits`, `sentimentDisplay`,
  `canViewSentimentUsers`, `canEditNotificationPreferences`, `dmAccess`, etc.
- **Pagination caps:** `apps/api/src/lib/feed-pagination.ts`
  `getPaginationConfig(ageTier)` (`:28-69`) — CHILD 5 pages, TEEN 20, ADULT
  unlimited. (Also referenced by S1.)
- **Enforcement:** `apps/api/src/lib/age-gate-middleware.ts` (`:22-34`) injects
  `featureAccess` into the request context for `/api/feeds/*`,
  `/api/notifications`.
- **Transitions:** `apps/api/src/lib/age-tier-transition.ts`
  `checkAgeTierTransitions()` (`:70-183`) re-applies defaults on a birthday tier
  change (respecting more-restrictive user choices).
- **Signup:** `apps/api/src/lambda/post-confirmation.ts` (`:74-150`) computes the
  tier from Cognito `custom:dateOfBirth`.

These are correct and compliance-relevant. The problem is purely that "what
protects a minor" has **no single definition**.

## Design

`apps/api/src/lib/minor-protection/minor-protection-policy.ts` — a façade that
*composes* the existing functions into one typed object per tier, the single
import for "what applies to this `ageTier`":

```ts
export interface MinorProtection {
  ageTier: AgeTier;
  privacyDefaults: PrivacySettings;        // from getPrivacyDefaults
  lockedFields: readonly PrivacyField[];   // from LOCKED_FIELDS
  featureAccess: FeatureAccess;            // from getFeatureAccess
  pagination: PaginationConfig;            // from getPaginationConfig
  // NEW, derived invariants (single source for S5 + finite-views):
  behavioralTargetingAllowed: boolean;     // false for CHILD & TEEN  (S5)
  personalizationAllowed: boolean;         // false for CHILD & TEEN
  finiteViewsEnforced: boolean;            // true for CHILD & TEEN (non-overridable)
}
export function minorProtectionFor(ageTier: AgeTier): MinorProtection;
```

- The existing functions stay (and keep their current callers); the policy
  *delegates* to them so there is no behaviour change — it adds a **name and a
  single entry point**, plus three derived invariants that don't exist yet.
- **Non-overridable finite views:** today `maxFeedPages` is enforced via feature
  access; make the ranking policy ([`01`](01-ranking-policy-boundary.md)) read
  `minorProtectionFor(ageTier).pagination` and **ignore any tenant/extension
  attempt to widen it** for CHILD/TEEN. (Tenants may make a policy *stricter*,
  never looser, for minors — assert this in the tenant-policy merge.)
- `behavioralTargetingAllowed` / `personalizationAllowed` are the hooks S5
  consumes (see [`05`](05-no-minor-microtargeting.md)); defined here so there is
  exactly one definition of "minors don't get targeted/personalized."
- `age-gate-middleware.ts` switches to injecting the composed `MinorProtection`
  (superset of today's `featureAccess`) — back-compatible field.

## Changes

| File | Change |
|---|---|
| `apps/api/src/lib/minor-protection/minor-protection-policy.ts` | **new** — composes existing fns + 3 derived invariants |
| `apps/api/src/lib/age-gate-middleware.ts` | inject `MinorProtection` (keep `featureAccess` as a field for compat) |
| `apps/api/src/lib/feed/ranking-policy.ts` | read pagination via `minorProtectionFor`; clamp tenant overrides for minors |
| `privacy-defaults.ts` / `age-gate.ts` / `feed-pagination.ts` | unchanged behaviour; now also re-exported through the policy |

No schema change. No new tiers.

## Tests

- **Parity:** `minorProtectionFor(t)` returns exactly today's
  `getPrivacyDefaults`/`getFeatureAccess`/`getPaginationConfig` values for each
  tier (snapshot).
- CHILD & TEEN ⇒ `behavioralTargetingAllowed:false`,
  `personalizationAllowed:false`, `finiteViewsEnforced:true`; ADULT ⇒ all per
  current behaviour.
- **Clamp test:** a tenant policy that tries to raise `maxFeedPages` for CHILD is
  clamped to the protective value; a stricter tenant value is honoured.
- Birthday transition (`checkAgeTierTransitions`) still applies the
  more-restrictive-wins merge.

## Effort / priority

Medium. **Priority: high** — directly serves both compliance and the research;
it is the substrate S1's minor-clamp and S5's guard both depend on.
