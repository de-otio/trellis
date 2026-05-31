# Naming the Core

## Terminology

After the separation:

- **Trellis** — the generic, reusable social-network platform (accounts,
  feeds, follows, posts, entities, moderation, federation, monetization). Lives
  in its own private repo and is published as `@trellis/*` npm packages to AWS
  CodeArtifact.
- **Trellis** — the dog-focused vertical community. Depends on Trellis plus the
  `@trellis/ext-dogs` extension. Lives in this repo.

## Criteria

The name should:

1. **Not imply dogs or any specific vertical** — it's domain-agnostic
2. **Evoke community, connection, or platform** — it's social infrastructure
3. **Be short** (1-2 syllables ideal) — it appears in package scopes, CLI
   commands, config keys, and documentation
4. **Be available** as an npm scope and GitHub org (or close variants)
5. **Not collide** with well-known projects in the Node/TypeScript ecosystem
6. **Work as a brand** for an open-source project that others deploy

## Candidates

| Name | Meaning | Metaphor fit | Notes |
|------|---------|-------------|-------|
| **Kith** | Old English for friends/acquaintances ("kith and kin") | Social relationships are the core product | Short, memorable, uncommon. `@kith/core`. GitHub org taken but `kithsocial` is available. |
| **Trellis** | A lattice framework that supports climbing plants | The core provides structure; verticals grow on it | Strong metaphor for extensibility. `@trellis/core`. Two syllables. |
| **Agora** | Greek for gathering place / public square | A platform where communities form | Classical, widely understood. `@agora/core`. |
| **Hearth** | The center of a home; a gathering place | Warm, community-centered | `@hearth/core`. Evokes safety and belonging. |
| **Loom** | A frame for weaving threads together | Weaving social connections into a fabric | `@loom/core`. Short. Risk: Loom.com (video tool) is well-known. |
| **Polis** | Greek for city-state / community | Self-governing community | `@polis/core`. Risk: pol.is (civic tech tool) exists. |
| **Grove** | A small group of trees growing together | Communities as organic clusters | `@grove/core`. Natural, approachable. |
| **Plinth** | The base/foundation of a structure | The platform everything else stands on | `@plinth/core`. Architectural, precise. Less warm. |

## Decision: Trellis

**Trellis** — chosen 2026-04-05.

A trellis is literally a support framework that lets different things grow in
their own direction. It maps perfectly to the architecture: the core is the
trellis, extensions (dogs, plants, cars, whatever) are the vines.

- npm scope: `@trellis/*` (private, published to AWS CodeArtifact)
- GitHub: private repo (may open-source later)
- Extension interface: `TrellisExtension`
- Config type: `TrellisConfig`

The core will remain private initially. Trellis is the first vertical (core +
dogs extension).
