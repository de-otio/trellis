# 03 · The four primitives

Each maps onto the existing three-store architecture (graph = relationships,
Postgres/PostGIS = geo, DynamoDB = ephemeral KV/TTL) — part of why they belong
in core. Two of the four (proximity, and the substrate for the others) already
exist; two (gathering, presence) are net-new. See
[`02-current-state.md`](02-current-state.md) for what's already shipped.

## 1. Gathering — a first-class core entity (time + place + RSVP)

A generic entity: `{ when, where, capacity, host, visibility, attendees[] }`.
Reuses the [entity-location subsystem](../entity-location-subsystem.md) for
`where` (no new geo). Visibility is **circle-scoped**, not public-by-default — a
gathering is shared to a relationship radius, reusing the existing `PostRadius`
semantics (whisper → shout).

- **Store:** Postgres (durable, relational; place via the location subsystem's
  point). RSVP is a join table; capacity + waitlist are plain columns.
- **Core vs vertical:** core owns the entity, the RSVP state machine, capacity,
  and circle-scoped visibility. Verticals supply *terminology and metadata
  schema* (skybber: "walk", "training session", "dog show", "adoption day") via
  the existing extension `metadataSchema` + `terminology` mechanism — exactly
  how entities are already extended. **No dog string enters core.**
- **Status:** net-new. Skybber's events stub is a 1-line dog-framed concept;
  the generic kernel is extracted to core (bucket B / the extraction step in
  [`04`](04-skybber-to-trellis.md)).

## 2. Presence — ephemeral "open to meet" signals

A lightweight, *expiring* state distinct from a post: "around this weekend,"
"free for a coffee/walk near X." Crucially **not** a broadcast and **not**
content — it carries no engagement surface (no likes/comments), so it can't
become a performance.

- **Store:** DynamoDB with **TTL** — the documented "temporary state with TTL
  for auto-cleanup" pattern. Presence is ephemeral by construction; it must not
  accrete history.
- **Builds on:** the existing `stealthMode` / `showOnlineStatus` placeholder
  fields (`schema.prisma:169–`) — presence is the live feature those fields were
  reserved for.
- **Core vs vertical:** core owns the signal type, TTL, and circle-scoping;
  verticals define the *activity vocabulary* (walk / play-date / ride) as
  metadata.
- **Safety:** opt-in, circle-scoped, TTL'd, and **never** exposes a point — only
  "available," resolved against proximity at query time under the location
  subsystem's exposure policy.
- **Status:** net-new (placeholder fields exist; no handlers).

## 3. Proximity — *consume*, don't rebuild

"People in your circle who are nearby and also open to meet." Already exists in
core (`discovery-handler.ts` + the graph `discoverNearby`), and is being moved
to PostGIS by the [location subsystem](../entity-location-subsystem.md). The IRL
layer adds **no new geo** — it composes the three stores:

```
nearby(entity_current_location)   -- Postgres/PostGIS, exposure-policed
  ∩ open-to-meet(presence)        -- DynamoDB TTL
  ∩ in-circle(relationship)       -- graph
```

- **Core vs vertical:** entirely core; the three-store merge is core plumbing.
  This is the strongest centralization argument — a vertical re-implementing it
  would re-derive the anti-triangulation controls and almost certainly get them
  wrong.
- **Hard constraint:** inherits `locationAnonymizationLevel` banding / snapping /
  k-anonymity verbatim. Proximity *nudges* (push) are gated behind explicit
  per-edge consent and off for minors.
- **Status:** shipped (geo move tracked separately). Nothing to migrate.

## 4. "Met in person" — a relationship edge that closes the loop

The linchpin. A graph edge/property recording that two parties **actually met**,
which:

- **strengthens connection weight** in the graph (met-IRL ranks above
  never-met-online) — feeds `scoring-engine.ts`,
- **feeds recommendations** ("strengthen ties you've met" beats "add strangers"),
- **becomes the engagement signal the feed rewards** (see below).

- **Store:** graph (Neptune) — it is a relationship fact, no geo, consistent
  with the Neptune decision.
- **Verification, deliberately lightweight (open question in [`05`](05-open-questions-and-sizing.md)):**
  1. **mutual confirmation** (both tap "we met") — simplest, consent-native;
  2. **co-attendance** (both RSVP'd + the gathering's time passed) — automatic,
     low-friction, no new sensing;
  3. **proximity handshake** (both opted-in + co-located in a window) — highest
     assurance, highest privacy cost.
  Lean 1+2. **Do not build a verification mechanism that is itself a
  surveillance mechanism** — option 3 is a last resort and must be opt-in.
- **Status:** net-new. (Skybber's `WALK_BUDDY` relationship type is dog-framing
  of a related idea, but the generic "met" edge is core.)

## The wellbeing payoff: reward the outcome, not the scroll

The healthy-by-design plans (`003-safer-social-design`, currently in skybber)
*suppress* addictive signals but don't say what the feed should *reward
instead*. These primitives supply the answer — **the offline outcome is the
positive signal**:

- attending a gathering you RSVP'd to,
- a confirmed "met in person,"
- a post made *after* a meetup, shared only to attendees (aftermath, not
  performative anticipation).

Consistent with "never rank on likes/comments/shares" — meeting someone is not a
vanity metric. It is core because it is a **feed-ranking input**, and ranking is
core.

**Named risk (must not skip):** gamifying meetups can manufacture a *new*
pressure vector — streaks, leaderboards, FOMO — betraying the whole thesis. The
signal must inform ranking quietly; it must **not** surface as a user-facing
score. Same failure mode the circles model prevents, one layer up. Enforcement +
test location is an open question in [`05`](05-open-questions-and-sizing.md).

## Core / vertical split (summary)

| Concern | Core (trellis) | Vertical (skybber, …) |
|---|---|---|
| Gathering entity, RSVP, capacity, circle-visibility | ✓ | terminology + metadata schema |
| Presence signal type, TTL, scoping | ✓ | activity vocabulary |
| Proximity query + three-store merge + exposure policy | ✓ | — |
| "Met in person" edge, weight, recommendation input | ✓ | — |
| Outcome-based ranking input | ✓ | — |
| Dog parks, walk routes, adoption days, breed meetups | — | ✓ (framing on the primitives) |
| Monetization (who may convene, paid events) | hooks only | ✓ policy |
