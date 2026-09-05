---
title: Feed Ordering
description: How the Trellis feed is ordered, what counts on it are and aren't used for, and the no-covert-engagement-ordering invariant.
sidebar: Feed Ordering
order: 19
---

# Feed Ordering

Trellis's feed has one rule that matters more than any other: **the order you
see posts in is never a secret, and it is never driven by engagement.**

## How the feed is ordered today

The home feed is sorted **newest first, by `createdAt`, and nothing else.**
There is no relevance score, no engagement boost, no "you might like this"
re-ranking, and no per-user tuning of the order. Two posts get the same
position for every viewer who can see both of them, modulo pagination.

This is a deliberate, named, versioned mechanism, not an accident of the
current implementation:

- **`ALLOWED_SORT_FIELDS`** (`apps/api/src/lib/feed-pagination.ts`) is the
  complete list of fields the feed is allowed to sort by. Today it contains
  exactly one entry: `createdAt`.
- **`FEED_RANKING_VERSION`** (same file) is a version number for the ordering
  mechanism. It is `1` today, and `1` means exactly "chronological, newest
  first, no engagement inputs." Any change to how the feed orders posts —
  adding a sort field, introducing any kind of ranking or personalization
  that affects order — requires bumping this number.
- **`FEED_RANKER_ID`** (same file) is a human-readable name for the same
  fact: `"chronological@1"`. The part before `@` names the mechanism, the
  part after it is `FEED_RANKING_VERSION`. The two are always in lockstep —
  see the constant's doc comment for the discipline.

None of this is currently returned on the feed API response (`FeedResponse`
in `apps/api/src/lib/feed-handler.ts` carries no ranking-metadata field
today). If a ranking-metadata field is ever added to that response,
`FEED_RANKER_ID` is the value it should carry.

## What is — and isn't — used to order the feed

**Used:** `createdAt`, i.e. when the post was made. That's the whole list.

**Not used**, even though the platform tracks and displays these numbers
elsewhere:

- reaction/sentiment counts (see [Comment and reaction counts](#comment-and-reaction-counts) below)
- comment counts
- taxonomy/tag match quality
- any personalization signal

**Blocks narrow, too.** A [user block](../reference/blocks-api.md) removes
the other party's posts from the feed in both directions, as a `WHERE authorId
NOT IN (…)` conjunct inside the same paginating query, so the keyset cursor
stays exact. It changes which posts are eligible; it never touches the order.

**Personalization narrows, it does not reorder.** When a feed request opts
into personalization (matching a user's entities' taxonomy tags — e.g. life
stage or behavior tags), the server builds a database `WHERE` filter that
changes *which* posts are eligible to appear. It does not touch the *order*
those posts come back in — that's still `createdAt DESC`. An earlier version
of the personalization options interface (`PersonalizationOptions` in
`apps/api/src/lib/feed-personalization.ts`) declared two fields —
`boostByMatchCount` and `taxonomyWeight` — that read as if they controlled a
relevance score. Neither was ever wired to anything; they were removed, and
the interface now carries a comment forbidding any scoring-shaped option
from being added back, backed by a unit test
(`apps/api/test/unit/feed-personalization-options.test.ts`) that fails if
one reappears.

## Why: the no-covert-engagement-ordering invariant

Chronological-only ordering isn't a placeholder for a future engagement
feed — it's a standing platform invariant. Sorting by engagement (comment
counts, reaction counts, a computed relevance score) creates the same
dopamine-driven scroll dynamics Trellis is explicitly designed against, and
it does so *covertly*: users can't see or reason about why one post outranks
another. The rule is: **every feed order must be declared, versioned, and
user-visible.**

This isn't a permanent ban on any ranking other than recency — it's a ban on
*undeclared* ranking. A future ranker (for example something bridging-based
or prosocial) can be introduced, but only as an explicit, versioned,
**user-chosen** option that never silently replaces the chronological
default. See `plans/pluggable-ranking/` for that accountability contract.

The feed doubles as a fixed research treatment: because the ordering is
pinned and versioned, data collected under `FEED_RANKING_VERSION = 1` stays
comparable across cohorts and over time. Changing `ALLOWED_SORT_FIELDS` or
`FEED_RANKING_VERSION` is treated as a new experimental condition requiring
research-lead sign-off — see `apps/api/src/lib/REPRODUCIBILITY.md`.

## How it's enforced

- **`validateSortField()`** (`feed-pagination.ts`) rejects any sort field not
  in `ALLOWED_SORT_FIELDS` — engagement-metric field names like
  `sentimentCount`, `commentCount`, `score`, and `relevance` are explicitly
  tested as rejected.
- A CI-enforced test suite
  (`apps/api/test/unit/feed-pagination.test.ts`, the "feed sort-field
  reproducibility invariant" block) pins the exact expected values of
  `ALLOWED_SORT_FIELDS`, `FEED_RANKING_VERSION`, and `FEED_RANKER_ID`. If
  any of them drift, that test fails the build.
- A sibling test
  (`apps/api/test/unit/feed-personalization-options.test.ts`) pins the exact
  set of personalization option names and fails if a scoring-shaped name
  (matching `/score|weight|boost|rank|relevance/i`) is added.

## Comment and reaction counts

The feed shows a comment count and a reaction ("sentiment") count on each
post (`FeedPost.commentCount` and `FeedPost.sentimentCounts` in
`feed-handler.ts`). These numbers are **for display only** — see the
sections above for why they can never become sort inputs. Their exact
definitions:

- **`sentimentCounts`** — a per-post tally of reactions, keyed by reaction
  type (e.g. `{ "positive": 5, "negative": 2 }`). It counts every
  `PostSentiment` row for the post, including the post author's own
  reaction if they left one. Reactions have no soft-delete or moderation
  status in the schema — withdrawing a reaction deletes its row outright —
  so there is nothing to exclude here.
- **`commentCount`** — the number of comments on the post. It **excludes**:
  - comments the post owner has hidden (`hiddenByPostOwner`)
  - soft-deleted comments (`PostComment.deletedAt` is set)

  It does **not** exclude the post author's own comments — a reply from the
  post's author counts the same as anyone else's. There is no separate
  comment-moderation-status field in the schema to filter on beyond the two
  above.

  (Behavior note: prior to 2026-09, the `deletedAt` exclusion was missing —
  a soft-deleted comment stayed counted until it was hard-purged. Fixed with
  a regression test in `apps/api/test/unit/feed-handler.test.ts`.)

## See also

- `apps/api/src/lib/feed-pagination.ts` — `ALLOWED_SORT_FIELDS`,
  `FEED_RANKING_VERSION`, `FEED_RANKER_ID`
- `apps/api/src/lib/REPRODUCIBILITY.md` — the full reproducibility invariant
  and provenance-manifest process
- `apps/api/src/lib/feed-personalization.ts` — the taxonomy-filter
  personalization mechanism and its options
- `apps/api/src/lib/feed-handler.ts` — `FeedPost`, `FeedResponse`, and the
  `enrichPosts` computation of `commentCount` / `sentimentCounts`
