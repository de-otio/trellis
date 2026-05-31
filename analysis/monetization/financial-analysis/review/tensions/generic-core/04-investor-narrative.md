# Investor Narrative

How to frame the generic core as a strength for investors, not a distraction from the pet-vertical launch.

---

## The Risk

If the monetization analysis is presented to investors purely as a pet-platform business, two problems emerge:

1. **TAM ceiling**: The DACH pet market, while large (EUR 14-18B), is a niche. Investors may see limited upside compared to horizontal platforms.
2. **Identity confusion**: If the generic core is mentioned later, investors may wonder "are you a pet platform or a platform platform?" Lack of clarity erodes confidence.

Conversely, leading with "we're a generic social-network core" is also wrong — it sounds like a technology project, not a business. Investors fund businesses, not architectures.

---

## The Framing

**Lead with the vertical. Reveal the architecture as upside.**

### Pitch Structure

1. **"We're building the social platform for dog lovers in DACH."**
   - Concrete, understandable, measurable
   - 10.3M dogs in Germany, EUR 14-18B pet market
   - Clear go-to-market: community-first, then value-exchange monetization

2. **"Our unit economics work at 20K MAU."**
   - Break-even at ~16K MAU
   - 4 revenue streams, no single-stream dependency
   - LTV:CAC of 4.7:1 (base case)

3. **"And here's what makes us different from every other vertical social platform..."**
   - The codebase is 75-80% domain-agnostic
   - Launching a new vertical (plants, horses, cars, local communities) requires only a domain extension — not a rebuild
   - The monetization infrastructure (subscriptions, wallets, value exchange, brand tools) transfers completely
   - Each new vertical is a new market with near-zero marginal platform cost

4. **"This means our TAM isn't just pets — it's any passion community that can support brand partnerships."**
   - Pet vertical proves the model
   - Second vertical validates the generic core
   - Third+ verticals are pure expansion with declining marginal cost

### The Key Slide

```
Year 1-2: Dogs in DACH (prove the model)
  → EUR 14-18B pet market
  → 4 revenue streams
  → Break-even at 20K MAU

Year 3-4: Second vertical (prove the platform)
  → Adjacent community (plants, horses, outdoor)
  → Same infrastructure, new market
  → 80% code reuse, 20% domain extension

Year 5+: Platform expansion
  → Multiple verticals, shared infrastructure
  → Each vertical adds TAM without proportional cost
  → Network effects across verticals (shared brand tools, cross-vertical discovery)
```

---

## Comparable Companies That Made This Work

### Shopify

Started as an online store for snowboard equipment. Built generic e-commerce infrastructure. Now powers millions of stores across every vertical. Investors who funded the snowboard store got a platform company.

**Relevance**: Trellis is a social community for dog lovers that happens to be built on a generic social-network core. The vertical is the go-to-market; the platform is the long-term value.

### Strava

Started as a cycling tracker. Expanded to running, hiking, swimming, and now "any activity." The core infrastructure (GPS tracking, social features, challenges) was generic from early on; the launch vertical (cycling) proved the model.

**Relevance**: Strava's expansion to other activities was low-cost because the core was generic. Trellis's expansion to other communities would follow the same pattern.

### Discord

Started as a voice chat for gamers. The core (real-time communication, servers, roles, permissions) was generic. Expanded to study groups, creator communities, brand communities, and now "any community." Gaming was the wedge; the platform was the product.

**Relevance**: Discord's gaming-first strategy gave it product-market fit and cultural identity. Trellis's dog-first strategy does the same — but the infrastructure supports any community.

---

## What Investors Will Ask

### "How big can this get if it's just dogs?"

**Answer**: Dogs in DACH alone is a $500K-$20M ARR opportunity (base case Year 2-5). But the generic core means every new vertical is incremental TAM with near-zero infrastructure cost. The pet vertical is the proof point, not the ceiling.

### "Why would a plant community use your platform instead of building their own?"

**Answer**: Building a social platform with subscriptions, wallets, value exchange, brand tools, ActivityPub federation, age-gated safety features, and GDPR compliance from scratch costs 18+ months and $500K+. We offer it as infrastructure. The plant community adds their domain extension (plant profiles, care tracking) on top of a proven stack.

### "Doesn't this distract from making the pet product great?"

**Answer**: No — because the generic core IS the pet product. Every feature we build for dog lovers (social feeds, notifications, privacy controls, moderation) is a core feature that transfers. We're not maintaining two codebases; we're building one product that happens to be reusable.

### "When do you launch the second vertical?"

**Answer**: After the pet vertical reaches profitability and proves the monetization model (Year 2-3). The second vertical launch is a validation milestone, not a distraction. We won't pursue it until the first vertical is self-sustaining.

---

## What NOT to Say to Investors

- **"We're building a generic social-network platform."** Too abstract. Sounds like a science project.
- **"Any community can use our platform."** Too broad. No focus. "If everyone is your customer, no one is."
- **"The code is 80% reusable."** Investors don't care about code reuse percentages. They care about TAM expansion and marginal cost.
- **"We could do cats too."** Trivializes the expansion story. The point is that DIFFERENT verticals (plants, cars, running) work — not just adjacent pet segments.

---

## Recommended Additions to Financial Analysis

### In Market Opportunity (01-market-opportunity.md)

Add a "Vertical Expansion" section after the TAM/SAM/SOM:

> **Vertical scope**: This market analysis covers Trellis's launch vertical (dog fans in DACH). The monetization models and implementation are entity-agnostic and will work across verticals without modification. Future deployments in other verticals (plant communities, outdoor enthusiasts, classic car owners) would require separate market analysis but use identical revenue model structure and infrastructure.
>
> **Expansion economics**: Each new vertical requires ~20% development effort (domain extension) for 100% of the monetization infrastructure. The marginal cost of a second vertical is estimated at 3-4 months of development, not 18+ months.

### In Comparable Companies (06-comparable-companies.md)

Add Shopify, Strava, and Discord as expansion-story comparables alongside the existing vertical-community comparables.

### In Key Metrics (07-key-metrics.md)

Add expansion-readiness metrics for Year 3+:
- Code reuse percentage (target: >75%)
- Time to launch new vertical (target: <4 months)
- Marginal infrastructure cost per vertical (target: <20% of first vertical)
