# Operator Revenue Model

The operator earns transaction fees on payments flowing between tenants
and their B2B partners (relationship #2 in
[01-actors-and-relationships.md](01-actors-and-relationships.md)). The
operator is therefore a **payment intermediary**, not a pure SaaS
vendor. This changes the shape of the CRM problem materially: the
"system of record" for revenue *is* a system that handles money
movement, KYC, and tax reporting — not a notes-and-pipelines
application.

This doc anchors the rest of the analysis by making the operator's
economics concrete, naming the financial primitives needed, fixing
the rails (Stripe Connect), scoping geography (DACH/EU first), and
laying out the EU compliance footprint that follows.

## Inputs that shape this doc

- **Revenue model:** operator skims a fee on tenant↔partner payments.
- **Payment platform (MVP):** Stripe (specifically Stripe Connect).
- **Geographic scope (MVP):** DACH and EU.
- **Long-term roadmap:** expansion to China. Architectural decisions
  in this doc must not preclude it. Stripe does not operate in
  mainland China; the rails layer must be abstractable.
- **Tenant↔follower transactions:** out of scope for MVP. May or may
  not adopt the same fee model later — deferred.
- **Fee structure (rate, tiers, caps):** open. This doc defines the
  design space; the choice is deferred.

## What changes vs. earlier docs

