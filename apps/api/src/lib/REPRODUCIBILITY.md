# Reproducibility Invariants

This document records the data-model and ordering invariants that must be
preserved to keep research studies reproducible across releases.

---

## 1. `createdAt` is append-only and immutable

Every model that exposes a `createdAt` field records **when the event
happened**, not when the row was last touched.  This field:

- is set once at insert (`@default(now())`) and **never updated**,
- must **not** be reused as a "last modified" timestamp — use `updatedAt`
  or `editedAt` for that purpose,
- is the sole allowed feed sort key (see Section 2).

### The `createdAt` / `editedAt` split

`Post` and `PostComment` carry both `createdAt` (immutable creation
timestamp) and `editedAt` (nullable, set on the first edit).  This
distinction is load-bearing:

- `createdAt` anchors the chronological feed ordering and is the key used
  in pagination cursors.
- `editedAt` surfaces to readers ("edited N minutes ago") without altering
  the post's position in the feed.

**Rule for new models:** any model that records user-generated content or
audit events **must** follow the same pattern — immutable `createdAt` plus
a separate `updatedAt` / `editedAt` where mutable timestamps are needed.
Do not repurpose `createdAt` as a rolling "last seen" field.

---

## 2. Declared, versioned feed ordering (`FEED_RANKING_VERSION`)

The feed is a **fixed, known treatment** for research purposes. The platform
invariant is **no covert engagement ordering**: every feed order must be
declared, versioned, and user-visible, and covert engagement-based ranking is
prohibited to prevent dopamine-driven scroll patterns and to keep research
conditions stable across cohorts and time periods.

Version 1 — chronological-only — is the **permanent default** and today the
only implemented ordering. It is the current mechanism, not a permanent
foreclosure of ranking: alternative rankers may be introduced as declared,
versioned, **user-chosen** treatments under the accountability contract in
`plans/pluggable-ranking/` (doctrine revision 2026-08-20; decision log in
`analysis/subtractive-filtering/06`). A future ranker must be deterministic
per version, honest about its optimization target, opt-in per feed (never a
silent default swap), legible to the user, and must not consume engagement
signals it has not declared.

The allowed sort field set is pinned in
`apps/api/src/lib/feed-pagination.ts`:

```typescript
// REPRODUCIBILITY INVARIANT — see REPRODUCIBILITY.md
export const ALLOWED_SORT_FIELDS = ["createdAt"] as const;

export const FEED_RANKING_VERSION = 1 as const;

export const FEED_RANKER_ID = "chronological@1" as const;
```

`FEED_RANKER_ID` is a human-legible name for the same fact
`FEED_RANKING_VERSION` carries as a bare integer — `{name}@{version}`. It
follows identical bump discipline: the `@N` suffix must always equal
`FEED_RANKING_VERSION`, and both change together, under the same sign-off.
It is returned as `ranker` on every feed response (`FeedResponse` in
`feed-handler.ts`; the circles feed in `circle-handler.ts`), and the
executed `ORDER BY` is derived from `ALLOWED_SORT_FIELDS` through
`FEED_ORDER_BY` rather than restated in the query; see
[`docs/concepts/feed-ordering.md`](../../../../docs/concepts/feed-ordering.md)
for the user-facing explanation of how the feed is ordered.

`FEED_RANKING_VERSION` must be bumped whenever:

1. `ALLOWED_SORT_FIELDS` gains or loses a field, or
2. Any new ranking, personalisation, or algorithmic ordering logic is
   introduced anywhere in the feed pipeline.

A version change constitutes a new experimental condition.  It must be:

- logged in the provenance manifest
  (`analysis/research-platform/` — doc 07),
- signed off by the research lead before merging,
- compliant with the pluggable-ranking accountability contract
  (`plans/pluggable-ranking/`): declared optimization target, deterministic
  per version, user-chosen, legible, no undeclared engagement inputs.

The companion test suite in
`apps/api/test/unit/feed-pagination.test.ts` (the
`"feed sort-field reproducibility invariant"` block) will fail if
`ALLOWED_SORT_FIELDS` or `FEED_RANKING_VERSION` drifts from the
expected values, giving a CI-level signal before code ships.

---

## 3. Scope of this document

This file covers **data-model invariants only**.  For the full research
codebook (scoring constants, edge-weight formulas, tier thresholds), see
`apps/api/src/lib/graph/SCORING-CODEBOOK.md`.
