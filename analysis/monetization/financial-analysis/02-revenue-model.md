# Revenue Model: Four Streams

The model is deliberately diversified so that no single stream must carry profitability. Each stream serves a different user behavior and has different scaling characteristics.

---

## Stream 1: Premium Subscriptions (Direct Pay)

Users pay for enhanced features. This is the most predictable, highest-margin stream.

### Premium Feature Set

| Feature | Free Tier | Premium ($6.99/month) |
|---|---|---|
| Social features (posts, follows, messaging) | Full | Full |
| Content creation tools | Basic | Advanced (scheduling, templates, analytics) |
| Profile customization | Standard | Enhanced (themes, badges, portfolio) |
| Dog profile features | Basic health log | Full health tracking, vet integration |
| Search and discovery | Standard | Priority placement, advanced filters |
| Analytics | Basic (post views) | Full (audience insights, engagement trends) |
| Ad-free experience | Light community promotions | Completely ad-free |
| Support | Community | Priority |

### Pricing Rationale

| Benchmark | Monthly Price | Source |
|---|---|---|
| Strava Premium | $5.00 | Public pricing |
| Discord Nitro Basic | $4.99 | Public pricing |
| Duolingo Super | ~$6.40 effective | 10-K derived |
| Discord Nitro Standard | $9.99 | Public pricing |
| **Trellis Premium** | **$6.99** | Mid-range of comp set |

Annual pricing at $59.99/year ($5.00/month effective) provides a ~28% discount and reduces churn.

### Conversion Assumptions

| Scenario | Conversion Rate | Source Basis |
|---|---|---|
| Conservative | 2% | OpenView 2024 median: 2.6% |
| Base | 4% | Lenny Rachitsky "good" range: 2-5%; a16z mature consumer: 5-8% |
| Optimistic | 7% | Duolingo: 8.6%; Strava: ~10% |

### Revenue Calculation

```
Monthly subscription revenue = MAU × conversion_rate × ARPPU
```

At 50K MAU, base case: 50,000 × 4% × $6.99 = **$13,980/month**

---

## Stream 2: Brand Value-Exchange Payments

Brands pay per verified value action completed by users who voluntarily participate. The platform takes a cut; the remainder goes to the user's wallet.

### What Brands Pay For

| Action Type | Brand Pays | Platform Keeps (35%) | User Earns | Source / Rationale |
|---|---|---|---|---|
| Product review | $2-5 | $0.70-1.75 | $1.30-3.25 | Bazaarvoice sampling: $15-40/review all-in; we're lower because user self-selects |
| Peer Q&A answer | $1-3 | $0.35-1.05 | $0.65-1.95 | Micro-influencer CPE: $0.05-0.25/engagement; Q&A is higher-value |
| Feedback survey | $0.50-2 | $0.18-0.70 | $0.32-1.30 | Market research surveys: $1-5/complete; pet-specific has premium |
| Endorsed recommendation | $3-8 | $1.05-2.80 | $1.95-5.20 | Nano-influencer post: $10-100; our rate is per-action, not per-post |
| Product photo/content | $2-6 | $0.70-2.10 | $1.30-3.90 | UGC photo: $50-250 commissioned; our rate is for organic, lower-effort |

### Voluntary Participation Assumptions

| Scenario | Participation Rate | Source Basis |
|---|---|---|
| Conservative | 12% | Google Local Guides active: 5-8%; unincentivized review: 5-10% |
| Base | 20% | Cashback platforms: 20-40%; incentivized review with small reward: 15-30% |
| Optimistic | 28% | Loyalty program active participation: 15-25%; high end with feature unlock incentive |

**Why 20% is credible**: Users have three simultaneous incentives: (1) cash/benefits in wallet, (2) premium feature unlock, (3) social recognition. Cashback platforms with only incentive #1 achieve 20-40% participation. Adding feature unlock and social recognition should sustain 20%+.

### Contributing User Behavior

| Metric | Conservative | Base | Optimistic |
|---|---|---|---|
| Actions per contributing user/month | 2 | 3.5 | 5 |
| Average brand payment per action | $2.00 | $3.00 | $5.00 |
| Gross brand revenue per contributor/month | $4.00 | $10.50 | $25.00 |
| Platform share per contributor/month | $1.40 | $3.68 | $10.00 |

### Revenue Calculation

```
Monthly brand revenue = MAU × participation_rate × actions_per_user × avg_payment × take_rate
```

