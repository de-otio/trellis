# 06 — Interoperability commitment: no felony contempt of business model

> **Leverage: medium.** Partly a design choice, partly a licensing/governance
> one. As a *core that others build on*, Trellis is unusually well-placed to
> make the pro-interop commitment a feature.

## The mechanism

Doctorow calls the legal/technical suppression of interoperability "felony
contempt of business model": using IP law (DMCA §1201 anti-circumvention, CFAA),
DRM, client attestation, and Terms-of-Service clauses to make it **illegal or
impossible** to build the tools that would let users route around abuse. This is
what converts a temporary lock-in into a permanent one — it removes the
*interoperability* discipline and, with it, much of *competition*.

Most platforms add these measures precisely *because* they intend to
enshittify and need users unable to escape. The anti-enshittification move is to
pre-commit to never adding them.

## Design changes

### A. A stable, documented, public client API — third-party clients first-class

- Treat the client-facing API as a published contract, not an
  implementation detail of one official client. Document it; version it; don't
  break it casually. (Trellis is already a reusable core with an extension
  registration API — extend that posture to *clients*, not just server-side
  extensions.)
- The effect: adversarial interoperability (third parties building alternative
  clients) becomes *ordinary* interoperability — blessed, documented, and
  therefore not something the platform can later criminalise.

### B. No anti-interop technical measures

- **No** client attestation / app-integrity gating that refuses to serve
  non-official clients.
- **No** DRM on user-retrievable content.
- **No** rate-limiting or fingerprinting designed specifically to break
  alternative clients or a user scraping *their own* data.

### C. No anti-interop legal measures

- ToS must **not** prohibit: building alternative clients, automating access to
  one's own account, or exporting/scraping one's own data. (This is a
  governance/licensing artefact, but it belongs in the same commitment set as
  the technical ones — and it pairs with doc 02's portable export.)
- Where Trellis is published as open source, the licence and contributor norms
  should make hostile re-licensing (a common late-stage enshittification step)
  visible and costly.

## Relationship to federation (doc 02)

Live ActivityPub federation is the strongest form of interoperability and is
deferred. This doc is the *cheaper, always-available* form: even pre-federation,
a documented client API + an explicit "alternative clients welcome" stance gives
users and third parties a self-help route. Federation is interop with other
*servers*; this is interop with other *clients*. Both deny the operator the
lock-in that stage 2 depends on.

## Why it's "only" medium leverage

Because it is partly a promise (ToS, licence) rather than a machine-checked
invariant, it is more reversible than docs 02–05. Mitigate by encoding what can
be encoded: the API contract as a versioned, tested artefact; a CI check that
flags additions of client-attestation/fingerprinting dependencies; the licence
and ToS under CODEOWNERS so a hostile change is a visible, reviewed diff.
