# 01 · S1 — Ranking as a declared, inspectable policy boundary

## Goal

Make the feed/ordering logic a single, named, documented policy object with an
explicit contract — so it is disclosable to a regulator, overridable per tenant,
and impossible for an extension to quietly turn into engagement ranking. **No
behaviour change** in the default path.

## Current state

Ordering is calm but inline and split across two feed paths:

- **Home feed:** `apps/api/src/lib/feed-handler.ts` `FeedHandler.getHomeFeed()`
  (~`:104-348`) — chronological `createdAt DESC`, visibility OR-logic
  (`:219-228`), optional taxonomy filter when `options.personalized` is set
  (`:288-327`).
- **Circle feed:** `apps/api/src/lib/circle-handler.ts` `handleGetFeed()`
  (`:41-85`) → `graphService.getVisiblePostIds(userId, tier, since, {limit,cursor})`
  — recency within a relationship tier.
- **Limits:** `apps/api/src/lib/feed-pagination.ts` `getPaginationConfig(ageTier)`
  (`:28-69`) and `validateSortField()` (`:61`) which **already rejects any sort
  field except `createdAt`** — the anti-engagement guard exists, just buried.
- **Personalization:** `apps/api/src/lib/feed-personalization.ts`
  `getEntityTaxonomyTags()` (`:61-121`).
- No `FeedStrategy` type remains; no per-tenant configurability.

## Design

Introduce `apps/api/src/lib/feed/ranking-policy.ts` — one module that **owns the
ordering contract** and is the only thing the two feed paths call for ordering
decisions:

```ts
// The documented, disclosable contract. Pure, no I/O.
export interface RankingPolicy {
  readonly id: string;                 // e.g. "calm-recency-v1"
  readonly description: string;        // human/regulator-readable
  readonly orderBy: "createdAt";       // union is deliberately a single value
  readonly direction: "desc";
  readonly rankingInputs: readonly RankingInput[]; // what MAY influence order
  paginationFor(ageTier: AgeTier): PaginationConfig; // absorbs feed-pagination
  validateSortField(field: string): boolean;         // absorbs the guard
}

// The only ranking inputs the platform permits. Engagement signals are absent
// BY CONSTRUCTION — there is no enum member for likes/comments/shares/views.
export type RankingInput = "recency" | "relationshipScore" | "circleTier";
```

- The **default** export `CALM_RECENCY_POLICY` reproduces today's behaviour
  exactly (recency desc; relationship score / tier only gate *which* tier a post
  lands in, never *order within* a tier).
- `feed-pagination.ts`'s `getPaginationConfig` and `validateSortField` **move
  into / are re-exported through** the policy so there is one source of truth.
- Both feed paths import the policy instead of hardcoding `createdAt DESC` and
  the limits.

### Tenant seam (shared with S3)

Add the cross-cutting tenant-policy config (introduced here, reused by
[`03`](03-notification-policy.md)):

- **Schema:** `policy Json?` on `Tenant` (`prisma/schema.prisma:1515`). One
  nullable column; no backfill.
- **App layer:** `apps/api/src/lib/tenant/tenant-policy.ts` — a Zod schema
  `TenantPolicySchema` with a `ranking` sub-object (`{ policyId?: string }`) and
  a loader `getTenantPolicy(tenantId, env): Promise<TenantPolicy>` that returns
  validated config **merged over platform defaults** (so `null`/absent ⇒
  defaults). A registry `RANKING_POLICIES: Record<string, RankingPolicy>` maps
  `policyId` → policy; unknown id falls back to default + logs.
- For the MVP the only registered policy is `CALM_RECENCY_POLICY`; the seam means
  S8's "calm tenant preset" and any future variant is a registry entry, not a
  code change.

### Extension guard

The extension feed hook (`FeedPersonalization` static method) may only *filter*
candidate posts, never *reorder* them. Add an assertion/contract comment and a
test that a personalization result preserves chronological order of the inputs.

## Changes

| File | Change |
|---|---|
| `apps/api/src/lib/feed/ranking-policy.ts` | **new** — interface, `CALM_RECENCY_POLICY`, ranking-input enum |
| `apps/api/src/lib/feed-pagination.ts` | move `getPaginationConfig`/`validateSortField` behind the policy (re-export for back-comat) |
| `apps/api/src/lib/feed-handler.ts` | call `policy.orderBy`/`paginationFor`/`validateSortField` instead of inline literals |
| `apps/api/src/lib/circle-handler.ts` | use the policy's ordering contract for tier ordering |
| `apps/api/src/lib/tenant/tenant-policy.ts` | **new** — Zod schema + `getTenantPolicy` loader + registry |
| `prisma/schema.prisma` | add `policy Json?` to `Tenant` + migration |

## Tests

- **Behaviour-parity (critical):** snapshot current home-feed and circle-feed
  ordering + pagination for CHILD/TEEN/ADULT fixtures; assert identical after the
  refactor.
- `validateSortField` still rejects `likes`, `score`, `engagement`, etc.
- Tenant with no `policy` ⇒ default policy; tenant with unknown `policyId` ⇒
  default + a logged warning.
- Extension personalization cannot reorder (order-preservation test).

## Effort / priority

Low–medium. **Priority: medium.** Mostly mechanical extraction; the value is the
auditable boundary + the tenant seam that S3/S8/S6 reuse.
