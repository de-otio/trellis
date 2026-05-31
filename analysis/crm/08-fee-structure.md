# Fee Structure

Doc 02 named the fee structure as the operator's revenue
foundation but left the choice open. Doc 02's "Fee structure
design space" enumerated the axes (rate basis, subscription
overlay, tier triggers, cross-side allocation, FX handling,
refund / dispute behaviour) and gave reference points (2-5% for
generic SaaS marketplaces, 10-15% for influencer / creator,
5-15% for high-touch B2B service marketplaces). This doc picks.

The output: a recommended fee model with worked unit economics,
a competitive-positioning sanity check against tenant
alternatives, and a list of the parameters the operator must
ratify before MVP launch.

## Caveats and scope

- **Numbers in this doc are illustrative.** Stripe Connect fee
  structures change; the unit-economics worked examples use
  approximate 2026-vintage EU rates and need re-verification at
  implementation time.
- **DACH/EU MVP scope.** Currency assumptions are EUR-centric.
  CHF, GBP, USD are admitted but not central. CNY/CNH deferred
  to doc 10.
- **Operator-decided.** This doc recommends, the operator
  ratifies. The recommendation is based on the structural
  argument; the actual tier numbers need the operator's GMV
  forecast and tenant ICP as input, both of which sit outside
  this analysis.
- **Doc 02 establishes the rails.** Stripe Connect with
  destination charges; operator as MoR; application fee as the
  revenue mechanism. Doc 06 details the implementation. The
  fee structure designed here is **applied on top of** Stripe's
  underlying processor fees, not an alternative to them.

## The cost stack

Before picking a fee, the operator's cost per transaction
needs to be understood. Approximate per-payment costs in EU at
time of writing (verify against current Stripe pricing):

### Direct rails costs (Stripe Connect)

For a typical €100 transaction via destination charge:

| Component | Approximate cost | Notes |
|---|---|---|
| Card processing (EU consumer cards) | ~1.5% + €0.25 | Stripe's underlying card-processing fee |
| Cross-border / non-EU card | +1% | If the tenant's card is non-EU |
| Currency conversion | +1% | If the payment currency differs from settlement |
| Connect platform fee | 0.25% + €0.10 | Stripe's fee for using Connect |
| SEPA debit (alternative) | 0.8%, capped €5 | Cheaper for high-value EUR payments |
| Dispute fee (per dispute) | ~€15 | Whether won or lost |

A "vanilla" €100 EU-consumer-card transaction therefore costs
the operator approximately **€2.10** in Stripe fees alone (card
+ Connect platform fee). A €1,000 transaction costs ~€18.50. A
€10 transaction costs ~€0.46 (the fixed €0.10 + €0.25 dominates
proportionally).

### Operator-side fixed and overhead costs

Per transaction the operator also spends on:

- **DAC7 reporting infrastructure.** Annual cost amortised
  across reportable transactions. Very low at scale; non-trivial
  in the first year (one-time build cost from doc 02 / 04 / 05).
- **Compliance overhead.** External tax advisor, periodic audit,
  legal review of agreement templates. Overhead, not per-tx.
- **Support.** Time spent handling disputes, KYC stuck, partner
  onboarding issues. Per-tx allocation depends on volume; crude
  approximation in worked examples below.
- **Bad debt.** Disputes lost, fraud chargebacks beyond Stripe's
  protection. Estimate 0.1-0.5% of GMV depending on tenant ICP.
- **Trellis hosting + ops.** ECS / RDS / DynamoDB / SQS share
  per transaction. Nominal at MVP scale (well under €0.01 per
  transaction).

### Implied floor

For an EU consumer-card transaction model:

- Stripe direct: ~2.1% + €0.10 + €0.25 = **~€2.35 + 0% margin
  on a €100 tx**
- Operator overhead: assume 0.5-1% allocation
- Bad-debt provision: 0.2-0.5%
- **Total cost stack: ~3-4%** before any operator margin

A fee below 4% is taking pure cost-recovery risk; a fee at 5%
gives ~1-2% margin; a fee at 10% is a healthy product margin
typical for a value-added marketplace.

The floor moves up for low-value transactions (€10 ticket size
flips the fixed €0.10 + €0.25 into ~3.5% of gross) and down for
high-value transactions or SEPA-dominated flows (€10k SEPA at
€5 cap is ~0.05%).

## Reference points (re-anchored from doc 02)

What comparable marketplaces actually charge:

