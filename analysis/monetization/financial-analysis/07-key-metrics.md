# Key Metrics and Targets

Metrics aligned to what investors scrutinize at each stage, with concrete targets for Trellis. Organized by the standard investor evaluation framework.

---

## Engagement Metrics

### DAU/MAU (Stickiness)

| Period | Target | Stretch | Benchmark Context |
|---|---|---|---|
| Year 1 | 18% | 25% | Niche community apps median: 15-25% (Mixpanel 2024) |
| Year 2 | 25% | 30% | Reddit: 40-44%; Discord: 25-30% |
| Year 3+ | 28% | 35% | Duolingo: ~34%; adding daily use cases (walk tracking, feeding logs) |

**How to track**: DAU = unique users who open the app and perform at least one action per day.

**Why it matters**: DAU/MAU below 15% signals the community doesn't have a daily use case. Above 25% signals strong habit formation.

### Retention Curves

| Timeframe | Target | Stretch | Benchmark (Lenny Rachitsky 2024) |
|---|---|---|---|
| Day 1 | 45% | 60% | "Good": 40-50%, "Great": >60% |
| Day 7 | 25% | 35% | "Good": 20-30%, "Great": >35% |
| Day 30 | 15% | 25% | "Good": 10-20%, "Great": >25% |
| Day 90 | 10% | 18% | "Good": 8-15%, "Great": >15% |

**Critical signal**: The curve must **flatten** (indicating a retained core), not continue declining toward zero. A flattened curve at any level above 8% at Day 90 indicates product-market fit.

### Content Creation Ratio

| Metric | Target | Stretch | Benchmark |
|---|---|---|---|
| Heavy creators (original posts) | 3% of MAU | 5% | 90-9-1 rule: 1-2% typical; Discord: 15-25% |
| Light contributors (comments, reactions) | 15% of MAU | 25% | Reddit S-1: ~14% comment; Nextdoor: 15-20% |
| Lurkers (consume only) | 82% of MAU | 70% | Industry standard: 80-90% |

### Session Metrics

| Metric | Target | Benchmark |
|---|---|---|
| Average session duration | 5-8 min | Community apps: 4-7 min (data.ai 2024) |
| Sessions per DAU per day | 2-3 | Social apps: 2-5 (Sensor Tower 2024) |
| Average weekly sessions per MAU | 3-4 | Niche community: 2-4 |

**Anti-addiction check**: If average session duration exceeds 30 minutes or daily time exceeds 45 minutes, trigger a product review (see [08-anti-addiction-design.md](../value-exchange-social-platform/08-anti-addiction-design.md)).

---

## Growth Metrics

### User Growth

| Period | Target MoM Growth | Benchmark |
|---|---|---|
| Year 1 | 15% | Series A bar (a16z/Sequoia): 15-20% sustained 6+ months |
| Year 2 | 13% | Decelerating but still strong |
| Year 3 | 9% | Healthy at scale |
| Year 4-5 | 5-7% | Mature growth |

### Viral Coefficient (K-Factor)

| Metric | Target | Notes |
|---|---|---|
| K-factor | 0.3-0.5 | Each user brings 0.3-0.5 new users organically |
| Organic % of new users | >50% (Year 1-2) | Investors want >50% organic at Series A |
| Referral conversion rate | 20-30% | % of invited users who activate |

### Acquisition Efficiency

| Metric | Target | Benchmark |
|---|---|---|
| Blended CAC | <$5 (Year 2) | Liftoff 2024: consumer social $2-15/install |
| Paid CAC | <$12 | $20-60 per converting paid subscriber (Liftoff) |
| Organic CAC | $0 | — |
| CAC payback period | <12 months | OpenView 2024: best-in-class <6mo, median 12-18mo |

---

## Monetization Metrics

### Conversion and Revenue

| Metric | Year 1 | Year 2 | Year 3 | Year 5 | Benchmark |
|---|---|---|---|---|---|
| Free-to-paid conversion | 1% | 4% | 5% | 6.5% | OpenView median: 2.6%; Strava: ~10% |
| VE participation rate | 0% | 20% | 22% | 22% | Cashback platforms: 20-40% |
| ARPPU (monthly, paid) | $6.99 | $6.99 | $6.99 | $6.99 | Strava: $5; Duolingo: $6.40 |
| Blended ARPU (monthly) | $0.10 | $1.20 | $1.80 | $2.00 | Reddit: $0.28; Nextdoor: $0.46 |
| MRR | $0.6K | $41K | $247K | $1,693K | — |
| ARR | $7K | $495K | $2,958K | $20,313K | — |

