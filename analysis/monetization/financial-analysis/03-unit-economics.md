# Unit Economics

All figures are per-user metrics unless otherwise stated. Three scenarios are presented; the base case is used for primary projections.

---

## Cost to Serve

### Variable Costs (Per MAU/Month)

| Cost Component | Early Stage (<50K) | Growth (50K-500K) | Scale (500K+) | Source |
|---|---|---|---|---|
| Infrastructure (AWS) | $0.02-0.04 | $0.015-0.03 | $0.01-0.02 | a16z "Cost of Cloud" 2024; Reddit ~$0.01-0.02; Duolingo ~$0.02-0.03 |
| Content moderation | $0.005-0.01 | $0.005-0.01 | $0.003-0.008 | ActiveFence: AI-assisted $0.001-0.005/item; human review $0.03-0.10/item |
| Payment processing (wallets) | $0.002-0.005 | $0.003-0.008 | $0.005-0.01 | Stripe/PayPal micro-transaction fees; scales with contributor % |
| Customer support | $0.005-0.01 | $0.005-0.01 | $0.003-0.008 | Zendesk 2024: $3-8/ticket; 1-3% contact rate |
| **Total variable cost/MAU/month** | **$0.03-0.07** | **$0.03-0.06** | **$0.02-0.05** | |

**Modeling assumption (base case)**: $0.04/MAU/month at <50K, declining to $0.025/MAU/month at 500K+.

### Fixed Costs (Monthly)

| Cost Component | Year 1 | Year 2 | Year 3 | Year 4 | Year 5 |
|---|---|---|---|---|---|
| Engineering (founder + contractors) | $8,000 | $15,000 | $30,000 | $55,000 | $80,000 |
| Community / moderation staff | $0 | $2,000 | $5,000 | $10,000 | $18,000 |
| Brand sales / partnerships | $0 | $3,000 | $8,000 | $15,000 | $25,000 |
| Marketing / growth | $1,000 | $3,000 | $8,000 | $15,000 | $25,000 |
| Legal / compliance | $500 | $1,000 | $2,000 | $4,000 | $6,000 |
| G&A (accounting, tools, insurance) | $500 | $1,000 | $2,000 | $3,000 | $5,000 |
| **Total fixed costs/month** | **$10,000** | **$25,000** | **$55,000** | **$102,000** | **$159,000** |

---

## Customer Acquisition Cost (CAC)

### Acquisition Channels

| Channel | Cost per Install | Conversion to MAU | Effective CAC | % of Acquisition |
|---|---|---|---|---|
| Organic (word of mouth, app store) | $0 | 40-60% | $0 | 50-70% (Year 1-2) |
| Content marketing / SEO | $0.50-2.00 | 30-50% | $1-4 | 15-25% |
| Social media (paid) | $1.50-5.00 | 20-35% | $5-15 | 10-20% |
| Referral program | $2-5 per referred user | 50-70% | $3-8 | 5-15% |
| Brand partner cross-promotion | $0.50-1.50 | 30-50% | $1-3 | 5-10% |

### Blended CAC by Stage

| Stage | Organic % | Blended CAC | Source Basis |
|---|---|---|---|
| Year 1 (community seeding) | 70% | $1.50-3.00 | High organic from existing Trellis community |
| Year 2 (growth) | 55% | $3.00-5.00 | Increasing paid mix |
| Year 3 (scaling) | 45% | $4.00-7.00 | Paid acquisition scaled |
| Year 4-5 (mature) | 40% | $5.00-8.00 | Liftoff 2024: consumer social $2-15/install; $20-60/paid subscriber |

**Key advantage**: Existing Trellis community provides a warm audience for Phase 1, significantly reducing early CAC.

---

## Lifetime Value (LTV)

### LTV Calculation Method

Using the **cohort-based discounted cash flow** approach:

```
LTV = Σ (monthly_revenue_per_user × survival_rate_month_n) for n = 1 to 36
```

Where survival rate follows an exponential decay from monthly churn:
```
survival_rate_month_n = (1 - monthly_churn)^n
```

### Churn Assumptions

| Scenario | Monthly Churn (Paid) | Monthly Churn (Free MAU) | Source |
|---|---|---|---|
| Conservative | 7% | 12% | ProfitWell B2C median: 6-8% |
| Base | 5% | 9% | Best-in-class consumer: 3-4%; we assume 5% as mid |
| Optimistic | 3.5% | 7% | Strava ~25-30% annual ≈ 2.4-2.9% monthly |

### LTV by User Segment (Base Case)

**Paid Subscribers**

| Metric | Value |
|---|---|
| Monthly ARPPU | $6.99 |
| Monthly churn | 5% |
| Average lifetime | 20 months (1/0.05) |
| **Gross LTV** | **$139.80** |
| Variable cost over lifetime ($0.035 × 20) | -$0.70 |
| **Net LTV** | **$139.10** |

**Value-Exchange Contributors (who unlock premium)**

| Metric | Value |
|---|---|
| Monthly platform revenue per contributor | $3.68 |
| Monthly churn | 4% (lower — engaged users churn less) |
| Average lifetime | 25 months |
| **Gross LTV** | **$92.00** |
| Variable cost over lifetime ($0.04 × 25) | -$1.00 |
| **Net LTV** | **$91.00** |

