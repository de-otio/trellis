# Integrating the "AI expands the tenant class" thesis into Trellis

This folder investigates how the argument developed in
[`dot-notes/doc/topics/techno-feudalism/ai-expands-tenant-class/`](../../../dot-notes/doc/topics/techno-feudalism/ai-expands-tenant-class/)
should shape Trellis as a substrate. The source argument is internal
strategy; this folder is the Trellis-side translation: what changes (if
anything) about the API surface, defaults, roadmap, and packaging once
the thesis is taken seriously.

## The thesis in one paragraph

AI lowers the cost of being a *producer* without lowering the cost of
being *seen, paid, or independent*. So it expands the population of
people who depend on platforms while the platforms (and the layers
below them) consolidate further. The map of who pays rent gets larger;
the map of who collects it does not. Full argument in the source's
[README](../../../dot-notes/doc/topics/techno-feudalism/ai-expands-tenant-class/README.md).

## What the source says about Trellis specifically

§5.4 of the source
([`05-implications-for-de-otio.md`](../../../dot-notes/doc/topics/techno-feudalism/ai-expands-tenant-class/05-implications-for-de-otio.md))
names five surface-design defaults the substrate should bake in early
because they are hard to retrofit:

1. **Identity portable by default** — not bolted on as an export feature.
2. **Graph data exportable in standard formats** — from day one.
3. **Federation hooks first-class** — ActivityPub or comparable, not a
   future-roadmap aspiration.
4. **Inference-provider abstraction** — wherever AI is used, no hard
   dependency on a single foundation-model provider.
5. **Mündig-derived deliberative primitives** as available building
   blocks even if not all consumers adopt them.

§5.4 also raises a packaging question: whether Trellis should be
positioned as "the social-network plumbing your AI agent can't generate
for you in a weekend" — i.e. deliberately targeted at the vibe-coder
population the BI article describes. That decision affects defaults,
docs, and tool-call surfaces, and is treated separately from the
five-property audit above.

§5.1's binary test applies to every Trellis roadmap item:

> Does this product help the producer **escape** tenancy, or does it
> help them **operate as a tenant more efficiently**?

Both are valuable; only the first is anti-feudal. The test does not
forbid the second; it forbids it from crowding out the first.

## Scope of this investigation

In scope:

- Audit Trellis' current state against each of the five §5.4 properties:
  what exists, what is partial, what is absent, what would be hard to
  retrofit later.
- Identify the API-surface defaults that bake in (or foreclose) each
  property. Defaults are the load-bearing decision; opt-in features are
  not.
- Translate the §5.1 test into a roadmap-evaluation rubric usable
  against the existing Trellis backlog.
- Decide-or-defer on the vibe-coder packaging question, since it
  changes which defaults matter most.
- Surface the Mündig coupling question (also flagged in §5.5) since
  any deliberative-primitive answer depends on it.

Out of scope here (live elsewhere):

- The consumer-vertical engineering-allocation audit (chrome vs. non-cloneable) —
  belongs in the consumer-vertical repo, not here.
- External publication drafts — §5.7 candidates are a De Otio gGmbH
  concern, not a Trellis-substrate concern.
- The corporate-structure / two-entity questions.

## Planned files

This is the planned shape; files get added as the audit proceeds.

1. `01-current-state-audit.md` — Trellis today against each of the
   five §5.4 properties. What's in `prisma/`, `apps/api/src/lib/`, the
   federation scaffolding, the extension-api package. Gaps and
   already-baked-in wins.
2. `02-identity-portability.md` — deep dive on §5.4 property 1. The
   recent identity-federation v0.7 work (commit `23acf35`) is the
   substrate; this asks whether portability is a *default* or an
   opt-in, and what an export/handoff surface would look like.
3. `03-graph-export.md` — deep dive on §5.4 property 2. What standard
   formats are candidates (ActivityStreams, ActivityPub Outbox dumps,
   social-graph-specific formats), and the Prisma-schema/API
   implications.
4. `04-federation-first-class.md` — deep dive on §5.4 property 3.
   ActivityPub is currently feature-flagged off by default per
   [CLAUDE.md](../../CLAUDE.md). The thesis argues that default is
   wrong for an anti-feudal substrate; this file argues the case both
   ways and proposes a defaults-change (or doesn't).
5. `05-inference-abstraction.md` — deep dive on §5.4 property 4. What
   in Trellis currently calls a foundation model, what the abstraction
   boundary should be, and whether the multi-tenant identity work has
   any lessons that transfer.
6. `06-deliberative-primitives.md` — deep dive on §5.4 property 5 and
   §5.5. Depends on the Mündig coupling decision; may need to flag
   that as a prerequisite rather than answer it here.
7. `07-vibe-coder-packaging.md` — the §5.4 packaging question. Two
   futures (substrate-for-vibe-coders vs. substrate-for-serious-
   operators) with the documentation and defaults implications of
   each.
8. `08-roadmap-rubric.md` — §5.1 test operationalised as a
   roadmap-evaluation rubric. Applies it to the current backlog as a
   worked example.
9. `09-recommendations.md` — synthesis: which defaults to change now,
   which to defer with explicit justification, which questions remain
   blocked on Mündig or consumer-vertical decisions.

## Relationship to other analysis folders

- [`generic-core/`](../generic-core/) — overlaps on the
  "Trellis-as-substrate" question. The §5.4 properties sharpen what
  "generic core" should mean (anti-feudal defaults, not just
  vertical-agnostic plumbing).
- [`safer-social-design/`](../safer-social-design/) — overlaps on
  governance primitives. Mündig-derived deliberative properties are a
  superset of the safer-design defaults; the Mündig coupling question
  is the bridge.
- [`monetization/`](../monetization/) — overlaps on §5.3's pricing
  point (anchor against counterfactual platform rent, not infrastructure
  cost). That part lives in monetization; this folder cites it but does
  not duplicate.

## Caveat

The source argument is a *working* argument, not a finished one. §5.9
lists the falsifying conditions; treat anything in this folder as
contingent on those not having come true. If two or more falsifiers
land within a 2–3 year window, this whole folder needs a re-read.
