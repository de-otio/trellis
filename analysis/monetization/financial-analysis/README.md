# Financial Viability Analysis: Freemium + Voluntary Value Exchange

## Purpose

This analysis evaluates the financial viability of Trellis's monetization model: **free basic platform access for all users**, with **paid premium features** that can be **unlocked through voluntary value-exchange contributions**. It is designed to serve as input for formal financial modeling and investor presentations.

## Model Summary

| Element | Description |
|---|---|
| **Basic platform** | Free for all users, no contribution required |
| **Premium tier** | $6.99/month — advanced analytics, enhanced profiles, priority support |
| **Value-exchange unlock** | Premium becomes free if user generates sufficient brand revenue (~3-5 actions/month) |
| **Universal micro-payments** | All adult users earn cash/benefits from brand value they generate |
| **B2B brand tools** | SaaS platform for brands to manage campaigns, discover contributors, access analytics |

## Key Findings

- **Break-even at ~20K MAU** with moderate participation rates and diversified revenue
- **Profitable at 50K MAU** across all but the most conservative scenario
- **15-25% voluntary participation** is realistic based on comparable cashback/rewards platforms (Rakuten: 35-45%, Google Local Guides: 5-8%, incentivized reviews: 15-30%)
- **3-5% free-to-paid conversion** is achievable for a niche community with strong utility features (Strava: ~10%, Duolingo: ~8.6%, industry median: 2-4%)
- **Pet industry TAM supports the model**: EUR 14-18B DACH pet market, 10.3M dogs in Germany alone, pet content engagement rates 2-3x platform averages

## Documents

| Document | Description |
|---|---|
| [01-market-opportunity.md](01-market-opportunity.md) | TAM/SAM/SOM analysis, pet industry data, creator economy intersection |
| [02-revenue-model.md](02-revenue-model.md) | Four revenue streams with sourced pricing assumptions |
| [03-unit-economics.md](03-unit-economics.md) | LTV, CAC, ARPU, contribution margins with industry benchmarks |
| [04-financial-projections.md](04-financial-projections.md) | 5-year projections: three scenarios, monthly/quarterly/annual |
| [05-sensitivity-analysis.md](05-sensitivity-analysis.md) | Sensitivity tables, break-even surfaces, critical thresholds |
| [06-comparable-companies.md](06-comparable-companies.md) | Comparable platforms, valuations, revenue multiples |
| [07-key-metrics.md](07-key-metrics.md) | KPIs and targets aligned to investor expectations |
| [08-risk-analysis.md](08-risk-analysis.md) | Risk factors with probability, impact, and mitigation |
| [implementation/](implementation/) | What exists, what's missing, schema/API/CDK/Flutter changes needed — broken down by phase |
| [review/](review/) | Design review: values alignment, consistency issues, architectural constraints, reversibility assessment, recommendations |

## Methodology

- **Bottom-up modeling**: Revenue builds from unit economics (MAU x conversion x ARPU), not top-down market capture
- **Cohort-based projections**: Churn and retention modeled by cohort vintage, not flat averages
- **Three scenarios**: Conservative, base, and optimistic with clearly stated assumption differences
- **Industry benchmarks**: All key assumptions benchmarked against published data from OpenView Partners, ProfitWell/Paddle, a16z, Influencer Marketing Hub, APPA, IVH/ZZF, and public company filings (Spotify, Duolingo, Reddit, Strava)
- **Sensitivity analysis**: Key variables tested independently and in combination

## Assumptions Register

All assumptions are listed in their respective documents with source citations. Key assumptions that thread across all documents:

| Assumption | Conservative | Base | Optimistic | Source |
|---|---|---|---|---|
| Free-to-paid conversion | 2% | 4% | 7% | OpenView 2024: median 2.6%; Lenny Rachitsky: "good" = 2-5% |
| Voluntary participation rate | 12% | 20% | 28% | Cashback platforms: 20-40%; incentivized reviews: 15-30% |
| Monthly paid churn | 7% | 5% | 3.5% | ProfitWell 2024: B2C median 6-8%; best-in-class 3-4% |
| Premium ARPPU | $4.99/mo | $6.99/mo | $9.99/mo | Comp set: Strava $5, Discord $7.50, Duolingo $6.40 |
| Brand payment per action | $2.00 | $3.00 | $5.00 | Bazaarvoice sampling: $15-40/review; micro-influencer CPE: $0.05-0.25 |
| Platform take rate | 30% | 35% | 40% | Industry standard: Patreon 5-12%, App Store 30%, marketplace avg 15-30% |
| Cost to serve per MAU/month | $0.05 | $0.03 | $0.015 | a16z "Cost of Cloud"; Reddit ~$0.01-0.02; early-stage ~$0.005-0.02 |
| DAU/MAU | 18% | 25% | 32% | Niche community median: 15-25%; Reddit: 40-44% |

---

*This analysis supersedes the earlier viability sketch in [12-freemium-value-exchange-viability.md](../value-exchange-social-platform/12-freemium-value-exchange-viability.md).*
