# 03 — No-twiddling as an enforced invariant

> **Leverage: high.** Twiddling is Doctorow's engine of enshittification. The
> goal is to make the no-twiddling guarantee *constitutional* rather than
> *configurable*.

## What's already good

The [ranking-policy-boundary plan](../../plans/attention-mechanics-mvp/01-ranking-policy-boundary.md)
is genuinely strong. It lifts ordering into a single named policy object whose
permitted inputs are an enum with **no member** for engagement signals:

```ts
export type RankingInput = "recency" | "relationshipScore" | "circleTier";
// likes / comments / shares / views are absent BY CONSTRUCTION
```

and `validateSortField` (today at `apps/api/src/lib/feed-pagination.ts:61`)
already rejects any sort field except `createdAt`. The
[transparency plan](../../plans/attention-mechanics-mvp/02-ranking-transparency.md)
(S2) exposes *why* a post is in a given circle.

## The two gaps

1. **The enum protects against extensions, not against the operator.** The plan
   is explicit that the guard stops *an extension* from quietly turning the feed
   into engagement ranking. But nothing stops a future maintainer adding
   `engagement-recency-v2` to the `RANKING_POLICIES` registry
   (`apps/api/src/lib/tenant/tenant-policy.ts`, planned) and a new `RankingInput`
   member. The constraint lives in editable source with no tripwire.

2. **"Tenant-configurable ranking" is itself the twiddling surface.** Doctorow's
   definition of twiddling is the moment-to-moment, per-segment adjustment of
   the deal. A per-tenant `policyId` is a (coarse) version of exactly that. It is
   fine *if and only if* the set of permissible policies is bounded and every
   change is visible.

## Design changes

### A. A CI / property-test guard the operator can't quietly edit

Add a test that **fails the build** if:

- any `RankingInput` enum member matches a behavioural/engagement vocabulary
  (`like`, `comment`, `share`, `view`, `dwell`, `score`, `engagement`,
  `viral`, …), or
- any policy registered in `RANKING_POLICIES` declares an `orderBy` other than
  `createdAt`, or a `rankingInputs` entry outside the allowed set.

This converts "we choose not to twiddle" into "the build will not ship if we
do." Reversal becomes a visible diff to a guard test — exactly the kind of
costly, observable act that an invariant requires. Pair it with a CODEOWNERS
rule so changing the guard itself needs review.

### B. Bind every ranking change to a user-visible version

- The active `policyId` for a given user is **surfaced through the existing
  transparency API** (S2,
  [`02-ranking-transparency.md`](../../plans/attention-mechanics-mvp/02-ranking-transparency.md)).
- Changing the policy bumps a version string the user can see. Twiddling you
  cannot hide is twiddling you mostly will not do — and it is the artefact a
  regulator can demand (the regulation force).

### C. Keep "filter, never reorder" for extensions — and test order-preservation

The plan already requires that the personalization hook may only *filter*
candidate posts, never reorder them, with an order-preservation test. Keep that;
it is the extension-side half of the same invariant. The guard in (A) is the
operator-side half the plan is currently missing.

## Net effect

After this, there are three independent locks on engagement ranking: the enum
(compile-time), the guard test (build-time, operator-facing), and the
transparency surface (run-time, user-facing). Each is observable; none can be
removed silently. That is the difference between a default and an invariant.
