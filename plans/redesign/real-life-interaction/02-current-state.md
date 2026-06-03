# 02 · Current state: where the ingredients actually live

A grounded inventory (verified against the trellis and skybber trees,
2026-06-01). The headline: **the IRL-relevant engine is already in trellis
core**, generic, with no dog assumptions. Skybber consumes trellis as a
*published npm package* (`@de-otio/trellis` from npmjs.org) and adds only the
dogs extension. This is what makes the "migration" mostly a doc-and-build
exercise rather than a code move — see [`04-skybber-to-trellis.md`](04-skybber-to-trellis.md).

## Already in trellis core — generic, shipped

| Capability | Path(s) | Notes |
|---|---|---|
| **Concentric circles** (tiers, dual-gated visibility, glance, depth, mark-read) | `apps/api/src/lib/circle-handler.ts`, `routes/circles.ts`, `graph/neo4j-graph-service.ts`, `graph/circle-queries.md`; schema `CircleConfig` / `CircleReadState` / `PostRadius` | Fully generic. The only vertical piece is the *relationship type names* (see below). |
| **Proximity discovery** | `apps/api/src/lib/discovery-handler.ts` (rate-limited, hop-capped), `graph` `discoverNearby` | Generic for any entity type. Geo currently in the graph; [`../entity-location-subsystem.md`](../entity-location-subsystem.md) moves it to Postgres/PostGIS. |
| **Relationship scoring + decay** | `apps/api/src/lib/graph/scoring-engine.ts` | Blends manual/connection/interaction/extension signals + decay. Extensions inject signals via `RelationshipSignalProvider`. |
| **Entity-relationship CRUD + confirm/reject** | `apps/api/src/lib/entity-relationship-handler.ts` | Generic; relationship *types* are extension-supplied. |
| **`PostRadius`** (whisper/normal/loud/shout) | `prisma/schema.prisma` enum (line ~395) | User-controlled broadcast reach — a shipped feed-friction mechanism. |
| **Sentiment display modes** | `apps/api/src/lib/sentiment-display.ts` | De-gamifies engagement display. |

→ **Nothing to move here.** These are the substrate the IRL primitives build on.

## In core as placeholder schema — not yet live

| Field(s) | Path | State |
|---|---|---|
| `stealthMode`, `showOnlineStatus`, `showLastSeen`, `showTypingIndicator` | `prisma/schema.prisma:169–`​ | "FUTURE USE" booleans, no handlers. **Presence builds on these.** |
| `locationTrackingEnabled`, `locationAnonymizationLevel` | `prisma/schema.prisma:179–182` | Drive the location subsystem's exposure policy; not yet wired. |
| `Entity.lat` / `Entity.lng` | `prisma/schema.prisma` | Coarse coords; superseded by the PostGIS subsystem. |

→ **Build on these in place** — no move.

## Design-only — concept, no code

| Theme | Where | Generic? |
|---|---|---|
| Events / gatherings | skybber `doc/01-business/.../features-for-dog-events/prompt.md` (1-line stub: "dog shows, conventions…"); `.../gamification/opportunities/15-community-event-participant.md` | **Vertical-framed.** Generic kernel must be *extracted*, dog framing left behind. |
| Healthy-by-design (quiet hours, session limits, "you're caught up") | skybber `plans/003-safer-social-design/` | **Generic** — lives in the wrong repo. |
| Circles architecture rationale | skybber `doc/02-technical/architecture/14-graph-and-circles.md` **and** trellis `doc/02-technical/architecture/14-graph-and-circles.md` | **Already duplicated** across both repos — reconcile, don't re-copy. (Note: trellis has a numbering collision — two `14-` files — pre-existing, out of scope.) |

→ **Relocate / reconcile docs; build the missing primitives.** See bucket C and
B in [`04-skybber-to-trellis.md`](04-skybber-to-trellis.md).

## Genuinely vertical — must stay in skybber

| Artifact | Path | Why it stays |
|---|---|---|
| Dog relationship types (`PACK_MATE`, `SIBLING`, `PLAYMATE`, `WALK_BUDDY`, `PARENT`, `OFFSPRING`) | skybber `extensions/dogs/src/index.ts` (`entityRelationshipTypes`) | Domain vocabulary; core handles CRUD generically. (`WALK_BUDDY` is dog-framing of a generic activity-buddy idea — the *generic* concept may inform the "met in person" edge, but the name stays.) |
| Dog discovery facet instance (`{ field: "location", type: "geo" }`) | skybber `extensions/dogs/src/index.ts:66` | The `DiscoveryFacet` *type* is core; this *instance* is the dog's choice. |
| Breed signal provider, life-stage, taxonomy, recommendation strategy, dog metadata schema + terminology | skybber `extensions/dogs/src/*` | Pure dog domain. |

## The boundary, stated plainly

Trellis core = the generic platform (auth, posts, entities, circles, discovery,
proximity, scoring, feed, moderation, federation). Skybber = the dog vertical,
plugged in **only** through the extension API (`registerExtension`,
`TrellisExtension`: `terminology`, `metadataSchema`, `entityRelationshipTypes`,
`DiscoveryFacet`, `RelationshipSignalProvider`, route definitions, hooks).
Nothing dog-specific has leaked into core. The IRL primitives must preserve this
— every new core primitive ships a vertical-extension surface, never a hardcoded
domain assumption.
