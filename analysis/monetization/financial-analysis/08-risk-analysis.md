# Risk Analysis

Each risk is assessed on probability (Low/Medium/High), impact (Low/Medium/High/Critical), and timeframe. Mitigations are specific and actionable.

---

## Market Risks

### R1: Insufficient Voluntary Participation

**The model's single biggest risk.**

| Dimension | Assessment |
|---|---|
| Probability | Medium (20-35%) |
| Impact | Critical |
| Timeframe | Months 6-18 (post value-exchange launch) |

**Description**: Fewer than 12% of users voluntarily contribute value actions, making brand revenue insufficient to sustain the model.

**Evidence for concern**: Wikipedia editor rates are 0.02%; Yelp review rates are 2-5%. Voluntary contribution requires motivation.

**Evidence against concern**: Cashback platforms achieve 20-40% active participation (Rakuten, Ibotta). Incentivized review rates are 15-30% (BrightLocal 2024). Trellis offers three simultaneous incentives (cash, feature unlock, social recognition), not just one.

**Mitigation**:
1. Design low-friction actions (10-second product rating, quick Q&A) alongside high-effort ones
2. Make the premium unlock achievable with 3-5 actions/month — low enough to feel effortless
3. Contextual prompts after organic brand-adjacent activity ("You just posted about Brand X — want to make it official?")
4. Monitor participation weekly from launch; if <15% at month 3, adjust action types and incentive structure before declaring failure
5. **Fallback**: If participation stays below 10%, shift weight to premium subscriptions and B2B brand tools. The model survives (see Sensitivity Analysis "Cold Start Failure" scenario) but grows more slowly.

---

### R2: Brands Don't See ROI

| Dimension | Assessment |
|---|---|
| Probability | Medium (25-40%) |
| Impact | High |
| Timeframe | Months 4-12 (brand pilot phase) |

**Description**: Brands don't perceive sufficient value from value actions to justify payment, or they prefer existing channels (Instagram influencer campaigns, Google Ads).

**Evidence for concern**: New platforms must prove ROI against established alternatives. Brand marketing teams are conservative and slow to adopt.

**Evidence against concern**: Bazaarvoice data shows 144% conversion lift from UGC (Spiegel Research Center). Brands pay $15-40 per generated review through sampling programs. Trellis's $2-5/review is dramatically cheaper. Pet content engagement is 2-3x platform averages (Later/Fohr).

**Mitigation**:
1. Start with 5-10 founding brand partners on favorable pilot terms (discounted or free trial)
2. Measure and report concrete ROI metrics: review views, click-throughs, conversion attribution
3. Build case studies with pilot data before approaching broader market
4. Offer self-serve with no minimum commitment (reduce risk for brands to try)
5. **Fallback**: If brand payments underperform, B2B SaaS tools (analytics, discovery) can generate revenue independently of per-action payments.

---

### R3: Cold-Start / Chicken-and-Egg

| Dimension | Assessment |
|---|---|
| Probability | Low-Medium (15-25%) |
| Impact | High |
| Timeframe | Months 1-6 |

**Description**: Can't attract brands without users; can't demonstrate value-exchange without brands.

**Mitigation**:
1. **Social-first phase** (Months 1-6): Build community before introducing value-exchange. Users join for the social product, not for brand interactions.
2. **Existing Trellis community**: Warm audience reduces cold-start severity.
3. **Pre-negotiate founding brand partners** during social-first phase. Brands commit based on community growth trajectory, not current revenue.
4. **Dog-fan niche advantage**: Pet brands are highly motivated to reach engaged dog owners. DACH pet industry marketing budgets are growing 5-7% annually.

---

## Product Risks

### R4: Premium Features Not Compelling Enough

| Dimension | Assessment |
|---|---|
| Probability | Medium (25-35%) |
| Impact | Medium |
| Timeframe | Months 3-12 |

**Description**: Free-to-paid conversion stays below 2% because premium features don't justify the price.

