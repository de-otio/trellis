# Sensitivity Analysis

This document tests how changes in key assumptions affect Year 3 revenue and the break-even point. Each variable is tested independently (holding others at base case), then in combination.

---

## Single-Variable Sensitivity

### 1. Free-to-Paid Conversion Rate

Impact on Year 3 annual revenue (base: 5% conversion, 160K MAU end):

| Conversion Rate | Subscription Revenue | Total Revenue | Change vs. Base |
|---|---|---|---|
| 1% | $92K | $2,588K | -12.5% |
| 2% | $185K | $2,681K | -9.4% |
| 3% | $277K | $2,773K | -6.3% |
| **5% (base)** | **$462K** | **$2,958K** | **—** |
| 7% | $647K | $3,143K | +6.3% |
| 10% | $924K | $3,420K | +15.6% |

**Sensitivity**: Moderate. Each 1pp change in conversion shifts revenue by ~$93K/year (3.1%). Subscription is important but not the dominant stream.

### 2. Voluntary Participation Rate

Impact on Year 3 annual revenue (base: 22% participation):

| Participation Rate | VE Brand Revenue | Total Revenue | Change vs. Base |
|---|---|---|---|
| 8% | $504K | $2,076K | -29.8% |
| 12% | $756K | $2,328K | -21.3% |
| 16% | $1,008K | $2,580K | -12.8% |
| **22% (base)** | **$1,386K** | **$2,958K** | **—** |
| 28% | $1,764K | $3,336K | +12.8% |
| 35% | $2,205K | $3,777K | +27.7% |

**Sensitivity**: HIGH. This is the most impactful single variable. Each 1pp change shifts revenue by ~$63K/year. **If participation drops below 12%, the model's profitability is at risk.**

### 3. Average Brand Payment Per Action

Impact on Year 3 annual revenue (base: $3.00/action):

| Avg Payment | VE Brand Revenue | Total Revenue | Change vs. Base |
|---|---|---|---|
| $1.00 | $462K | $2,034K | -31.2% |
| $2.00 | $924K | $2,496K | -15.6% |
| **$3.00 (base)** | **$1,386K** | **$2,958K** | **—** |
| $4.00 | $1,848K | $3,420K | +15.6% |
| $5.00 | $2,310K | $3,882K | +31.2% |

**Sensitivity**: HIGH. Directly proportional to VE revenue. Brand willingness to pay is a critical assumption.

### 4. Monthly Paid Churn

Impact on Year 3 paid subscriber count and subscription revenue (base: 4.5%):

| Monthly Churn | Annual Churn | Avg Lifetime | Sub Revenue | Change vs. Base |
|---|---|---|---|---|
| 8% | 63% | 12.5 mo | $347K | -24.9% |
| 6% | 52% | 16.7 mo | $404K | -12.6% |
| **4.5% (base)** | **42%** | **22.2 mo** | **$462K** | **—** |
| 3% | 31% | 33.3 mo | $529K | +14.5% |
| 2% | 21% | 50.0 mo | $583K | +26.2% |

**Sensitivity**: Moderate on revenue (subscription is 15% of total), but HIGH on LTV and LTV:CAC.

### 5. MAU Growth Rate

Impact on Year 3 MAU and total revenue (base: ~9% MoM average in Year 3):

| Year 3 Avg MoM Growth | Year 3 End MAU | Year 3 Revenue | Change vs. Base |
|---|---|---|---|
| 5% | 95,000 | $1,757K | -40.6% |
| 7% | 125,000 | $2,316K | -21.7% |
| **9% (base)** | **160,000** | **$2,958K** | **—** |
| 12% | 220,000 | $4,069K | +37.6% |
| 15% | 300,000 | $5,550K | +87.6% |

**Sensitivity**: VERY HIGH. Growth rate is the single largest driver of all financial outcomes.

### 6. B2B Brand Tool Revenue

Impact on Year 3 annual revenue (base: 75 brands × $650/month avg):

| Brand Partners | Avg Rev/Brand/Mo | B2B Revenue | Total Revenue | Change vs. Base |
|---|---|---|---|---|
| 30 | $400 | $144K | $2,322K | -21.5% |
| 50 | $500 | $300K | $2,478K | -16.2% |
| **75** | **$650** | **$780K** | **$2,958K** | **—** |
| 100 | $750 | $900K | $3,078K | +4.1% |
| 150 | $850 | $1,530K | $3,708K | +25.4% |

**Sensitivity**: Moderate. B2B is a stabilizing stream but doesn't dominate.

---

## Variable Importance Ranking

Based on the sensitivity analysis, variables ranked by impact on Year 3 revenue:

| Rank | Variable | Impact of ±1 Unit Change | Risk Level |
|---|---|---|---|
| 1 | **MAU growth rate** | ±$150K per 1pp MoM | Highest — existential if growth stalls |
| 2 | **VE participation rate** | ±$63K per 1pp | High — core model assumption |
| 3 | **Brand payment per action** | ±$46K per $0.10 | High — depends on brand ROI perception |
| 4 | **Free-to-paid conversion** | ±$93K per 1pp | Moderate — meaningful but not dominant |
| 5 | **Monthly churn** | ±$25K per 1pp | Moderate — affects LTV more than near-term revenue |
| 6 | **B2B brand tool revenue** | ±$10K per brand | Moderate — stabilizing, not driving |