| Marketplace | Approximate effective rate | Notes |
|---|---|---|
| Stripe (the underlying processor) | 1.5%-2.9% + €0.25-0.30 | Not a marketplace fee — the cost the operator inherits |
| Eventbrite | 3.7% + €1.79 (per ticket) | Variable plus subscription tiers |
| Etsy | 6.5% + listing | Plus payment processing fees |
| Substack | 10% | Plus Stripe fees |
| Patreon | 5%-12% | Tiered by plan |
| Gumroad | 10% | Plus Stripe fees |
| Upwork | 10% | Recently moved from sliding scale |
| Faire | 15-25% | First-order vs. reorder split |
| Aspire / Grin (influencer mgmt) | $1k-5k/month SaaS | No transaction fee, but high fixed cost |

Two patterns emerge:

- **Commodity / volume marketplaces** (Stripe, Eventbrite, Etsy)
  cluster at 3-7%. Differentiation low, switching cost low, fee
  pressure constant.
- **Niche / value-added marketplaces** (Substack, Patreon,
  Gumroad, Faire) cluster at 10-15%+. Higher service intensity,
  more lock-in via audience / catalogue effects.
- **SaaS-only platforms** (Aspire, Grin) charge fixed, not
  per-transaction. Different go-to-market.

A tenant-side B2B partner-payment marketplace integrated with
engagement signals sits closer to the niche / value-added end.
The fee should reflect the differentiation, not race to 3%.

## Recommended model

**Tiered percentage of gross transaction volume, paid by
partner (deducted from payout), with refund-fee policy.**

Concrete shape (numbers illustrative — operator validates):

| Tier | Monthly GMV per tenant | Fee on gross |
|---|---|---|
| Starter | < €10,000 | 7% |
| Growth | €10,000 - €100,000 | 5% |
| Scale | > €100,000 | 4% |
| Enterprise | Negotiated | floor 3.5% |

Plus:
- **Cross-side allocation:** partner pays (taken from gross
  before payout). Tenant pays €100 → partner receives €93 at
  Starter tier.
- **Currency / FX:** charged in transaction currency. No FX
  margin captured at MVP. Stripe's FX rates pass through.
- **Refund policy:** within 30 days of payment, full fee
  refunded to partner; > 30 days, fee retained as cost
  recovery.
- **Dispute lost:** fee retained (operator separately absorbs
  the €15 dispute fee from Stripe).
- **No subscription overlay at MVP.** Pure transaction fee.
  Enterprise tier may layer a subscription on later.

### Why this model

- **Tiered**: the operator's per-transaction cost is closer to
  flat than tiered. The tier discount reflects fairness as
  tenants grow (the operator's cost-to-serve doesn't scale
  proportionally to GMV) and removes a competitive opening for
  enterprise tenants to negotiate aggressively.
- **Percentage-based**: matches the partner's mental model
  ("you take a cut"). Flat per-transaction would punish small
  payments unfairly and reward large ones beyond what the cost
  curve justifies.
- **Partner pays**: cleanest VAT picture (partner's revenue is
  net of fee), matches the conventional creator/marketplace
  model, makes the fee visible to the partner (correct — it's
  their cost). Tenant doesn't have to budget +X% on top of
  their agreed amount.
- **Refund within 30 days returns fee**: standard
  consumer-friendly behaviour. Partners absorb the small
  operational cost on legitimate refunds; tenants don't see a
  surprise fee retention.
- **No subscription at MVP**: keeps the SMB on-ramp clean.
  Tenants with low transaction volume can use the platform
  with no fixed commitment. The downside (operator earns
  nothing on slow-ramping tenants) is bounded by the per-tenant
  cost of being on the platform, which is mostly KYC overhead
  for partners that already exist.

### Why not the alternatives

- **Pure flat percentage** (e.g. 5% across the board): simpler,
  but loses the enterprise margin to negotiation pressure.
  Tier structure pre-empts that.
- **Tenant pays**: forces the tenant to budget +X% on top of
  agreed amounts. Most tenants will resist. Also creates VAT
  ambiguity in destination-charge model — the platform fee VAT
  layer becomes a tenant-side concern instead of a partner-side
  one.
- **Hybrid (% + flat)**: works but the flat element punishes
  low-value transactions unfairly. Stripe's underlying fee is
  already flat-plus-percentage; double-stacking is hostile.
- **Subscription + lower transaction fee**: lock-in plus
  predictable revenue, but kills the SMB on-ramp. Workable
  for enterprise tier post-MVP.
- **FX margin captured by operator**: cheap revenue but partner
  hostility cost is real. Defer.
- **Volume tiers per partner instead of per tenant**: harder to
  message, harder to model, partners would shop across tenants
  to find best rate. Tenant-volume tiering matches the
  operator's actual cost curve.