`01-actors-and-relationships.md` called Bucket 2 (tenant's CRM) a
"lightweight relationship manager." That description does not survive
contact with the revenue model. With money flowing through the
relationship, Bucket 2 needs:

- KYC/KYB for partners receiving payouts
- Agreements with explicit commercial terms (rate, schedule, conditions)
- Payment events (invoices, payouts, refunds, disputes)
- Application-fee accounting (the operator's revenue, per transaction)
- Tax artifacts (VAT-compliant invoices, DAC7 reporting data)
- Payout destinations (bank accounts, with KYC linkage)

These primitives are not optional — they are the reason the platform
exists from the operator's revenue point of view. The CRM application
sits on top of them.

Bucket 1 (operator's CRM) also shifts: the central signals are now
GMV, take-rate, partner-roster growth, and dispute rates — not MRR
retention. The "push to Salesforce and you're done" framing in 01
needs walking back; see "Operator's revenue surface" below.

## The operator's role

The operator runs a **B2B partner-payment marketplace** scoped per
tenant. Each tenant uses the operator's platform to:

- Find / engage / manage relationships with partners (influencers,
  vendors, sponsors, freelancers)
- Agree commercial terms with those partners
- Pay them through the platform
- Receive consolidated reporting

The operator earns fees on those payments. The fee model is open
(see "Fee structure design space" below) but the *fact* of the fee
is the foundation of the business, not a feature.

## Payment rails: Stripe Connect (MVP), abstract layer for future rails

Stripe Connect is the payment platform for MVP and the EU rollout.
The operator is the "platform" in Stripe's vocabulary; partners are
"connected accounts."

**Architectural caveat (China-readiness):** Stripe does not operate
in mainland China. China requires Alipay, WeChat Pay, UnionPay, or
domestic acquirers under PBoC supervision. To preserve the long-term
roadmap, the data model must abstract over rails — Stripe Connect is
the *first concrete implementation*, not the only one possible. The
entity model below uses neutral terms ("Payout Account", "Rails
Provider") with Stripe-specific data held in a typed extension.
Concretely: do not name a database column `stripe_account_id` or
encode "Stripe" into enum values that would block adding a parallel
Alipay or WeChat Pay rail. See "Long-term: China expansion" below
for the broader implications.

Three Connect account types are relevant; the choice has large
downstream effects:

| Type | Onboarding UX | Operator data access | Compliance UX owner | Notes |
|---|---|---|---|---|
| Standard | Stripe-owned | Limited (no PII via API) | Stripe | Connected user has own Stripe dashboard, files own taxes/disputes. Lightest integration. |
| Express | Stripe-hosted, branded | Moderate | Mostly Stripe | Stripe-hosted onboarding form, lightweight dashboard. Most marketplaces start here. |
| Custom | Operator-owned | Full | Operator | Operator builds all UX. Deepest integration, biggest compliance burden. |

**Default recommendation: Express.** Custom is significantly more
work and the compliance UX is a regulated surface where mistakes are
expensive. Standard pushes too much off the platform — partners
having their own Stripe dashboard fragments the experience and
limits the operator's data view, which the CRM needs.

Charge model also matters and is a separate axis:

| Model | Merchant of record | Refund / dispute liability | Operator's revenue |
|---|---|---|---|
| Direct charge on connected account | Connected account (partner) | Connected account | Application fee |
| Destination charge on platform, transfer to connected | Platform (operator) | Platform | Application fee + retained portion |
| Separate charges and transfers | Platform | Platform | Full charge, manual transfer |

**Default recommendation: Destination charge.** It places the
operator as merchant of record (which matches the platform's role
in the relationship), keeps refund/dispute control on the platform
side, and supports the application-fee model cleanly. Direct charge
puts the partner as MoR, which complicates the operator's tax /
reporting surface.

These are defaults to validate, not final decisions. A subsequent
doc on Stripe integration design should ratify or revisit them.

## Geographic scope: DACH/EU and what it implies

DACH = Germany, Austria, Switzerland. EU = the broader scope. This
choice carries specific regulatory consequences that must be in the
data model from day one — adding them later is expensive.

### DAC7 (EU Directive 2021/514)

The hard one. In force since 1 January 2023, with first annual
reporting due 31 January 2024 for tax year 2023.

- **Who reports:** "Reporting Platform Operators" — the operator
  qualifies the moment partners earn money through the platform.
- **What's reportable:** "personal services" (freelance, influencer
  work), sale of goods, rental of property/transport. Influencer and
  vendor relationships are squarely in scope.
- **Threshold per seller (partner):** > 30 activities OR > €2,000
  per calendar year — below the threshold, the partner does not need
  to be reported, but the data must still be retained.
- **Data the operator must collect:** legal name, address, TIN
  (Tax Identification Number), VAT-ID (where applicable for
  business partners), bank account number / IBAN, country of
  residence, fees received, taxes withheld.
- **Reporting:** annual XML submission to one chosen EU member
  state's tax authority; the receiving state shares with other
  member states.
- **Penalties:** vary by member state. Germany: up to €50,000 per
  failure. Real money.
- **Cannot be delegated to Stripe.** Stripe provides data exports
  but the operator is the Reporting Platform Operator; the filing
  obligation sits with the operator.

DAC7 essentially mandates the partner data model. Names, addresses,
TINs, VAT-IDs, bank accounts, country, and per-year transaction
totals must be in the schema. This affects the Bucket 2 design
directly.

### VAT in DACH

- **Germany:** Umsatzsteuer 19% standard, 7% reduced. § 22f UStG
  imposes additional marketplace operator obligations (predates
  DAC7 but stacks with it).
- **Austria:** Umsatzsteuer 20% standard.
- **Switzerland:** not EU. MWST 8.1% standard. Separate regime;
  cross-border services into Switzerland trigger Swiss VAT
  registration thresholds.

Key open question: **who is the merchant of record on the
tenant→partner payment?** If destination charge with the operator
as MoR, the operator may need to issue VAT-compliant invoices for
its own platform fee, while the partner's underlying service is a
separate VAT event between partner and tenant (often B2B reverse
charge). Stripe Tax can help with the platform-fee VAT calculation
but doesn't resolve the underlying transaction's VAT treatment —
that's the operator's job to model.

This is genuinely complex and may need an external tax advisor's
review before MVP launch. Flag it now; don't paper over it.

### PSD2 / SCA

EU's Strong Customer Authentication regime. Stripe abstracts most
of this for card payments via 3DS2. Worth naming so it doesn't get
discovered later, but not a major engineering item if Stripe
Connect is the rails.

### GDPR

Financial transaction data, KYC documents, and partner
identification data are all personal data under GDPR. Subject to:

- Lawful basis (legitimate interest for operating the marketplace;
  legal obligation for DAC7 reporting)
- Data minimisation (don't collect more than DAC7 / KYC need)
- Subject access / erasure rights (with exemptions for legal
  retention obligations — DAC7 mandates retention of reportable
  data for 5 years)
- Cross-border transfer (Stripe processes data in the US under
  SCCs; document this)

Not novel — the platform handles personal data already. But the
financial data raises the sensitivity tier and the retention rules
are stricter.

## Financial primitives Bucket 2 needs

Entity sketch for the tenant-side CRM extension once revenue is in
the picture. This supersedes any "contact + interaction history"
sketch:

| Entity | Owner | Notes |
|---|---|---|
| **Partner** | Tenant | The relationship target. Individual or business. Has zero or more on-platform user accounts. |
| **Payout Account** | Partner (1:N possible) | Rails-agnostic record of where the partner gets paid. Has a typed `rails` field (e.g. `stripe_connect`, `alipay`, `wechat_pay`) and rails-specific extension data. KYC/KYB status, country, currency. |
| **Agreement** | Tenant + Partner | Commercial terms: scope, rate model, schedule, conditions. Generates Payments. |
| **Payment** | Operator (system of record) | Charge / payout / refund. References Agreement, parties, amounts, fee components, status. Rails-tagged. |
| **Platform Fee** | Operator | Operator's slice of a Payment. The operator's revenue, per-transaction. (Called "application fee" in Stripe, "service fee" in others — neutral name in the schema.) |
| **Tax Artifact** | Operator | Polymorphic by jurisdiction: VAT-compliant invoice + DAC7 report row (EU); fapiao + PIPL retention record (China); 1099 (US, if ever). Aggregated from Payments. |
| **Engagement** | Tenant + Partner | On-platform activity (posts, mentions, collaborations). Pre-existing Trellis data; surfaced in CRM. |

The CRM application is the UX over these primitives. The financial
primitives themselves are not a "CRM feature" — they are the
operator's revenue engine, with CRM on top.

## Long-term: China expansion

The roadmap includes mainland China. China is a separate regulatory,
payment, and identity regime; the architecture must accommodate it
without rewriting the data model. Treating it as "later" without
naming the implications now would lock in EU-specific decisions that
are expensive to undo.

The major axes of difference, all of which need to flow into the
data model and the deployment topology:

### Payment rails

- **Stripe does not operate in mainland China.** Card payments are a
  rounding error; Alipay and WeChat Pay dominate consumer-side, and
  UnionPay covers cards. For B2B partner payouts, options include
  domestic Chinese acquirers (PingPong, LianLian Pay, XTransfer) or
  Stripe's cross-border products (Stripe China outside mainland; not
  the same as having Stripe Connect inside China).
- **Implication:** the rails layer must be polymorphic. The Payout
  Account, Payment, and Platform Fee entities all carry a `rails`
  discriminator. Concrete rails-specific data lives in a typed
  extension table, not in the core schema.

### Foreign exchange controls

- **SAFE (State Administration of Foreign Exchange)** regulates
  cross-border money movement for both individuals and businesses.
  Onshore CNY (CNY) and offshore CNY (CNH) trade at different rates.
  Moving fees out of China requires specific licences and channels.
- **Implication:** the operator's fee collection model differs in
  China. May require a domestic Chinese subsidiary or partnership
  with a licensed Chinese payment institution. Settlement currency
  for the operator's own revenue may need to be CNH or routed via
  Hong Kong.

### Tax invoicing

- **Fapiao (发票)** is the Chinese tax-invoice system, a fundamentally
  different concept from EU VAT receipts. Special VAT fapiao
  (增值税专用发票) are required for B2B input-tax credit. Fapiao
  issuance is regulated, often involving registered fapiao printers
  or e-fapiao through Golden Tax System integrations.
- **Implication:** the Tax Artifact entity cannot be VAT-shaped only.
  It must be polymorphic by jurisdiction with a discriminated-union
  data shape — DAC7 / VAT for EU; fapiao + PIPL retention for China.

### Data localisation (PIPL + Cybersecurity Law)

- **PIPL (Personal Information Protection Law, in force 2021)**
  imposes strict rules on processing personal data of individuals in
  China, including financial and KYC data. Cross-border transfer
  requires one of: security assessment by CAC, certification, or
  approved standard contract.
- **Cybersecurity Law** imposes additional localisation duties for
  "Critical Information Infrastructure Operators" (CIIO).
- **Implication:** Chinese-resident partner data likely cannot leave
  China without a CBDT (Cross-Border Data Transfer) mechanism. This
  almost certainly forces a separate regional deployment (Trellis-CN)
  with its own database, possibly its own Trellis instance. The
  multi-tenant model needs to admit a "region" dimension above
  "tenant."

### Real-name verification and KYC

- China requires real-name verification (实名认证) for many platform
  activities. ID-card based, with PBoC-supervised verification
  channels. Different from EU KYC tiers.
- **Implication:** the KYC subsystem in the Payout Account entity
  must be regime-aware, not a single global procedure.

### Currency

- CNY (onshore) and CNH (offshore) are distinct corridors. RMB
  settlement requires careful accounting.
- **Implication:** the Currency field on Payment and Platform Fee
  must carry corridor information, not just an ISO code.

### What this means for MVP design

- **Use neutral entity names.** "Payout Account" not "Connect Account",
  "Platform Fee" not "Application Fee", "Rails Provider" not
  "Stripe."
- **Make the rails layer pluggable.** A rails-provider interface
  with Stripe Connect as the first implementation. Adding Alipay /
  WeChat Pay / UnionPay later is a new implementation, not a schema
  migration.
- **Make tax artifacts polymorphic from day one.** Even if MVP only
  emits VAT/DAC7 artifacts, the schema admits other shapes.
- **Plan for region-level isolation as a future state.** The data
  model should not assume a single global database; the access
  layer should be region-routable. MVP can be single-region; the
  architecture must not preclude multi-region.
- **Do not make ChinaSupport an MVP feature.** Building it now is
  premature. Just don't paint over the door.

A future doc (`10-china-expansion-readiness.md`) will lay this out
in implementation detail when China expansion becomes near-term.

## Build vs. buy at the rails layer

The build-vs-buy line is sharp here:

- **Buy** (do not build): payment processing, KYC/KYB collection,
  card-network compliance, money-transmitter licensing, payout
  routing, dispute handling primitives. **Stripe Connect.**
- **Buy** (use, don't build): VAT calculation on platform fees
  (Stripe Tax), 3DS2 (Stripe), connected-account onboarding UX
  (Stripe Express).
- **Build** (operator's job): the partner-relationship CRM, the
  agreement model, application-fee logic, DAC7 data collection
  and reporting, marketplace-ops dashboards, take-rate analytics,
  tenant-facing payment-management UX.

The "narrowed Direction B" from doc 01 is now precisely:
*build the application layer (CRM + agreements + reporting +
dashboards) on top of Stripe Connect's rails*. Nothing financial
or regulatory is built from scratch.

## Operator's revenue surface (Bucket 1 revisit)

In `01-actors-and-relationships.md` Bucket 1 was framed as "push
signals to the operator's existing CRM." With marketplace economics
that framing is incomplete:

- "Tenant health" → tenant GMV, partner roster size, take-rate
  dilution, payment frequency, average payment size, dispute rate,
  failed-payment rate
- "Pipeline forecast" → GMV × take rate × cohort retention, not
  ARR retention
- "Renewal" → not a primary motion; tenants don't renew, they
  transact more or less

Salesforce / HubSpot pipelines model these awkwardly. The operator
likely needs a **bespoke marketplace-ops surface** (or a
revenue-ops tool like Maxio / Chargebee / Stripe Sigma bolted on)
in addition to whatever sales-CRM the commercial team uses for
tenant onboarding and account expansion.

This means Bucket 1 splits into two sub-surfaces:

1. **Sales / CS CRM** for the human-managed tenant relationship
   (still a candidate for Salesforce / HubSpot push)
2. **Marketplace-ops dashboard** for the transaction-volume,
   take-rate, and risk views (almost certainly bespoke, fed by
   Stripe + Trellis transaction data)

The two share data but not UX. A later doc on Bucket 1 should
treat them as separate work items.

## Fee structure design space

The fee structure is open. Naming the axes so the eventual choice
is informed:

- **Rate basis:** flat percentage of transaction, flat per-transaction
  fee, hybrid (% + fixed), tiered by volume, capped per transaction.
- **Subscription overlay:** pure transaction fee vs. base
  subscription + lower transaction fee. Affects unit economics and
  small-tenant viability differently.
- **Tier triggers:** per-tenant volume tiers (lower rate above
  threshold), partner-volume tiers, time-based promotional rates.
- **Cross-side allocation:** fee paid by tenant (payer), partner
  (payee), or split. Affects partner experience and competitive
  positioning vs. direct-payment alternatives.
- **Currency / FX handling:** fees on gross or net of FX margin;
  whether the operator captures FX spread or passes through.
- **Refund / dispute behaviour:** does the operator return its fee
  on refunds (most marketplaces do) or retain it (rare, painful for
  customers).

For reference points without prescribing: generic SaaS marketplaces
typically run 2–5%; influencer / creator marketplaces 10–15% (often
higher); high-touch B2B service marketplaces 5–15%. The right number
depends on the value delivered relative to alternatives the partner
or tenant has.

A later doc should pick a model with explicit unit-economics
modelling against expected GMV and partner volumes.

## Open questions

Net-new questions surfaced by the revenue model that earlier docs
did not need to address:

1. **Express vs. Custom Connect accounts.** Default is Express; ratify
   in a Stripe-design doc.
2. **Direct vs. destination charge.** Default is destination; same.
3. **Merchant-of-record decision and its VAT consequences in DACH.**
   Likely needs external tax advice.
4. **DAC7 ingest and report generation.** Owned by the operator;
   needs build effort. Annual cycle, first deadline lands ~13 months
   after MVP launch — not an MVP-day-one feature, but the data
   schema must support it from day one.
5. **Fee structure model.** Open by design; needs unit-economics work.
6. **Marketplace-ops dashboard scope.** Bespoke vs. bolt-on
   (Stripe Sigma, Maxio, Chargebee). Affects build size.
7. **Refund / dispute UX ownership.** Tenant-managed vs.
   operator-managed vs. Stripe-Express-managed. Operational, not
   technical.
8. **Currency support.** EUR + CHF day-one; GBP for non-EU EU
   business; USD for cross-border partners. Each FX corridor adds
   complexity. CNY/CNH deferred to China-readiness work.
9. **Rails-abstraction depth at MVP.** How thin can the rails
   abstraction be before it becomes either a leaky proxy for Stripe
   Connect or an over-engineered framework? Likely: typed
   discriminator + minimal interface (initiate payment, record
   payout, record fee, capture KYC status), with each rails
   implementation owning the rest. To validate when designing the
   schema.

## What this changes in earlier docs

The README and `01-actors-and-relationships.md` need updates:

- README: the three-direction framing now narrows further — the
  build is *application layer on Stripe Connect rails*, not "fully
  custom CRM." Update the Direction B description.
- 01: walk back "lightweight relationship manager" for Bucket 2.
  Replace with the financial-primitives entity sketch from this
  doc. Bucket 1 description splits into sales-CRM + marketplace-ops
  surfaces. Add a forward reference to this doc.

These updates can be a follow-up commit; they're cross-references
and rewordings, not new analysis.

## Updated doc plan

Inserts this doc and renumbers downstream items:

1. `01-actors-and-relationships.md` — actors, relationships, buckets
2. **`02-operator-revenue-model.md` — this doc**
3. `03-engagement-signals-inventory.md` — what data Trellis has today
4. `04-bucket-1-operator-crm.md` — sales-CRM + marketplace-ops
   surfaces, signal flows from Stripe + Trellis
5. `05-bucket-2-tenant-crm.md` — first-party tenant-side extension;
   data model rooted in the entities defined here
6. `06-stripe-connect-design.md` — account type, charge model, MoR,
   fee mechanism, error / dispute / refund flows
7. `07-tenant-side-export.md` — pushing Bucket 2 data to a tenant's
   own external CRM
8. `08-fee-structure.md` — unit economics, model selection
9. `09-recommendation.md` — synthesis and recommended path
10. `10-china-expansion-readiness.md` — detailed analysis when
    China expansion becomes near-term; covers rails (Alipay /
    WeChat Pay / UnionPay), data localisation (PIPL, CBDT
    mechanisms), tax (fapiao), FX (SAFE / CNH), and deployment
    topology

Doc 06 is new and load-bearing — Stripe Connect design choices
constrain everything in 04 and 05. Doc 10 is deliberately
post-recommendation: MVP doesn't need to solve China, only avoid
locking it out.