---

## Multi-Variable Scenarios

### Scenario: "Cold Start Failure"

What happens if brand partnerships underperform AND participation is low?

| Variable | Value (vs. Base) |
|---|---|
| VE participation | 10% (vs. 22%) |
| Brand payment/action | $1.50 (vs. $3.00) |
| Brand partners (B2B) | 20 (vs. 75) |
| All other variables | Base case |

| Year | Revenue | Costs | Net |
|---|---|---|---|
| Year 2 | $158K | $159K | -$1K |
| Year 3 | $892K | $713K | $179K |
| Year 5 | $6,100K | $2,228K | $3,872K |

**Result**: Near break-even in Year 2, slowly profitable. The model **survives** but grows slowly. Subscription and ambient revenue carry the load. Requires pivoting brand strategy or accepting lower growth.

### Scenario: "Viral Growth, Slow Monetization"

High user growth but monetization lags.

| Variable | Value (vs. Base) |
|---|---|
| MAU growth | Optimistic (850K Year 5) |
| VE participation | 12% |
| Free-to-paid conversion | 2% |
| Brand payment/action | $2.00 |

| Year | Revenue | Costs | Net |
|---|---|---|---|
| Year 2 | $220K | $195K | $25K |
| Year 3 | $1,620K | $880K | $740K |
| Year 5 | $16,200K | $3,200K | $13,000K |

**Result**: Profitable due to sheer scale, but revenue per user is low ($1.08/MAU/month vs. base $1.61). Would need to improve monetization or accept lower margins.

### Scenario: "Premium Product, Small Community"

Strong monetization but limited audience growth.

| Variable | Value (vs. Base) |
|---|---|
| MAU growth | Conservative (350K Year 5) |
| VE participation | 25% |
| Free-to-paid conversion | 7% |
| Brand payment/action | $4.00 |
| Premium ARPPU | $9.99/month |

| Year | Revenue | Costs | Net |
|---|---|---|---|
| Year 2 | $420K | $143K | $277K |
| Year 3 | $2,100K | $513K | $1,587K |
| Year 5 | $12,600K | $1,750K | $10,850K |

**Result**: Highly profitable with strong unit economics. Smaller user base but higher revenue per user ($3.00/MAU/month). Attractive as a lifestyle business or niche platform; less attractive to growth-stage VCs.

---

## Break-Even Surface

The break-even MAU depends on the combination of conversion rate and participation rate:

### Break-Even MAU (Year 2 Fixed Costs: $25K/month)

| | VE Participation 10% | VE Participation 15% | VE Participation 20% | VE Participation 25% |
|---|---|---|---|---|
| **Conversion 2%** | 32,000 | 24,000 | 19,500 | 16,700 |
| **Conversion 3%** | 28,500 | 22,000 | 18,000 | 15,500 |
| **Conversion 4%** | 25,500 | 20,000 | 16,500 | 14,500 |
| **Conversion 5%** | 23,000 | 18,500 | 15,500 | 13,500 |
| **Conversion 7%** | 19,500 | 16,000 | 13,500 | 12,000 |

**Key insight**: Even in the worst combination tested (2% conversion, 10% participation), break-even is at ~32K MAU — achievable within Year 2-3 in all scenarios.

---

## Critical Thresholds

### "Red Lines" — Values That Threaten Viability

| Variable | Threshold | Consequence |
|---|---|---|
| VE participation | < 8% | Brand revenue insufficient; model reverts to pure freemium SaaS |
| Free-to-paid conversion | < 1% | Subscription revenue negligible; need 100% reliance on brand revenue |
| MAU growth (sustained MoM) | < 3% | Never reaches scale for brand economics to work |
| Monthly paid churn | > 10% | LTV too low for any paid acquisition |
| Brand payment per action | < $1.00 | User earnings too small to motivate; premium unlock threshold unreachable |

### "Green Lines" — Values That Indicate Strong Product-Market Fit

| Variable | Threshold | Signal |
|---|---|---|
| VE participation | > 25% | Value exchange is resonating; brand revenue accelerates |
| Free-to-paid conversion | > 5% | Premium features are compelling; comparable to Duolingo/Strava |
| DAU/MAU | > 25% | Community is sticky; retention economics are strong |
| Monthly paid churn | < 4% | Users value the product; strong lock-in |
| Brand renewal rate | > 80% | Brands see ROI; revenue is predictable |

---

## What This Analysis Does NOT Model

1. **Competitive response**: If a major platform (Instagram, TikTok) launches similar pet-community features
2. **Regulatory shock**: A new regulation that restricts value-exchange mechanics
3. **Black swan events**: Pandemic-level disruptions to pet industry or digital advertising
4. **Currency fluctuations**: EUR/USD impact on DACH-focused, AWS-hosted business
5. **Platform risk**: Apple/Google app store policy changes affecting subscriptions or payments
6. **Team scaling non-linearities**: The human complexity of growing from 1 to 20+ people
