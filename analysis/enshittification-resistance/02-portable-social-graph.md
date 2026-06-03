# 02 — A portable social graph, not just a data dump

> **Leverage: highest.** This is Doctorow's #1 antidote (interoperability /
> right to exit) and Trellis's weakest surface.

## The gap

Trellis has comprehensive **deletion** and a JSON/atproto **export**
(`apps/api/src/lib/routes/export.ts`). But a data dump is not a right to exit.

> The thing that locks people into a social network is their **followers and
> relationships**, not their old posts. "You can leave, but you lose everyone
> you're connected to" *is* lock-in, by definition.

Two problems compound:

1. **The export is a dead artefact.** A user gets a file. Nothing in the design
   says another instance can *ingest* it. An export no one can import is
   theatre — it satisfies a GDPR checkbox without lowering the switching cost
   that actually disciplines the operator.
2. **Federation — the mechanism that makes exit *continuous* rather than a
   one-time dump — is deferred** and bit-rotting behind a flag (see
   [`analysis/redesign/06-activitypub.md`](../redesign/06-activitypub.md),
   Option A). The deferral reasoning is sound: the circles↔ActivityPub mapping
   is genuinely lossy (graduated relationship depth has no ActivityPub
   equivalent; WHISPER posts would leak the inner-circle social graph to remote
   servers). But the *consequence* is that Trellis retains the technical ability
   to trap users even though it currently chooses not to use it. Retained
   capability + future pressure = the enshittification setup.

## Why this is the highest-leverage change

Competition is one of Doctorow's four disciplining forces, and the **credible
threat** of low-friction exit disciplines the operator *even when nobody
actually leaves*. An export that can be re-imported elsewhere turns "we promise
to be good" into "we have to stay good because you can walk and take your graph."
That threat is worth more than any number of well-intentioned defaults.

## Design changes

### A. Make the export re-importable, and prove it in CI

- Define a documented, versioned export schema that includes the **relationship
  graph** (not just authored content): for each relationship, the counterpart's
  portable identifier, the connection method, and enough to re-establish the
  edge on a destination instance.
- Add a **round-trip test**: export account A → import into a fresh instance →
  assert the relationship graph and content are reconstructed. This is the
  invariant. An export format that isn't continuously proven importable will
  rot into a dump.

### B. Account-migration semantics for the graph (the Mastodon `Move` pattern)

Even without full live federation, the *graph* can be portable:

- A user leaving carries a **signed, portable list of their relationships** so a
  destination instance can re-establish them and notify counterparts (the
  `Move`/alias pattern Mastodon uses for account migration).
- Per `06-activitypub.md`'s own mapping table, **NORMAL-and-above** relationships
  map cleanly onto a follow/followers model — that is sufficient for a credible
  graph export without solving the full circles↔ActivityPub problem. WHISPER /
  inner-circle edges stay local-only (consistent with the existing
  social-graph-leak concern), and the export can mark them as such.

### C. Treat "credible exit" as a tested invariant, not a roadmap item

- The exit path (export → import → graph reconstruction) gets a standing test in
  CI, the same way the no-engagement-ranking guard does (doc 03). If a schema
  change breaks re-importability, the build fails. That is what makes it an
  invariant rather than a deferred nicety.

## Relationship to the federation deferral

This proposal **does not** reverse the decision to defer live ActivityPub
federation. It separates two things the redesign currently couples:

- **Live federation** (continuous interop with remote instances) — genuinely
  hard, genuinely fine to defer.
- **Portable exit** (a one-shot but re-importable graph export) — cheap now, and
  the part that actually delivers the competition/interop discipline.

You can have credible exit long before you have live federation. Ship the exit
first.
