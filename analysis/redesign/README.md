# Trellis Core Redesign — Analysis

> **Status (2026-04-12):** graph DB choice is now Neo4j AuraDB, not Neptune. See trellis `memory/project_graph_db_decision.md`.

This analysis explores replacing Trellis's feed/follow/post social model with a relationship-depth-first model based on concentric circles, finite content views, and posting radius.

**Context**: Neither Trellis nor any vertical (Trellis) is live. There are no users, no production data, no backward compatibility constraints. Everything can change.

**Origin**: [Brainstorming session](../../analysis/redesign/social-media-app-brainstorm.md) in the Trellis repo, subsequently scoped as a Trellis core redesign rather than a Trellis-specific UI change.

## Documents

| # | Document | Description |
|---|----------|-------------|
| 01 | [Current Primitives](01-current-primitives.md) | What the social model looks like today and what's affected |
| 02 | [New Core Primitives](02-new-core-primitives.md) | Circles, relationship scoring, posting radius, finite views |
| 03 | [Schema Design](03-schema-design.md) | Concrete Prisma model additions and modifications |
| 04 | [API Surface](04-api-surface.md) | New endpoints, deprecated endpoints, migration path |
| 05 | [Extension Architecture Impact](05-extension-impact.md) | What changes for verticals built on Trellis |
| 06 | [ActivityPub Compatibility](06-activitypub.md) | How circles map (or don't) to federation |
| 07 | [Safer-Social Alignment](07-safer-social-alignment.md) | How the redesign resolves gaps from the safer-social analysis |

## Decisions Made (in Trellis redesign)

These Trellis docs were written first. Several open questions have since been resolved in the Trellis redesign analysis. The documents below have been updated with cross-references, but the canonical decisions are:

- **Graph database**: Hybrid Postgres + Neptune Serverless. Relationships and entity graphs in Neptune (CDK-managed); content and transactional data in Postgres. See [Trellis 07-graph-database/](link-to-trellis).
- **Entities over people**: In entity-centric verticals (dogs, plants, cars), entities are the primary social objects — circles contain entities, posts are *about* entities, discovery is entity-first. See [Trellis 06-entities-over-people/](link-to-trellis).
- **Entity-centric circles**: Content filtering is dual-gated — a post is visible if the viewer has a relationship with a subject entity OR the author. Entity relationships are primary.
- **Co-ownership**: Entities can have multiple owners via an EntityOwnership junction table (PRIMARY_OWNER, CO_OWNER, CARETAKER roles).
- **B2B presence model**: Businesses live in a Places layer (map + directory), not in circles. See [Trellis 04-b2b-in-circles.md](link-to-trellis).
- **ActivityPub**: Defer federation until circles model is validated.
- **Flutter**: Staying on Flutter, no React prototype.

## Remaining Open Questions

- **Relationship scoring weights**: Exact weight tuning for interaction frequency, reciprocity (user→user), engagement depth (user→entity), time decay.
- **Circle granularity**: Fixed tiers (inner/middle/outer) vs. continuous distance with UI-defined thresholds. Current proposal: 4 fixed tiers with configurable thresholds.
- **Posting radius semantics**: Discrete levels (whisper/normal/loud/shout) is the current proposal.
