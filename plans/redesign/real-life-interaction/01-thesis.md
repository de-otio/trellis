# 01 · Thesis: promoting real-life interaction is a core decision

Trellis defines "healthy" almost entirely *negatively* — anti-addiction
guardrails (feed friction via `PostRadius`, relationship decay, glance mode, no
engagement-ranking, the concentric-circles model). This is the *positive* half:
a small set of generic primitives whose purpose is to **convert online
connection into offline connection**.

## Why this belongs in core, not a vertical

The circles model was already declared "a Trellis-level decision every vertical
inherits — the app's structure should make unhealthy patterns mechanically
impossible." Promoting real-life interaction is the same kind of decision, for
the same reasons:

1. **It's a cross-vertical property of "healthy," not a domain feature.** A dog
   app, a hobby app, and a neighbourhood app all want online connection to
   spill into the real world. If each vertical reinvents events / presence /
   proximity, the *value alignment* lives in product copy, not in the platform.
2. **The primitives are shared and safety-critical.** Proximity and presence
   are the highest-risk surfaces on the whole platform (stalking, location
   triangulation, minors under KOSA). They warrant **one well-audited
   implementation** that inherits the
   [exposure-policy posture](../entity-location-subsystem.md#the-central-decision-store-precise-control-exposure-at-query-time),
   not N per-vertical ones.
3. **The loop only closes at the graph + feed layer**, both of which are core.
   "Did this connection meet in real life?" is a relationship fact (graph);
   "reward the meeting, not the scroll" is a feed-ranking input. Verticals can't
   own either.

## The corrected framing (see [`02-current-state.md`](02-current-state.md))

The original sketch assumed the IRL ingredients lived in skybber and needed
"moving" into trellis. The inventory shows the opposite: **the generic engine
is already in core** (circles, proximity discovery, relationship scoring,
`PostRadius`, glance, decay, sentiment-display, plus presence *placeholder*
fields). Skybber is thin — essentially just the dogs extension.

So the thesis sharpens: this is not a migration. It is **(a) promoting an
implicit value into an explicit, named core capability, (b) building the two
primitives that genuinely don't exist yet — gatherings and presence — directly
in core, and (c) relocating the generic design rationale that currently sits in
skybber's doc tree so the platform owns it.** What moves is mostly *docs and
decisions*, not code.

## The shape of the positive half

Four primitives, detailed in [`03-primitives.md`](03-primitives.md):

1. **Gathering** — a first-class core entity (time + place + RSVP).
2. **Presence** — ephemeral "open to meet" signals (TTL'd, no engagement
   surface).
3. **Proximity** — *consumes* the existing location subsystem; no new geo.
4. **"Met in person"** — a relationship edge that strengthens tie weight and
   becomes the feed's positive signal — the linchpin that closes the loop the
   healthy-by-design work leaves open.
