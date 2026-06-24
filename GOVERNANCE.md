# Governance

This document describes how Trellis is stewarded and what is expected of those
who build on it. It complements — and does not override — the legal terms in
[`LICENSE`](LICENSE), [`COMMERCIAL.md`](COMMERCIAL.md), and [`CLA.md`](CLA.md).
For *why* Trellis is built this way, see [`PRINCIPLES.md`](PRINCIPLES.md).

## Stewardship

Trellis is currently maintained by Richard Myers, trading as de-otio. The
intent is for **De Otio's public-benefit entity (a planned gGmbH)** to hold
stewardship of the open core once established, so the public core has an
institutional home whose mandate is the public interest rather than any single
product's commercial success.

Stewardship means responsibility for the AGPL core's direction, security, and
long-term sustainability — and for keeping the design commitments in
[`PRINCIPLES.md`](PRINCIPLES.md) intact as the project evolves.

## Open core, commercial verticals

Trellis is dual-licensed (see [`README.md`](README.md#license) and
[`COMMERCIAL.md`](COMMERCIAL.md)):

- The **core** is AGPL-3.0-or-later — a genuine public good.
- The **extension API** is MIT, so anyone can build against it.
- A **commercial license** removes the AGPL's source-disclosure obligation for
  closed-source verticals.

**De Otio's own verticals are held at arm's length.** A vertical built by
De Otio (for example, the Skybber product) licenses the core on the same terms
as any third party, and the public core's development is funded and accounted
separately from any commercial vertical. The point is structural: the public
core must not become a private subsidy in disguise, and its stewardship must
not be captured by one downstream product.

## Reciprocity

Openness without reciprocity concentrates value upward — the public core bears
the cost of building and maintaining infrastructure while commercial users
capture the benefit. Trellis therefore expects **reciprocity** from those who
build commercially on the core. In practice that means some combination of:

1. **Attribution** — visible credit to the Trellis core and its steward.
2. **Transparency about downstream use** — being open about how the core is
   deployed and extended.
3. **Contribution to infrastructure costs** — commercial licensing, sponsorship,
   or upstreamed maintenance that helps sustain the public core.
4. **Participation in shared governance** — engaging with the core's direction
   rather than silently forking away from it.

The specific, binding terms for commercial use live in
[`COMMERCIAL.md`](COMMERCIAL.md); the list above is the governing *principle*
those terms serve. This is the same "differentiated access" logic described in
[`PRINCIPLES.md`](PRINCIPLES.md): open by default where openness serves the
public interest, with conditions where large-scale commercial reuse would
otherwise deplete it.

## Contributions

External contributions are **not currently accepted** — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). A [Contributor License Agreement](CLA.md)
is in place for if that changes, so the dual-licensing model (and therefore the
stewardship and reciprocity arrangement above) remains possible.

## A note on stance

Trellis is built in the conviction that the social layer should be public
infrastructure, not a tenancy granted by a platform. It does not require the
verticals built on it to share that conviction — the core is genuinely generic.
Trellis offers a foundation that does not make its users into vassals; it does
not tell anyone what they should build.
