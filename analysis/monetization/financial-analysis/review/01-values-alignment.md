# Values Alignment

How the monetization model relates to Trellis's core values and mission.

---

## Trellis's Non-Negotiable Principles

From the project documentation and safer-social-design analysis:

1. **Wellbeing > Engagement** — measurable anti-addiction commitments, not marketing
2. **Transparency > Deception** — users always know what's happening and why
3. **User Autonomy > Platform Control** — chronological feeds, open federation, data exports
4. **Fair Exchange > Exploitation** — value-exchange model with quality caps and always an opt-out
5. **Safety by Design > Retrofit** — research-backed features baked into architecture
6. **Reusable Generics > Proprietary Silos** — core designed for extensibility across verticals

Source: De Otio's mission ("technology in service of human flourishing, not engagement extraction"), Safer Social Design research analysis, anti-addiction design commitments.

---

## Where the Monetization Model Aligns

### Free Basic Platform

The decision that basic platform access is free and never requires contributions **directly supports** the anti-exploitation positioning. Users can never feel coerced. The existence of a paid alternative proves the value exchange is fair.

**Values served**: Fair Exchange, User Autonomy

### Voluntary Value-Exchange

Users choose brands, choose action types, choose frequency. Nothing is assigned. A weekly cap prevents it from feeling like work. This is commerce by consent, not attention extraction.

**Values served**: Transparency, User Autonomy, Fair Exchange

### Architectural Separation of Social and Contribution Spaces

Brand content never appears in the social feed unless the user explicitly shares it. This prevents the "everything becomes an ad" failure mode.

**Values served**: Wellbeing, Transparency

### Transparency Dashboard

Users see exactly what value they generated, who received it, and what they earned. Every value action is labeled. No hidden data flows.

**Values served**: Transparency

### Anti-Addiction Guardrails in Gamification

No streaks, no variable rewards, no urgency mechanics. Credits are predictable. Notifications are opt-in and batched. Anti-addiction metrics have red-line thresholds that trigger automatic product review.

**Values served**: Wellbeing, Safety by Design

### Child Exclusion from Economic Layer

Children and teens are completely excluded from wallets, subscriptions, and value actions. This is enforced by the existing `AgeTier` architecture, not just policy.

**Values served**: Safety by Design

---

## Where Tensions Exist

Each tension is summarized below. For deep analysis including escalation scenarios, structural safeguards, and recommended commitments, see [tensions/](tensions/).

### Tension 1: Engagement Incentives vs. Anti-Addiction

The gamification layer (credits, badges, progress toward premium unlock) creates engagement loops. Even without variable rewards, the "2 actions away from free premium this month" progress indicator is a mild engagement mechanic.

**Resolution**: The anti-addiction metrics (session time, daily usage caps, wellbeing surveys) serve as a structural check. If these metrics breach red-line thresholds, the product must change — the commitment is measurable and public.

**Risk level**: Low. The current design is careful about this.

### Tension 2: Brand Revenue Dependency vs. Editorial Independence

If brand payments become the dominant revenue stream (~46% in base case), brands have implicit leverage. A large brand threatening to leave could pressure the platform to compromise on quality standards or editorial guardrails.

**Resolution**: Revenue diversification (4 streams, no single brand >15% of revenue by Year 5). Contractual limits on brand influence over action design. Platform defines action types, not brands.

**Risk level**: Medium. This needs active management as brand partnerships grow.

### Tension 3: Universal Micro-Influencer Tracking vs. Privacy

The ambient attribution model (Phase 4) tracks when organic content features brand products — potentially via image recognition. This feels like surveillance, even if consensual.

**Resolution**: The privacy architecture already has `analyticsOptOut` and `locationAnonymizationLevel` settings. Ambient attribution must respect these. Users who opt out of analytics must be excluded from ambient tracking entirely.

**Risk level**: Medium-High. Phase 4 needs a thorough privacy review before implementation. Starting with explicit-only actions (Phase 2) and deferring ambient attribution is the safer path.

### Tension 4: Generic Core vs. Pet-Specific Monetization

The monetization analysis is heavily framed around the pet industry (DACH pet market, pet brands, dog content engagement rates). But the generic core goal means this codebase should work for any vertical.

**Resolution**: The implementation models are already entity-agnostic — `Brand`, `ValueAction`, `Wallet` have no dog-specific fields. The market analysis is pet-specific (correctly, since that's the launch vertical), but the code doesn't need to be. Worth stating this explicitly.

**Risk level**: Low. The architecture is right; only the market analysis is pet-specific.
