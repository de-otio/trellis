# Slop Detection and Edit-Distance Tracking

**Date:** April 2026
**Status:** Exploratory analysis

---

A one-tap "generate content" feature points directly against two things a
quality-focused platform usually wants: **a feed that is not flooded with
low-effort AI output**, and **no addictive engagement patterns**. This document
specifies the generic infrastructure that lets a consuming application offer
AI-assisted suggestions without degrading feed quality — edit-distance
tracking, disclosure flags, rate limiting, perceptual-hash dedupe, and a feed
down-ranking signal. The consuming application decides its own thresholds and
its own product commitments; the mechanisms here are domain-agnostic.

## 1. The slop risk, concretely

Three failure modes to watch for:

### 1a. Low-effort posts

A user uploads media, taps "suggest", taps the first option, taps post. No
thought, no editing. The feed fills with content that is competent but
indistinguishable — every post starts to sound like the same ghost.

**Mitigations:**
- **Default action is "Edit before posting"**, not "Post". A UI-level friction
  choice the consuming application owns.
- **Edit-distance tracking.** Record the Levenshtein distance between the
  suggested text and the posted text. Posts with distance 0 (zero-edit) get a
  stronger AI-disclosure treatment; posts with meaningful edits get a softer
  one. Users can see both states on their own posts.
- **Quality floor on suggestions.** Instruct the model never to output a
  suggestion under N characters, and maintain a hardcoded list of banned boring
  openers. If all N suggestions fail the floor, show "couldn't think of
  anything good — try different media?" and do not offer a generic fallback.

### 1b. Content farming

A mass account scrapes media, taps through, and produces N AI-captioned posts.
Classic spam playbook.

**Mitigations:**
- **Rate limit the feature, not just the post endpoint.** Per-user budget of
  e.g. N suggestion calls per day. Exceeding it hides the button for 24h; it
  does not block manual posting.
- **Perceptual-hash the media.** If the same user submits many visually distinct
  media in an hour with suggest-on for each, that is a signal; if the media are
  all reverse-image-search hits from stock libraries, that is a different
  signal. Both feed a slop-scoring pipeline.
- **No public API surface.** The suggestion endpoint is authenticated-user-only,
  bound to a session, not exposed to third-party apps. There is no public
  `POST .../generate` — it is an internal compose-flow call.

### 1c. Feedback-loop homogenisation

Once this exists, users see other users' AI-assisted posts, internalise the
style, and start writing that way. The whole community voice drifts toward the
style guide. Subtle and hard to measure.

**Mitigations:**
- **Vary the tone-tag rotation.** Don't always return the same N tones. The
  prompt should pick from a larger pool (e.g. ~15).
- **Periodic review of the style guide.** Once there is a sizeable active
  cohort, pull a random sample of AI-assisted posts and manually review for
  drift. The style guide is a living document.
- **Watch the posting distribution.** If the share of posts with
  `ai_assisted=true` trends past a threshold (e.g. ~30%), reconsider the
  surface area of the feature (hide the button more, require a second explicit
  tap).

## 2. The addictive-design risk

A suggestion generator with a "give me another" loop has a slot-machine shape:
every tap is a small variable reward, and funnier output juices engagement.
A platform that has committed to not using addictive patterns has to constrain
this deliberately.

**Mitigations (treat as non-negotiable in any shipped version):**

- **Hard cap on regenerations per media item per day** (e.g. 3). After that,
  the shuffle action is disabled with a cheerful "these were our best — pick
  one or write your own". This breaks the slot-machine loop.
- **No suggestion-quality scoring visible to the user.** Do not show "this will
  get you more engagement" or anything that turns suggestion choice into an
  engagement-optimisation game.
- **No leaderboard of top AI-assisted posts.** Internal metrics are fine;
  surfacing "trending AI-assisted posts" as a feed category is not.
- **Respect any non-engagement-metric design.** If the platform deliberately
  avoids like-count-style metrics, make sure the feature does not regress that
  (e.g. no "will this get positive sentiment?" prediction).

## 3. Disclosure

Disclosure is the contract that keeps the feature honest:

- Every post that used a suggestion is tagged `ai_assisted` at the data layer.
- The UI shows a badge ("AI-assisted") — the exact visual treatment is a design
  call but it is never hidden.
- The badge persists even if the user later edits the caption — once AI was in
  the loop, disclosure is permanent.
- Feed ranking will likely deprioritise AI-assisted posts relative to
  fully-human ones, per a "prioritise human-created content" principle. The
  exact weight is an open question the consuming application decides.

## 4. What this looks like if it goes right

A user who posts several times a week might use the suggestion feature once or
twice, usually when they already have media but can't think of anything to say.
They tap, see a few options, pick one, edit a word or two, post. The post is
marked AI-assisted and performs slightly worse in-feed than their unaided posts
because of the ranking weight, which keeps the overall incentive gently against
over-use. They keep the feature around for the occasional moment they're stuck.

The feature is **a writing aid for people who already have something to share**,
not a content factory.
