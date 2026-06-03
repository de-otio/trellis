# 05 · Open questions, risks, and sizing

## Open questions

- **"Met in person" verification (v1 scope).** Which of the three options ship
  first — mutual-confirm, co-attendance, proximity-handshake? (Leaning
  mutual-confirm + co-attendance; proximity-handshake deferred and opt-in.) See
  [`03-primitives.md`](03-primitives.md) §4.
- **Presence model in DynamoDB.** Single-table key design + TTL granularity, and
  how presence intersects the circle radius without a full scan. (Ties into
  `doc/02-technical/architecture/11-dynamodb-single-table.md`.)
- **Gathering visibility ↔ circles.** Exact mapping of gathering visibility onto
  `PostRadius`, and whether a gathering can be *discoverable* to non-connections
  (a public meetup) without leaking the host's location — resolved via the
  location exposure policy, but needs a concrete posture.
- **Minor safety.** Default-off matrix for presence, proximity nudges, and
  discoverable gatherings for under-18 accounts (ties into the KOSA framing in
  the `003-safer-social-design` docs being relocated).
- **Anti-gamification guardrail.** *Where* the "outcome signal informs ranking
  but is never surfaced as a score" rule is enforced in `feed-handler.ts` /
  `scoring-engine.ts`, and how it's tested (a test that fails if the signal
  becomes user-visible).
- **Doc reconciliation specifics.** The two `14-graph-and-circles.md` copies and
  the numbering collision in trellis's `architecture/` folder — confirm the
  canonical copy and what (if anything) skybber keeps. (Numbering collision is
  pre-existing and out of scope for this work, but worth flagging while in there.)
- **Extension-api shape.** The concrete new types/hooks for registering
  gathering kinds + presence vocab, and whether they fit in a minor extension-api
  bump or force a breaking change (affects the skybber coordination in
  [`04`](04-skybber-to-trellis.md)).

## Risks

- **Privacy/safety is the dominant risk.** Presence + proximity + discoverable
  gatherings are the platform's highest-exposure surfaces. Every one inherits
  the location subsystem's exposure policy; none ships with minor-safe defaults
  unresolved.
- **Re-introducing an addiction vector.** The wellbeing payoff (reward the
  offline outcome) becomes harmful the moment it's surfaced as a score/streak.
  The guardrail above is not optional.
- **Doc drift.** The existing two-copy `14-graph-and-circles.md` is proof that
  blind duplication drifts. Bucket C uses pointers, not copies, for this reason.

## Sizing (rough, pending v1 scope)

| Step | Rough size | Notes |
|---|---|---|
| C · Doc reconciliation | ~0.5–1 day | No code; mechanical relocation + pointers |
| B · Gathering + RSVP | ~3–5 days | New entity, RSVP state machine, circle-scoped visibility; stands on existing substrate |
| B · Presence | ~2–3 days | Handlers over existing placeholder fields + DynamoDB TTL |
| Extension-api surface | ~1–2 days + coordination | Coordinated bump with skybber |
| B · "Met in person" edge + weight | ~2–4 days | Plus verification-approach research |
| B · Outcome-based ranking input | ~2–3 days | Feeds `scoring-engine` / `feed-handler` |
| B · Quiet hours / session-awareness / "caught up" | ~3–5 days | Largely design-complete in the relocated docs |

Proximity (primitive 3) is **not sized here** — it's already shipped and its geo
move is costed in [`../entity-location-subsystem.md`](../entity-location-subsystem.md).

End-to-end verification of every primitive happens in **skybber's** environment
after the dependency bump (trellis isn't deployed standalone).