### Unit Economics

| Metric | Target | Investor Threshold | Source |
|---|---|---|---|
| LTV:CAC (blended) | 4.7:1 | >3:1 | OpenView, SaaS Capital |
| LTV:CAC (paid only) | 28:1 | >3:1 | — |
| Gross margin | >80% | >70% for software | Industry standard |
| Contribution margin | >95% | — | Fixed-cost dominated model |

### Churn

| Metric | Year 1 | Year 2 | Year 3 | Year 5 | Benchmark |
|---|---|---|---|---|---|
| Monthly paid churn | 8% | 5% | 4.5% | 3.5% | ProfitWell B2C median: 6-8%; best: 3-4% |
| Annual paid churn | 63% | 46% | 42% | 35% | Spotify: ~30%; Duolingo: ~40% |
| Monthly free churn | 15% | 9% | 8% | 7% | — |
| Net revenue retention | 85% | 95% | 100% | 105% | Duolingo implied: 105-110% |

---

## Brand-Side Metrics

### Brand Partnership Health

| Metric | Year 2 | Year 3 | Year 5 | Notes |
|---|---|---|---|---|
| Active brand partners | 35 | 75 | 300 | — |
| Brand retention (annual) | 70% | 80% | 85% | Target >80% for predictability |
| Avg revenue per brand/month | $500 | $650 | $850 | Upselling + price increases |
| Brand NPS | >40 | >50 | >60 | — |
| Brand revenue concentration | No single brand >25% | No single brand >15% | No single brand >10% | De-risk dependency |

### Value Action Quality

| Metric | Target | Red Line |
|---|---|---|
| Avg review helpfulness score | >3.5/5 | <2.5/5 |
| % of actions flagged low quality | <10% | >25% |
| Brand-reported action usefulness | >4/5 | <3/5 |
| Actions per contributor/month | 3-5 | >10 (gaming risk) |

---

## Financial Health Metrics

### Cash and Runway

| Metric | Year 1 | Year 2 | Year 3 | Notes |
|---|---|---|---|---|
| Monthly burn rate | $10K | Net positive | Net positive | — |
| Months of runway | 12-15 | Self-sustaining | Growing | Pre-seed provides Year 1 runway |
| Cash position (cumulative) | -$113K | +$223K | +$2,468K | Base case |

### Revenue Quality

| Metric | Target | Why It Matters |
|---|---|---|
| Revenue diversification (no stream >50%) | By Year 3 | Reduces single-stream dependency |
| Recurring revenue % | >70% | Subscriptions + brand contracts are recurring |
| Revenue growth rate (YoY) | >100% (Years 2-3) | Battery Ventures benchmark |
| Gross margin | >80% | Software-like margins |

---

## Metric Dashboard: What to Track Weekly

### Growth (Top of Funnel)
- New signups (daily/weekly)
- Activation rate (% of signups who complete onboarding)
- K-factor / referral rate

### Engagement (Health)
- DAU, WAU, MAU
- DAU/MAU ratio
- Content created per day
- Sessions per user per week

### Monetization (Revenue)
- MRR (total and by stream)
- Free-to-paid conversion (trailing 30 days)
- VE participation rate (trailing 30 days)
- ARPU (blended and paid)

### Retention (Sustainability)
- Day 1, 7, 30 retention by cohort
- Monthly paid churn
- Monthly free churn

### Brand Health
- Active brand partners
- Actions completed per brand per month
- Brand satisfaction (quarterly survey)

---

## Metrics Investors Will Ask For (By Round)

### Pre-Seed / Angel
- MAU and growth rate
- Retention curve (does it flatten?)
- Engagement depth (posts/comments per user)
- Founding team and vision

### Seed
- All of the above, plus:
- Early revenue (MRR, even if small)
- Free-to-paid conversion rate
- VE participation rate (if launched)
- CAC and organic %
- Cohort revenue data

### Series A
- All of the above, plus:
- LTV:CAC by channel
- Net revenue retention
- Brand partnership pipeline and retention
- Unit economics waterfall
- Path to profitability (or current profitability)
- 3-year projections with sensitivity analysis