**Free Users (non-contributing)**

| Metric | Value |
|---|---|
| Monthly ambient revenue | $0.25 |
| Monthly churn | 9% |
| Average lifetime | 11 months |
| **Gross LTV** | **$2.75** |
| Variable cost over lifetime ($0.03 × 11) | -$0.33 |
| **Net LTV** | **$2.42** |

**Free Users (contributing but below unlock threshold)**

| Metric | Value |
|---|---|
| Monthly platform revenue | $1.50 (lighter contribution) |
| Monthly churn | 6% |
| Average lifetime | 17 months |
| **Gross LTV** | **$25.50** |
| Variable cost over lifetime ($0.035 × 17) | -$0.60 |
| **Net LTV** | **$24.90** |

### Blended LTV (Base Case)

| Segment | % of MAU | Net LTV | Weighted LTV |
|---|---|---|---|
| Paid subscribers | 4% | $139.10 | $5.56 |
| Value-exchange (premium unlock) | 10% | $91.00 | $9.10 |
| Value-exchange (below threshold) | 10% | $24.90 | $2.49 |
| Free (non-contributing) | 76% | $2.42 | $1.84 |
| **Blended** | **100%** | | **$18.99** |

---

## LTV:CAC Analysis

### By Scenario

| Scenario | Blended LTV | Blended CAC | LTV:CAC | Payback Period |
|---|---|---|---|---|
| Conservative | $12.50 | $5.00 | 2.5:1 | 14 months |
| Base | $18.99 | $4.00 | 4.7:1 | 8 months |
| Optimistic | $28.50 | $3.00 | 9.5:1 | 4 months |

**Benchmark**: a16z consumer: median 2.5:1, top quartile 4:1+. OpenView 2024: target 3:1+. SaaS Capital: best-in-class >5:1.

**Base case LTV:CAC of 4.7:1 is in the top quartile of consumer platforms.**

### By Acquisition Channel (Base Case)

| Channel | CAC | Blended LTV | LTV:CAC | Verdict |
|---|---|---|---|---|
| Organic | $0 | $18.99 | ∞ | Scale as much as possible |
| Content/SEO | $2.50 | $18.99 | 7.6:1 | Highly efficient |
| Referral | $5.00 | $22.00* | 4.4:1 | Good (referred users retain better) |
| Brand cross-promo | $2.00 | $18.99 | 9.5:1 | Excellent — leverage brand partners |
| Paid social | $10.00 | $18.99 | 1.9:1 | Marginal — use selectively |

*Referred users have ~20% higher LTV due to social connection at signup.

---

## Contribution Margin

### Per-User Contribution Margin (Base Case, Monthly)

| Metric | Paid Sub | VE Contributor | Free User |
|---|---|---|---|
| Revenue | $6.99 | $3.68 | $0.25 |
| Variable cost | -$0.035 | -$0.04 | -$0.03 |
| **Contribution margin** | **$6.96** | **$3.64** | **$0.22** |
| **Margin %** | **99.5%** | **98.9%** | **88%** |

### Blended Contribution Margin

| Metric | Value |
|---|---|
| Blended revenue/MAU/month | $1.61 |
| Blended variable cost/MAU/month | $0.035 |
| **Blended contribution margin** | **$1.58** |
| **Blended margin %** | **97.8%** |

Variable costs are very low per user. The business is **fixed-cost dominated** — profitability is driven by reaching sufficient MAU to cover fixed costs (team, marketing, compliance).

### Fixed Cost Coverage

```
Monthly fixed costs (Year 2) = $25,000
Contribution margin per MAU = $1.58
Break-even MAU = 25,000 / 1.58 = ~15,800 MAU
```

**The model breaks even at ~16K MAU in Year 2**, assuming base case participation and conversion rates.

---

## Gross Margin

| Year | Revenue | Variable Costs | Fixed Costs | Gross Margin | Gross Margin % |
|---|---|---|---|---|---|
| Year 1 | $84K | $4.8K | $120K | -$40.8K | -49% |
| Year 2 | $969K | $24K | $300K | $645K | 67% |
| Year 3 | $3.6M | $72K | $660K | $2.87M | 80% |
| Year 4 | $10.4M | $192K | $1.22M | $8.99M | 86% |
| Year 5 | $22.8M | $384K | $1.91M | $20.5M | 90% |

Gross margin improves with scale as fixed costs are spread across more users and variable costs per user decline.

---

## Key Metric Summary (Base Case)

| Metric | Value | Benchmark | Assessment |
|---|---|---|---|
| Blended LTV | $18.99 | — | — |
| Blended CAC | $4.00 | — | — |
| LTV:CAC | 4.7:1 | 3:1 target (OpenView) | **Above target** |
| Payback period | 8 months | 12 months target | **Below target (good)** |
| Blended ARPU (monthly) | $1.61 | Reddit $0.28, Nextdoor $0.46 | **Well above comps** |
| Paid ARPPU (monthly) | $6.99 | Strava $5, Discord $7.50 | **In range** |
| Contribution margin | 97.8% | — | Fixed-cost dominated |
| Break-even MAU | ~16,000 | — | Achievable Year 2 |