## Worked unit economics

Three tenant archetypes, illustrative GMV and partner counts:

### Starter tenant — €2,000/month GMV, 30 active partners

- Operator gross fee: 7% × €2,000 = **€140/month**
- Stripe direct cost on €2,000 (avg €30/transaction across 67
  payments): ~€80
- Operator gross margin per month: ~€60
- Operator overhead per tenant per month (support, KYC events,
  hosting share): allocate €30
- **Operator net margin: ~€30/month per tenant**

A starter tenant is barely profitable. The operator's interest
is in conversion to Growth tier, not in extracting Starter
revenue.

### Growth tenant — €50,000/month GMV, 150 active partners

- Operator gross fee: 5% × €50,000 = **€2,500/month**
- Stripe direct cost on €50,000 (avg €100/tx, 500 payments):
  ~€1,180
- Operator gross margin: ~€1,320/month
- Operator overhead allocation: ~€150
- **Operator net margin: ~€1,170/month per tenant**

A Growth tenant is the unit-economics target. ~50% net margin
on a healthy fee model.

### Enterprise tenant — €500,000/month GMV, 800 active partners

- Operator gross fee: 4% × €500,000 = **€20,000/month**
- Stripe direct cost on €500,000 (mix of card and SEPA, avg
  rate ~1.5%): ~€7,500
- Operator gross margin: ~€12,500/month
- Operator overhead (more KYC, more support): ~€500
- **Operator net margin: ~€12,000/month per tenant**

Enterprise tenants drive the business. Margin per tenant is
~60% at this scale; absolute revenue per tenant is the lever.

### Sensitivity to ticket size

The above assumes mid-range ticket sizes (€30-€100). For
high-volume / low-ticket flows (e.g. €5 tipping payments at
volume), Stripe's fixed component dominates and operator
gross margin compresses sharply. A tenant doing €10,000/month
in €5 tickets sees Stripe direct cost approach 6-8% of GMV.
The 5%-7% fee no longer covers it.

**Implication:** the fee structure assumes ticket sizes >
€20-30 typical. Tenants with sub-€20 average ticket sizes
need either a different fee model (flat-plus-percentage to
cover fixed costs) or are not target customers at MVP.

## Competitive positioning

A tenant looking at Trellis-with-this-fee against alternatives:

| Alternative | Money cost | Time / risk cost | Trellis differentiation |
|---|---|---|---|
| Direct bank transfer | 0% | High: tenant invoices, partner invoices, no central record, manual VAT, tenant becomes partner's tax form preparer | Trellis: rails + DAC7 + integrated CRM |
| PayPal / Wise | ~3-4% | Medium: no compliance support, no engagement linkage | Trellis: compliance + engagement context |
| Influencer-marketing SaaS (Aspire, Grin) | ~$2k-5k/month + 0% per-tx | Low: handles the workflow but separate from content platform | Trellis: integrated with the platform tenants already use; no separate login |
| Build it themselves | 0% per-tx + €€€ engineering | Very high: KYC, DAC7, fraud, disputes, banking integrations | Trellis: bought, not built |

The pitch: a tenant pays 5-7% for **rails + compliance +
integrated CRM + engagement context**. The 5% looks expensive
versus 0%-direct-bank but cheap versus the realistic
alternatives once compliance and integration are priced in.

The fee fails the test when:

- Tenant has < 5 partners and very low ticket sizes (no scale
  to amortise compliance overhead).
- Tenant has internal payment ops (large enterprises with
  treasury teams) and prefers to integrate Stripe directly
  themselves.
- Tenant is in a regulated industry (financial services,
  pharma) where the operator's compliance posture doesn't
  match.

These are not target customers at MVP. The recommendation is
to lean into the tenants for whom the fee is clearly worth it.

## Refund and dispute fee behaviour

Stripe's behaviour on refunds (per doc 06): the application fee
is refunded by default unless the operator opts out. Operator
default: refund the application fee within 30 days of original
payment; retain after 30 days.

The 30-day window matches typical commerce refund windows and
gives the operator cost recovery on goodwill refunds while
not penalising legitimate consumer refunds.

Dispute lost: fee retained always. The operator absorbs the
€15 Stripe dispute fee as a separate cost. This is consistent
with marketplaces that hold the dispute liability — the fee
on the original transaction was earned through the rails work
that was performed; the dispute is a separate failure event.