At 50K MAU, base case: 50,000 × 20% × 3.5 × $3.00 × 35% = **$36,750/month**

### Premium Unlock Economics

A contributing user who generates enough brand revenue to unlock premium costs the platform the subscription price but generates brand revenue:

| Metric | Value |
|---|---|
| Premium price (opportunity cost) | $6.99/month |
| Brand revenue from unlock-qualifying user | $10.50/month (base case) |
| Platform share | $3.68/month |
| **Net vs. paid subscriber** | **-$3.31/month** |

The platform earns less from a value-exchange unlocker than a paid subscriber. However:
- These users are **more engaged** (higher retention, more content, more social activity)
- They generate **brand value** that makes the brand tools stream possible
- They create **content** that attracts free and paid users (network effect)
- The alternative is they stay free and generate **$0** — $3.68 > $0

---

## Stream 3: Ambient Brand Revenue (Universal Micro-Influencer)

All users — including those who never opt into value actions — generate some brand value through organic activity. This is tracked and monetized passively.

### How Ambient Value Is Generated

| Activity | Brand Value | Mechanism |
|---|---|---|
| Post featuring a product (photo of dog with toy/food) | Impression value | Product recognition, organic reach |
| Recommendation in conversation ("We use Brand X") | Referral value | Click-through, conversion attribution |
| Check-in at a pet business | Local business value | Foot traffic attribution |
| Breed/health data (aggregated, anonymized) | Market research value | Brand product development insights |

### Revenue Assumptions

| Scenario | Ambient ARPU/month (all users) | Rationale |
|---|---|---|
| Conservative | $0.10 | Below Reddit blended ARPU (~$0.28/month) |
| Base | $0.25 | Comparable to Reddit/Discord blended ARPU |
| Optimistic | $0.50 | Approaching Nextdoor ($0.46-0.50/month) |

This stream requires the universal micro-influencer attribution infrastructure (see [11-universal-micro-influencer.md](../value-exchange-social-platform/11-universal-micro-influencer.md)). It is the lowest-margin stream but scales linearly with the entire user base.

### Revenue Calculation

```
Monthly ambient revenue = MAU × ambient_ARPU
```

At 50K MAU, base case: 50,000 × $0.25 = **$12,500/month**

---

## Stream 4: B2B Brand Tools (SaaS)

Brands pay for access to the platform's tools for managing value-exchange campaigns, discovering contributors, and accessing analytics.

### Tool Set

| Tier | Price | Features |
|---|---|---|
| Starter | $199/month | Basic campaign creation, contributor discovery, standard analytics |
| Professional | $599/month | Advanced targeting, A/B testing, competitor benchmarks, API access |
| Enterprise | $1,500+/month | Custom campaigns, dedicated support, white-label reporting, multi-brand |

### Brand Acquisition Assumptions

| Year | Brand Partners | Avg Monthly Revenue/Brand | Source Basis |
|---|---|---|---|
| Year 1 | 5-10 | $300 | Early pilots, favorable pricing |
| Year 2 | 25-50 | $500 | Self-serve portal + sales |
| Year 3 | 50-100 | $650 | Category expansion, upselling |
| Year 4 | 100-200 | $750 | Enterprise adoption |
| Year 5 | 200-400 | $850 | Market position established |

### Revenue Calculation

```
Monthly B2B revenue = brand_partners × avg_monthly_revenue
```

At Year 2 (50K MAU), base case: 35 × $500 = **$17,500/month**

---

## Combined Revenue Summary (Base Case, 50K MAU)

| Stream | Monthly Revenue | % of Total | Margin Profile |
|---|---|---|---|
| Premium subscriptions | $13,980 | 17% | ~90% gross margin |
| Brand value-exchange | $36,750 | 46% | ~70% (net of user payouts) |
| Ambient brand revenue | $12,500 | 15% | ~80% |
| B2B brand tools | $17,500 | 22% | ~85% |
| **Total** | **$80,730** | **100%** | **~78% blended** |

### Revenue per User (Blended)

```
$80,730 / 50,000 MAU = $1.61/MAU/month = $19.35/MAU/year
```

Benchmark comparison:
- Reddit: ~$3.40/MAU/year (ad-driven)
- Nextdoor: ~$5.50-6.00/MAU/year (ad-driven)
- Duolingo: ~$5.10/MAU/year (subscription-driven, but higher conversion)

Trellis's higher blended ARPU is driven by the brand payment stream — a structural advantage of the value-exchange model over pure subscription or pure advertising.