**Evidence for concern**: Many social platforms struggle with premium conversion. Reddit Premium is <1%. Free users may feel the basic product is sufficient.

**Evidence against concern**: Strava (~10%) and Duolingo (~8.6%) achieve high conversion with strong utility features. Dog health tracking, advanced analytics, and vet integration are genuine utility, not vanity features.

**Mitigation**:
1. Build premium features that provide **utility, not just cosmetics** (health tracking, vet integration, data export)
2. A/B test feature gating to find the right free/premium boundary
3. Offer annual pricing with significant discount (28%) to improve conversion and reduce churn
4. Use value-exchange unlock as a trial mechanism — users experience premium through contribution, then some convert to paying

---

### R5: Feed Contamination / Trust Erosion

| Dimension | Assessment |
|---|---|
| Probability | Low-Medium (15-25%) |
| Impact | High |
| Timeframe | Ongoing from value-exchange launch |

**Description**: Brand-related content bleeds into the social feed, eroding the community feel and user trust.

**Mitigation**:
1. **Architectural separation**: Contribution space and social space are distinct sections (see [07-ux-architecture.md](../value-exchange-social-platform/07-ux-architecture.md))
2. Brand content never appears in social feed unless user explicitly shares it
3. Transparency labels on all brand-related content (see [03-transparency-architecture.md](../value-exchange-social-platform/03-transparency-architecture.md))
4. Regular user sentiment surveys; roll back if trust scores decline
5. Quarterly UX audits to verify boundary integrity

---

### R6: Quality Degradation of Value Actions

| Dimension | Assessment |
|---|---|
| Probability | Medium (30-40%) |
| Impact | Medium-High |
| Timeframe | Months 12+ (as user base grows) |

**Description**: Users game the system with low-effort contributions to maximize earnings, degrading brand ROI.

**Mitigation**:
1. Quality scoring with minimum thresholds (below threshold = zero earnings)
2. Earnings tied to **impact** (views, helpfulness ratings), not volume
3. Diminishing returns on rapid-fire submissions
4. Peer review / helpfulness voting
5. Human review sampling for calibration
6. Weekly cap on value actions prevents volume gaming

---

## Financial Risks

### R7: Extended Pre-Revenue Period

| Dimension | Assessment |
|---|---|
| Probability | Low (10-15%) |
| Impact | Medium |
| Timeframe | Months 1-12 |

**Description**: Revenue takes longer than projected to materialize, requiring more runway than the $120-150K pre-seed.

**Mitigation**:
1. Lean Year 1 budget ($10K/month fixed costs) provides 12-15 months runway
2. Social-first phase can generate early subscription revenue (even 1% of 5K users = $350/month)
3. Can extend runway by delaying team expansion
4. Founding brand partnerships can include upfront pilot payments

---

### R8: Brand Revenue Concentration

| Dimension | Assessment |
|---|---|
| Probability | Medium (25-35%) in early years |
| Impact | Medium |
| Timeframe | Years 1-3 |

**Description**: Dependence on a small number of brand partners creates revenue fragility.

**Mitigation**:
1. Explicit target: no single brand >25% of revenue (Year 2), declining to <10% (Year 5)
2. Self-serve brand portal reduces dependence on individual enterprise deals
3. Diversify across pet categories: food, accessories, health, insurance, services
4. Track brand pipeline and renewal rates as early warning metrics

---

### R9: Tax and Payment Complexity

| Dimension | Assessment |
|---|---|
| Probability | Medium (30-40%) |
| Impact | Low-Medium |
| Timeframe | Months 6+ (wallet launch) |

**Description**: Paying micro-amounts to users across jurisdictions creates tax reporting obligations, payment processing costs, and compliance burden.