Per-tenant configurability of these defaults is a future
feature, not MVP. Some enterprise tenants may negotiate a
"fee always retained" or "fee always refunded" policy as part
of their contract; admit it in the schema (the Agreement's
`rateModel` JSONB has room) but don't ship a UX for it at
MVP.

## FX and currency

MVP behaviour:

- **Settlement currency** matches transaction currency. Tenant
  pays in EUR; partner is paid out in EUR. Tenant pays in CHF;
  partner is paid out in CHF (assuming partner's PayoutAccount
  is CHF, per doc 06's "constrain at agreement time" call).
- **Cross-currency transactions** (tenant in EUR, partner in
  CHF): rejected at agreement creation. Doc 06's recommendation.
  Loosen post-MVP if real demand exists.
- **Operator's revenue (PlatformFee)** is in transaction
  currency. The operator does not consolidate to a single
  reporting currency at the rails layer; financial reporting
  consolidation is a separate, ops-side concern.
- **No FX margin** captured. Stripe converts at Stripe's rate;
  the spread accrues to Stripe, not the operator.

Reasoning: FX margin adds two failure modes — partner
perception ("operator skims the FX too?") and accounting
complexity. Defer until the FX volume is meaningful and there
is a clear case.

## Promotional / introductory pricing

Operator may want introductory rates for early tenants
(reduced fee for first 6 months, waived setup, etc.). The
schema admits this:

- Agreement's `rateModel` carries `effectiveFrom` /
  `effectiveTo` and per-period rates.
- A tenant signing under an "introductory rate" Agreement gets
  the lower rate until the introductory period ends; standard
  Agreement renewal applies the standard tier.

Promotional pricing is an operator-side product decision, not a
fee-structure decision. The schema and the rates above
accommodate it without modification.

## Open questions

1. **Final tier thresholds.** The 7% / 5% / 4% / 3.5% numbers
   are illustrative. Operator validates against:
   - Realistic GMV distribution forecast (where do tenants
     actually land?)
   - Competitor pricing in target verticals
   - Tenant willingness-to-pay research
2. **Promotional rate strategy.** First-year rates? Founder-
   tenant programs? Cohort-based discounts? Operator-side
   product decision.
3. **Negotiated enterprise rates.** How much variation from
   tier rates is admitted? "Enterprise floor 3.5%" implies
   negotiation is OK below 4%; the floor needs ratification.
4. **Fee transparency in tenant UI.** How prominently does the
   fee appear in the payment-creation flow? Suggested:
   "you pay €100 → partner receives €95 (5% Trellis fee)" as
   a visible line item, not a footnote.
5. **Fee transparency in partner UI.** Express dashboard shows
   the fee on payouts. Per doc 06 the dashboard branding is
   limited; the fee transparency Stripe provides is the level
   the partner sees.
6. **Annual vs. monthly volume tiers.** Monthly is simpler;
   annual is more forgiving of seasonal businesses. MVP:
   monthly. Revisit if seasonality complaints surface.
7. **Cliff vs. ramp at tier boundaries.** Tenant at €9,999 GMV
   crosses to €10,001 — does the entire month re-price at the
   lower tier, or does the marginal volume? Marginal is
   fairer; whole-month is simpler. Recommendation: marginal,
   computed at month-end, applied retrospectively. Operator-
   side billing complexity, not tenant-visible.
8. **Sub-€20 ticket-size handling.** Tenants in this regime
   need a different fee shape. Option: per-tenant
   negotiated rate for low-ticket flows, off-tier. Defer until
   such a tenant appears.
9. **Multi-currency consolidated tier counting.** Tenant's
   GMV across EUR + CHF + GBP for tier qualification — at
   what FX rate? Recommendation: monthly average ECB rate,
   converted to EUR for tier-counting only. Settlement and
   PlatformFee are in transaction currency.

## What this doc deliberately does not decide

- Pricing for the export feature (doc 09's territory).
- Pricing of the Bucket 2 CRM extension itself, separate from
  the transaction fee. Could be free (cost recovered through
  fees) or a per-seat / per-tenant subscription. Operator-side
  product decision; doc 09 may rule.
- Specific tenant-onboarding contract terms (annual commits,
  termination rights, audit rights) — legal team's domain.
- Promotion strategy beyond "the schema admits promotional
  rates."
- China-jurisdiction fee structure. Doc 10 territory; the
  EUR-centric assumptions here do not transfer.
- Fees on tenant↔follower transactions (Bucket 3, out of scope).
- Whether the fee changes when an Agreement involves a
  high-risk vertical (gambling, adult, regulated goods). Risk
  surcharges are a known marketplace pattern but require risk
  classification work that's downstream.
