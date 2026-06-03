# 02 · Trellis alignment

How the argument in [`01-the-argument.md`](01-the-argument.md) maps onto Trellis,
a generic multi-tenant social-network *core*. Several points land directly on
architecture decisions. Concrete actions are in
[`03-suggested-changes.md`](03-suggested-changes.md).

## 1. Interoperability is the lever, not a footnote (rec 5.4)

Interoperability (breaking lock-in) is framed as a primary remedy — "leaving
platforms without losing social networks." Trellis already targets **ActivityPub
/ Fedify federation**; that is not just a feature, it is the posture the critique
says is *correct*. Treat federation as a **first-class agency commitment**, not a
default-disabled extra.

## 2. "Public, non-commercial alternative" is a market position (rec 5.5)

Rec 5.5 explicitly calls for "public or non-profit platforms … open and
accountable recommendation systems … platforms specifically designed for
children or teenagers." A multi-tenant, extension-driven, ad-free, agency-first
core is exactly the infrastructure that demand needs — public-sector,
educational, and civic tenants running their own attention-respecting spaces.
Fits the multi-tenant identity-federation story and the DACH/EU → China roadmap.

## 3. Attention mechanics are a regulatory surface — design them as auditable subsystems (recs 5.1, 5.2)

If regulation targets attention *mechanisms* (the brief argues the platform
*category* is irrelevant), then **feed ranking, notification cadence, and any
engagement counters/ad-surface should be inspectable, tenant-configurable, and
disclosable to a regulator** — not hardcoded engagement-maximisers. For a
platform core this argues for the feed/ranking layer being a **declared,
swappable policy** rather than baked-in behaviour. (Trellis already removed
`FeedStrategy` and ranks by recency within relationship tiers — the lesson is to
keep that logic at an explicit, auditable boundary.)

## 4. Age verification is a privacy liability, not a safety feature

Strong argument against collecting biometric/identity data to age-gate. Prefer
**privacy-preserving age assurance** (zero-knowledge attestations, third-party
age tokens) over storing identity documents — consistent with the
confidentiality and data-localisation posture already on the roadmap, and with
the UN OHCHR guidance noted in
[`../05-age-verification-and-minor-safety.md`](../05-age-verification-and-minor-safety.md).
**Note the compliance constraint** (see [`README.md`](README.md) and
[`03`](03-suggested-changes.md)): this shapes *how* age assurance is done, it does
not remove the legally-required age tiers.

## 5. Protect minors at the mechanism level, not by exclusion

Product principle: protect minors by constraining *mechanisms* (no microtargeting
of minors, calmer default ranking, no infinite-scroll / streak dark patterns)
rather than by exclusion. Implementable as a tenant / account-class policy keyed
on `ageTier` — **complementary to**, not a replacement for, the age-tier
compliance work.

## 6. The reframe: from *mental health* to *agency / cognitive liberty*

The most important shift. The brief reframes the *whole* `safer-social-design/`
analysis: the positive goal is **returning attentional agency to the user**, not
"reducing harm to mental health." The existing structural wins (finite circles,
chronological tiers, posting radius, no engagement-ranking) are better positioned
as *agency-enhancing* than as *anti-addiction*. See the IRL-primitives work
([`../../../plans/redesign/real-life-interaction/06-attention-ethics-grounding.md`](../../../plans/redesign/real-life-interaction/06-attention-ethics-grounding.md))
for how this reframes real-life-interaction features as meaning- and
recognition-restoring.

## 7. The one transparency gap to close (rec 5.2)

Rec 5.2 (transparency + contestability of recommenders) is the one place the
brief asks for *more* than Trellis does today. Trellis's ranking is already
legible (recency within relationship tiers), but it is not yet *contestable* to
the user. A "why am I seeing this / why is this person in this tier" affordance is
cheap — the relationship score is already user-visible and adjustable. Detailed
in [`03`](03-suggested-changes.md) (S2).

## Net takeaway

External validation that Trellis's **federation-first, multi-tenant,
extension-driven** shape is on the right side of where social-media regulation is
heading — plus a strategic reframe (position around **user agency / cognitive
liberty**, not mental-health-harm-reduction) and a short list of additive changes
in [`03`](03-suggested-changes.md). The biggest leverage items are non-code: the
positioning reframe and treating federation + ranking-transparency as core agency
commitments.
