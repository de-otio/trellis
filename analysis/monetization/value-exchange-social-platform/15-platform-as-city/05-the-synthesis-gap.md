# The Synthesis Gap

The three lineages — public-infrastructure ([01](01-platforms-as-public-infrastructure.md)), mechanism design ([02](02-mechanism-design-and-funding.md)), platform cooperativism ([03](03-platform-cooperativism.md)) — together cover most of the hypothesis. But there is a part the existing literature does not currently supply. This document names it precisely.

---

## What the Hypothesis Requires

Three load-bearing claims:

1. The platform supplies common services with public-good characteristics, not merely a marketplace.
2. **B2B participants and B2C participants are co-citizens of the same polity**, not buyer-and-seller across a market.
3. Common services are tax-financed by the participants who depend on them.

---

## Where Each Claim Is Supported

| Claim | Strongest fit in existing literature |
|---|---|
| 1. Platform-as-public-infrastructure | Bratton, Rahman, Zuckerman, Pariser/Stroud, Masnick. Strong support. The argument is mature. |
| 2. B2B and B2C as co-citizens | **No good fit.** See below. |
| 3. Common services are tax-financed | Buterin/Hitzig/Weyl (QF), Posner & Weyl (COST, QV), Weyl & Tang (*Plurality*). Strong support at the mechanism level. |

Claims 1 and 3 each have a mature literature. The synthesis of 1 and 3 — *operationalised* public infrastructure inside a platform — is what Weyl & Tang's *Plurality* (2024) is currently writing into. That synthesis is in motion but not yet a settled body of work.

---

## What Is Missing — The Dual-Citizenship Claim

Almost every adjacent literature treats B2B platform participants as one of:

- **Suppliers** (gig-platform, marketplace literature) — the workers being aggregated.
- **Advertisers** (ad-platform literature) — the demand side of the attention market.
- **The regulated** (utility / antitrust literature) — the party being held to account.

None of these treat B2B participants as **fellow residents of a shared polity**, sharing common services with B2C participants and contributing to their upkeep. The B2B/B2C divide in the existing literature is almost always a *market* divide, not a *civic* divide.

The closest move in this direction is multi-stakeholder cooperativism (e.g. Mondragon-style models with worker, consumer, and producer classes), but:

- Scholz and Christiaens both acknowledge multi-stakeholder co-ops are *harder*, not easier, than single-class co-ops.
- Multi-stakeholder co-ops still resolve the relationship through *ownership*, not through *citizenship-and-tax*.

The dual-citizenship-with-tax framing therefore lives outside the existing literature. It draws on it heavily but is not currently assembled.

---

## Why the Gap Is Interesting

The gap matters because the **B2B/B2C distinction is exactly the boundary that platforms most aggressively exploit today**. Ad-funded platforms make B2B (advertisers) the customer and B2C (users) the product. The political-theory critique of this (Zuboff, Doctorow's "enshittification") is mature. But the *positive* prescription — what the relationship *should* look like — tends to either:

- Eliminate B2B presence (Mastodon's federated non-commercial model), or
- Re-balance B2B/B2C by making B2C the customer too (subscription models), or
- Replace ownership of the platform (cooperativism).

The dual-citizenship framing is none of these. It says: B2B stays, B2C stays, but they are co-residents with overlapping service entitlement and proportional shared funding obligation. That is structurally new.

---

## What the Gap Implies for Subsequent Work

If the hypothesis is taken seriously, the subsequent design questions are:

1. **What are the common services?** What does the platform supply that *both* B2B and B2C need? (Identity, moderation, dispute resolution, discoverability, federation reach, abuse handling, content provenance, etc.)
2. **What is the tax base?** Activity? Self-declared value (COST-style)? Volume of common-service consumption? Quadratic on contributions?
3. **What is the citizenship gradient, if any?** Are B2B and B2C strictly equal, or do they have different rights and obligations? (Voting weight, service entitlement, transparency obligation.)
4. **What is the relationship to the operator?** Is the platform operator a service provider, a constitutional court, a tax authority, or some combination?
5. **Where does Trellis sit?** As a multi-tenant infrastructure layer, Trellis is not itself the polity — each tenant is. But Trellis sets the *constitutional defaults* that tenants either accept or modify. That is closer to the EU-level framing (DSA, GDPR) than to the city level.

These are open questions, not answered ones. Naming them is the contribution this folder can make.

**Update**: Question 1 (what are the common services?) and question 4 (relationship to the operator) acquire concrete partial answers from the existing secure-voting design in the consumer vertical — see [08-secure-voting.md](08-secure-voting.md). The voting design predates this folder and was not written with the city framing in mind, but verifiable collective-decision-making turns out to be exactly the kind of common service the framing requires.
