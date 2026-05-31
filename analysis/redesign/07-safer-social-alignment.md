# 07 — Safer-Social Alignment

How the circles redesign addresses the gaps identified in `analysis/safer-social-design/`.

---

## Background

Trellis has an existing safer-social-design analysis (6 documents) that identified harmful design patterns in social media and proposed mitigations. Several mitigations are already implemented (sentiments instead of likes, chronological feeds, poll-based notifications). Others are listed as gaps.

The circles redesign addresses many of these gaps structurally — not as features bolted on, but as inherent properties of the interaction model.

---

## Gap Resolution

### Infinite Scroll / Doomscrolling

**Safer-social gap**: Feed is infinite. Proposed mitigations were friction mechanisms (session duration warnings, digest mode, "you've been scrolling for X minutes" nudges).

**Circles resolution**: **Structurally eliminated.** Every circle has a finite content set and a server-enforced "you're caught up" endpoint. There is no infinite scroll because there is no infinite content stream. The user sees all content in a tier, gets the completion signal, and is done.

**Strength**: This is the strongest possible mitigation — it makes the harmful pattern mechanically impossible, not just discouraged. No opt-in required, no settings to configure, no nudges to ignore.

### Engagement-Optimized Feeds

**Safer-social gap**: Algorithmic feeds optimize for engagement, which selects for outrage, controversy, and emotional manipulation.

**Circles resolution**: **Structurally eliminated.** Content within a circle is chronological. There is no ranking algorithm. The circle structure (relationship depth) determines WHICH content you see, but within a tier, ordering is purely temporal.

**Strength**: Extensions cannot reintroduce algorithmic ranking — `FeedStrategy` is removed. The only ranking input is the relationship score, which is transparent and user-adjustable.

### Unclear Audience / Pressure to Perform

**Safer-social gap**: Users don't know who will see their posts. The implicit audience is "everyone," creating pressure to craft engagement-optimized content.

**Circles resolution**: **Addressed by posting radius.** When creating content, users explicitly choose how far their voice carries (whisper/normal/loud/shout). The default is NORMAL (close friends + inner circle), not SHOUT (everyone). Users know their audience before posting.

**Strength**: Changes the content creation incentive from "maximize reach" to "speak to the people who matter." Most content is naturally private or semi-private.

### Open-by-Default Privacy

**Safer-social gap**: New accounts are public by default. New posts are visible to all followers by default.

**Circles resolution**: **Addressed by design.** New relationships start at community or ambient distance. New posts default to NORMAL radius (tiers 0–1). The user must actively choose to broadcast widely.

### Re-engagement Notifications

**Safer-social gap**: Push notifications designed to pull users back ("X posted for the first time in a while").

**Circles resolution**: **Orthogonal but complementary.** Notifications are already poll-based (no push). The circles model adds: notifications are scoped to tier. Inner circle activity can generate notifications; ambient tier activity cannot. This prevents the "someone you barely know did something" notification pattern.

### Quantified Social Validation

**Safer-social gap**: Like counts, follower counts, view counts create social pressure and comparison.

**Circles resolution**: **Partially addressed.** Follower/following counts are removed (replaced by relationship count, which is less gamifiable). Sentiments (11 types) remain but don't aggregate into a single score. However, circles don't inherently prevent sentiment count visibility — that's still a separate design decision.

**Remaining gap**: Consider whether sentiment counts should be visible to anyone other than the post author.

### Minor Safety (Age-Gating, Parental Controls)

**Safer-social gap**: Age verification, parental consent, content filtering for minors.

**Circles resolution**: **Independent.** The circles model doesn't specifically address minor safety. However, the finite content model (daily deck, "caught up" signals) naturally limits usage time without needing explicit time-limit enforcement. And the inner-circle-first model means minors primarily see content from people they know.

The existing age-gating infrastructure (`AgeTier`, `ParentalLink`, age-gate middleware) remains unchanged and works alongside circles.

---

## New Protections Enabled by Circles

The circles model enables protections that weren't possible with the feed model:

### 1. Stranger Friction

In the feed model, followed content and discovered content are structurally identical. In the circles model, engaging with someone outside your community tier requires an explicit "explore outward" action. Strangers can't compete for attention with close friends.

### 2. Reciprocity Visibility

Users can see whether a relationship is reciprocated. If Alice considers Bob inner-circle but Bob considers Alice ambient, Alice can see this asymmetry in the graph view. This prevents parasocial relationship patterns (following a celebrity and feeling "close" because their content appears in your feed).

**Note for entities**: Reciprocity doesn't apply to user→entity relationships (a dog can't reciprocate). Entity relationship scoring uses engagement depth instead. See [Trellis scoring without reciprocity](../../trellis/analysis/redesign/06-entities-over-people/09-scoring-without-reciprocity.md).

### 3. Audience Transparency

The posting radius is visible to the viewer. When you see a post, you can see whether it was whispered (directed at inner circle) or shouted (broadcast to everyone). This provides context about the author's intent and prevents the illusion that a broadcast post was personally directed.

### 4. Natural Usage Boundaries

The "caught up" signal across all tiers creates natural stopping points. Unlike a time-limit nudge (which feels like external control), reaching the end of your content is an intrinsic state (nothing left to see). This is psychologically different — completion feels satisfying, not restrictive.

---

## Gaps Still Open After Redesign

| Gap | Status | Notes |
|-----|--------|-------|
| Age verification at signup | Open | Not addressed by circles |
| Parental consent workflows | Open | Not addressed by circles |
| Sentiment count visibility | Open | Should counts be author-only? |
| Link security (phishing) | Unchanged | Existing system works alongside circles |
| Content screening | Unchanged | Existing system works alongside circles |
| Trust scoring / impersonation | Open | Relationship scores help (real friends have high scores) but don't solve account impersonation |
| Session duration awareness | Partially addressed | "Caught up" is a natural stop, but no explicit time tracking |
| Community moderation tools | Open | Groups need moderation; circles don't (they're personal) |

---

## Summary

The circles redesign **structurally resolves** the three most significant safer-social gaps:
1. Infinite scroll → eliminated by finite circles with completion signals
2. Engagement-optimized feeds → eliminated by chronological ordering within relationship-depth tiers
3. Unclear audience → addressed by explicit posting radius

These aren't features that can be disabled or worked around. They're properties of the interaction model itself. That's the difference between "adding a screen-time warning" and "building an app where there's nothing to scroll past."
