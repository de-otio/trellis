# Principles

What Trellis is for, and the design commitments that follow from it. For *how*
it is stewarded, see [`GOVERNANCE.md`](GOVERNANCE.md). This is a statement of
intent, not user documentation — for shipped behaviour see [`docs/`](docs/).

## What Trellis is for

The social layer of the internet has become a set of tenancies. To reach an
audience, an individual or a small organisation publishes *through* a platform
that has absorbed the institutional-scale costs of identity, distribution,
moderation, and trust — and in exchange surrenders control of distribution,
content, audience relationship, and any path off the platform with reach
intact. Trellis exists so that the social layer can be built as **public
infrastructure** instead: something a vertical runs *on*, not a landlord it
rents *from*.

This is a stronger claim than "open source." Open code that the world can read,
but with no governance and no reciprocity, still leaves power concentrated.
Trellis aims at the fuller position — sometimes called **Public AI / public
digital infrastructure**: openness *and* governance for accountability *and*
reciprocity that stops public value being privatised. The distinction matters:

- not **sovereign** (national-competitiveness) infrastructure,
- not merely **open-source** (openness at the code level only),
- not only **"ethical"** (harm-mitigation inside an extractive structure),
- but **public** — the full stack governed in the public interest, with private
  and commercial actors participating under reciprocal terms.

## Design commitments

These are the commitments the steward (see [`GOVERNANCE.md`](GOVERNANCE.md))
holds the project to. Some are already load-bearing in the architecture; others
are stated here so they are not quietly designed away as the project grows.
Where something is not yet built, it is marked as a commitment, not a feature.

### 1. Data sovereignty and portability

The people and entities represented in a Trellis instance are the locus of
rights over their data, not the operator. The core is multi-tenant with strict
tenant isolation (shipped — see
[`docs/security-and-privacy/`](docs/security-and-privacy/)), federates over
ActivityPub so identity and audience are not captive to one host (shipped — see
[`docs/concepts/activitypub.md`](docs/concepts/activitypub.md)), and is AGPL so
operators cannot close the source on their users. *Commitment:* first-class
export and account/graph portability, so leaving an instance never means losing
your audience or your data.

### 2. Differentiated access, not extraction

Openness is the default *where it serves the public interest* — individuals
read, publish, and move freely. But "open" need not mean "freely extractable at
industrial scale." *Commitment:* where bulk, automated, or commercial reuse of
the social graph would deplete the infrastructure that sustains it, access is
conditioned (attribution, transparency, reciprocity) rather than either
unrestricted or defensively shut. This avoids the binary of total openness vs.
defensive lockdown. See reciprocity in [`GOVERNANCE.md`](GOVERNANCE.md).

### 3. No engagement-maximising objective

Trellis has no built-in objective function that optimises for attention,
time-on-platform, or "engagement." Feed and recommendation behaviour is
provided by **pluggable strategies** a vertical chooses and can inspect (see
[`docs/concepts/architecture-overview.md`](docs/concepts/architecture-overview.md)),
not a hidden optimiser baked into the core. *Commitment:* the core will not ship
a default engagement-maximising ranker; surfacing diverse and relevant content
is preferred over maximising interaction.

### 4. Deterministic core; AI at the edges

The core is deterministic, typed, and verifiable. Intelligence is a capability
a vertical *calls*, not the engine the social graph runs through — the opposite
of the mainstream "AI-first" pattern in which a model becomes the primary
execution path and quietly optimises for engagement. *Commitment:* where AI is
genuinely useful, prefer **small, domain-specific models** with
**retrieval grounded in provenance-rich, documented sources** over opaque
general-purpose models — better traceability, lower cost, and far smaller
environmental footprint.

### 5. Provenance and authenticity

In a federated network, users should be able to trace and trust what they see.
*Commitment:* treat content provenance and authenticity as first-class —
persistent identifiers, verifiable credentials, and provenance that is legible
to both humans and machines — rather than bolting it on after the fact.

## A note on stance

These commitments describe how Trellis is built; they are not a creed imposed on
the verticals built on it. The core is genuinely generic. Trellis offers a
foundation that does not make its users into vassals — it does not tell anyone
what they should build.
