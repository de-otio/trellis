# Revenue Model

> **Note**: This document captures the original two-stream revenue concept. The model has since evolved to four streams with free basic access and voluntary contributions. See [financial-analysis/](../financial-analysis/) for the current, investor-grade revenue model with sourced assumptions and 5-year projections.

Two primary revenue streams, designed so neither requires attention extraction or data harvesting.

---

## Revenue Streams

### Brand Payments (Primary)

Brands pay per verified value action. The platform takes a cut.

| Action Type | Brand Pays | Platform Keeps | User Earns (as access credit) |
|---|---|---|---|
| Product review | $2-5 | $0.60-2.50 (30-50%) | $1.40-2.50 |
| Peer Q&A answer | $1-3 | $0.30-1.50 | $0.70-1.50 |
| Feedback survey | $0.50-2 | $0.15-1.00 | $0.35-1.00 |
| Endorsed recommendation | $3-8 | $0.90-4.00 | $2.10-4.00 |

See [02-brand-economics.md](02-brand-economics.md) for detailed pricing rationale.

### Optional User Fee (Secondary)

Users who prefer not to do value actions can pay a small monthly fee.

- Suggested range: $3-7/month
- Provides full platform access with no value actions required
- Serves as a **price anchor**: proves the value exchange is fair ("your contributions are worth $X/month")
- Also provides a clean, simple revenue stream independent of brand economics

---

## Unit Economics (Illustrative)

### Per-User Economics

Assumptions:
- Average user completes 4 value actions/month
- Average brand payment per action: $3
- Platform take rate: 40%

| Metric | Value |
|---|---|
| Brand revenue per user/month | $12.00 |
| Platform revenue per user/month | $4.80 |
| User access credit value/month | $7.20 |
| Equivalent subscription price | $5.00/month |

### Break-Even Scenario

| Cost | Monthly |
|---|---|
| Infrastructure (AWS) per user | ~$0.50 |
| Content moderation per user | ~$0.30 |
| Brand acquisition cost (amortized) | ~$1.00 |
| User acquisition cost (amortized) | ~$2.00 |
| **Total cost per user** | **~$3.80** |
| **Revenue per user** | **~$4.80** |
| **Margin per user** | **~$1.00** |

---

## Revenue Mix Scenarios

| Scenario | Value-Exchange Users | Paying Users | Monthly Revenue (10K users) |
|---|---|---|---|
| Mostly value-exchange | 80% | 20% | $48,400 |
| Balanced | 50% | 50% | $49,000 |
| Mostly paid | 20% | 80% | $49,600 |

The model is deliberately designed so that revenue is similar regardless of user preference. This removes the incentive to push users toward either option.

---

## Scaling Economics

- Brand payments scale with user base (more users = more valuable actions)
- Per-user costs decrease with scale (infrastructure, moderation tooling)
- Brand acquisition becomes easier with proof of concept data
- Network effects on the social side increase retention, reducing user acquisition costs

---

## Open Questions

- What's the minimum viable user base for the brand-payment model to work?
- How do we handle currency and pricing across markets?
- Should power users (high-quality, high-volume contributors) earn more than platform access (e.g., actual payouts)?
- What's the sensitivity to brand churn — how many brands leaving triggers a revenue crisis?