**Mitigation**:
1. Start with platform credits and benefits (not cash) — simpler tax treatment
2. Cash-out threshold ($10 minimum) reduces transaction count
3. Below tax reporting thresholds (e.g., $600/year US, EUR 600 DACH varies) most users won't trigger obligations
4. Partner with a payment provider experienced in creator payouts (Stripe Connect, Payoneer)
5. Legal opinion on tax treatment before wallet launch (see [09-legal-and-regulatory.md](../value-exchange-social-platform/09-legal-and-regulatory.md))

---

## Competitive Risks

### R10: Incumbent Response

| Dimension | Assessment |
|---|---|
| Probability | Low (10-15%) for pet-specific response |
| Impact | High |
| Timeframe | Years 2-4 (if Trellis gains traction) |

**Description**: Instagram, TikTok, or a major pet platform adds pet-community features or a value-exchange mechanism.

**Evidence this is unlikely**: Major platforms optimize for mass-market engagement, not niche vertical depth. Instagram won't build dog health tracking or vet integration. Value-exchange monetization conflicts with ad-driven business models.

**Mitigation**:
1. **Depth over breadth**: Pet-specific utility features (health tracking, breed info, vet records) are too niche for general platforms
2. **Community identity**: Dog-fan community identity creates emotional switching costs
3. **Data moat**: Aggregate pet health/behavior data becomes more valuable over time
4. **First-mover in DACH**: Regional focus with regulatory compliance is hard to replicate quickly
5. **Speed**: Execute faster in the vertical than a general platform can allocate resources to it

---

### R11: Key-Person / Single-Developer Risk

| Dimension | Assessment |
|---|---|
| Probability | Medium (inherent in solo founding) |
| Impact | Critical |
| Timeframe | Ongoing |

**Description**: Single developer means all technical knowledge is concentrated. Bus factor = 1.

**Mitigation**:
1. Infrastructure-as-code (AWS CDK) means infrastructure is reproducible
2. 80%+ test coverage means the codebase is well-specified
3. Comprehensive documentation (this repository)
4. Automated CI/CD pipeline reduces manual operational burden
5. Plan to hire first engineer by Year 2 Q2 (when revenue supports it)

---

## Regulatory Risks

### R12: FTC/GDPR Compliance Failure

| Dimension | Assessment |
|---|---|
| Probability | Low-Medium (15-25%) |
| Impact | High |
| Timeframe | Pre-launch and ongoing |

**Description**: Value-exchange content classified as undisclosed advertising, or data flows to brands violate GDPR.

**Mitigation**: Detailed analysis in [09-legal-and-regulatory.md](../value-exchange-social-platform/09-legal-and-regulatory.md). Summary:
1. Platform-level transparency labeling (users cannot remove disclosures)
2. GDPR data flow mapping and explicit consent per brand
3. Legal review before launch (P0 on compliance roadmap)
4. German courts interpret GDPR strictly — building for DACH first forces best-practice compliance

---

## Risk Matrix Summary

| Risk | Probability | Impact | Priority |
|---|---|---|---|
| R1: Low VE participation | Medium | Critical | **P0** |
| R2: Brands don't see ROI | Medium | High | **P0** |
| R3: Cold-start | Low-Medium | High | **P1** |
| R4: Premium not compelling | Medium | Medium | **P1** |
| R5: Feed contamination | Low-Medium | High | **P1** |
| R6: Quality degradation | Medium | Medium-High | **P1** |
| R7: Extended pre-revenue | Low | Medium | **P2** |
| R8: Brand concentration | Medium | Medium | **P2** |
| R9: Tax/payment complexity | Medium | Low-Medium | **P2** |
| R10: Incumbent response | Low | High | **P2** |
| R11: Key-person risk | Medium | Critical | **P1** |
| R12: Regulatory compliance | Low-Medium | High | **P0** (pre-launch) |

### Top 3 Risks to Address Before Launch

1. **R1 (Voluntary participation)**: Validate with user research and small-scale pilot before full rollout
2. **R2 (Brand ROI)**: Secure 3-5 founding brand partners with measurable pilot results
3. **R12 (Regulatory)**: Legal review of FTC endorsement guidelines and GDPR data flows
