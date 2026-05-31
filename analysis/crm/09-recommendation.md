# Recommendation

This doc synthesises docs 01-08 into a single recommended path,
sequences the build, names the decision gates that prove or
disprove the bet at each stage, lists the open questions the
analysis has now closed, and isolates the residual decisions that
genuinely sit with the operator and not with this analysis.

## Headline

**Build the Bucket 2 tenant CRM as a Trellis extension on Stripe
Connect rails, with the marketplace-ops dashboard for Bucket 1
shipping alongside as the operator's running surface. Defer the
Bucket 1 sales-CRM connector and the Bucket 2 export until tenant
volume requests them. Bucket 3 is out of scope.**

The bet: Trellis becomes the platform a vertical operator can use
to run a B2B partner-payment marketplace, with the partner CRM
integrated alongside the engagement signals that no off-the-shelf
CRM gets natively. The fee model — tiered transaction percentage,
paid by the partner — funds the build and is competitive against
the realistic alternatives a tenant has.

The non-bet: this is **not** a general "AI-first CRM" play. AI
features ship at tier 1 only (per doc 05), justified by Trellis's
unique data rather than category momentum. The same applies to
"build a generic relationship-management product" — that's
explicitly the wrong shape for Bucket 2.

## What docs 01-08 settled

The buckets (doc 01):

| Bucket | Relationship | Direction |
|---|---|---|
| 1 — Operator's CRM | #1 (operator ↔ tenant), #4 (operator ↔ influencer) | Hybrid: marketplace-ops dashboard built first-party, sales-CRM connector pushes to existing CRM |
| 2 — Tenant's CRM | #2 (tenant ↔ partner) | First-party Trellis extension, application layer on Stripe Connect rails |
| 3 — Audience engagement | #3 (tenant ↔ follower) | Out of scope |

The technical anchors:

- **Operator's role** (doc 02): payment intermediary running a B2B
  partner-payment marketplace per tenant; revenue is transaction
  fees, not subscriptions.
- **Rails** (doc 06): Stripe Connect Express + destination charge.
  Operator is MoR; refund / dispute liability on platform; revenue
  via `application_fee_amount`. Account Links for onboarding at
  MVP. Inbox-pattern webhook ingestion with `UNIQUE(stripeEventId)`.
- **Geographic scope** (doc 02): DACH/EU MVP. Compliance footprint
  shaped by DAC7, EU/DACH VAT, GDPR.
- **China-readiness** (doc 02 / project memory): rails-neutral
  schema, polymorphic tax artifacts, region-routable architecture.
  Implementation deferred to doc 10. The rails-abstraction
  interface in doc 06 is the concrete deliverable.
- **Data model** (doc 05): Partner / PartnerContact / Agreement /
  Engagement / Payment / PlatformFee / PayoutAccount / TaxArtifact.
  Per-tenant schema for tenant-confidential entities;
  operator-shared with `tenantId` for Payment / PlatformFee /
  TaxArtifact (the taxonomy-table exception pattern).
- **Identity overlap** (doc 05): `PartnerContact` bridges Partner
  to optional User. User identity does not cross tenant
  boundaries. Schema-level isolation enforces this for per-tenant
  tables; operator-shared tables enforce via tenant-scoped
  repository wrapper.
- **Fee structure** (doc 08): tiered percentage of gross,
  partner-paid, with refund-fee returned within 30 days. Tier
  thresholds (illustrative): 7% / 5% / 4% / 3.5% enterprise floor.
- **AI features** (doc 05): three tier-1 features ship in v1
  (per-partner activity summarisation, threshold / drift alerts,
  semantic search). Tier 2 piloted post-v1. Tier 3 deferred or
  rejected as demo-bait.
- **Where it lives in the repo** (doc 07, closes doc 05's open
  question): `packages/extension-crm/` for the CRM and the export
  pipeline at MVP. `packages/connectors-sdk/` factored when doc 04's
  operator-side connector ships and code is duplicated. **Not in
  core.**
- **Bucket 1's two surfaces** (doc 04): marketplace-ops dashboard
  ships before the first paying tenant (load-bearing); sales-CRM
  connector deferred until tenant count justifies it.
  Reverse-ETL (Hightouch / Census / Polytomic) is a buy-by-default
  candidate for Bucket 1; **not** for Bucket 2's tenant-side
  export (per doc 07 — multi-tenant credentials and per-tenant
  isolation fit it awkwardly).

## Sequenced build path

Four phases. Order is partly forced (Stripe ingestion gates almost
everything else) and partly optimised for shipping a usable v1
quickly.

### Phase 0 — Schema rename and identity-federation landing (~1 month)

Pre-work that the rest of the build depends on:

- Rename legacy `Partner` (= future `Tenant`) per doc 03's flagged
  collision. Coordinated with the in-flight identity-federation
  work on `feat/T3-tenant-crud`, `feat/T5-idp-crud`,
  `feat/identity-federation-v0.7`.
- Land identity-federation models (Tenant, TenantMember,
  TenantIdentityProvider, TenantDomain, TenantInvitation,
  TenantRoleMapping). The role taxonomy gates operator-only and
  tenant-admin surfaces in subsequent phases.
- Introduce the **new** `Partner` model per doc 05 (the doc-02
  meaning).

**Gate 0:** identity-federation tests pass; rename migration
completes against a non-trivial dataset (Trellis's, in the
Trellis repo).

### Phase 1 — Stripe Connect rails + Bucket 2 schema (~2-3 months)

- Stripe Connect: Express account creation, Account Link
  onboarding, country whitelist (DACH/EU MVP).
- Webhook endpoint with signature verification + inbox table
  (`StripeWebhookEvent`).
- Worker: drains inbox, dispatches to handlers for the MVP event
  set (doc 06's table). Idempotent upserts on Payment /
  PlatformFee / PayoutAccountStripeConnect.
- Bucket 2 schema: Partner, PartnerContact, Agreement,
  PayoutAccount, Engagement (rollup view), TaxArtifact (skeleton).
- Rails-abstraction interface (doc 06): the small `RailsProvider`
  interface with Stripe as the first implementation.
- Tenant-scoped repository wrappers for the operator-shared
  tables (Payment / PlatformFee / TaxArtifact) — the largest
  correctness-risk mitigation per doc 05.

**Gate 1:** end-to-end Stripe sandbox test — a Connected account
is onboarded, a PaymentIntent is initiated against it with an
application fee, the resulting webhooks land in the inbox and
produce Payment + PlatformFee rows. Refund flow works,
including the proportional application-fee refund.

### Phase 2 — MVP application surface + marketplace-ops minimum (~3-4 months)

Bucket 2 (in `packages/extension-crm/`):

- Partner list / detail UI with the tab structure from doc 05
  (Overview, Agreements, Payments, Engagement, Tax, Notes).
- Agreement workflows (create from template, mark active,
  terminate).
- Payment workflows (initiate against an active agreement,
  refund / dispute view).
- Engagement timeline (per-partner activity feed reading from
  per-tenant Posts, Comments, Activity tables and the shared
  User table via PartnerContact).
- Notes / documents UI.

Bucket 1 (operator-only role, in core or a sibling package):

- Marketplace-ops minimum: GMV by tenant, take-rate, payment
  status, **dispute real-time alerts**. The four views from
  doc 04's "MVP" build sizing.
- Daily rollup job for the per-tenant aggregates.

**Gate 2:** first beta tenant qualitative review. Does the
partner-detail engagement timeline replace their current
spreadsheet workflow? Do the agreement and payment flows feel
intuitive? This is a yes/no on whether the *product* works,
not just the rails.

### Phase 3 — Productionise and complete the MVP (~2-3 months)

- Tier 1 AI features (doc 05): per-partner activity
  summarisation, threshold / drift alerts (DAC7 €2k threshold,
  KYC expiry, engagement drift), semantic search over notes /
  threads / events.
- DAC7 readiness view in marketplace-ops (per doc 04).
- KYC status distribution view in marketplace-ops.
- Pending-payouts view, partner-roster growth view.
- Daily reconciliation job against Stripe balance transactions.
- Tax artifact draft generation (DAC7 report-row creation when
  a partner crosses the threshold; VAT-compliant invoice
  generation for the platform fee).
- Fee structure implementation per doc 08 (tier table, fee
  computation in Agreement.rateModel, refund-fee policy).

**Gate 3:** real GMV through the platform via 2-3 paying
tenants. Unit economics worked example from doc 08 (Growth
tenant ~€1,170/mo net) is testable. Dispute and refund flows
exercised in production. DAC7 reportable threshold-crossing
events visible.

### Phase 4 — Tenant-driven extensions (post-MVP)

Driven by tenant requests, not speculative:

- Bucket 2 export (doc 07) — when the first enterprise tenant
  asks for Salesforce / HubSpot integration. ~4-6 person-months
  for one target. SDK factoring into `packages/connectors-sdk/`
  may happen here if doc 04's connector lands first.
- Bucket 1 sales-CRM connector (doc 04) — when tenant count
  exceeds ~10-20 active accounts and reps complain about
  signal quality. Reverse-ETL spike (Hightouch / Census /
  Polytomic) before any custom build.
- Tier 2 AI features (doc 05) — when v1 usage data shows
  which directions reps actually pull on.
- Stripe Connect Embedded Components (doc 06) — when tenant /
  partner experience research shows the Account Link
  full-page redirect is hurting conversion.
- Subscription overlay on enterprise fee tier (doc 08).

**Gate 4:** real demand for each post-MVP item. Without it,
build something else.

### Total to v1

~9-12 months to Phase 3 completion at one engineer; ~6-9 months
at two engineers; ~5-7 months at three engineers (one focused on
rails / Stripe, one on product surface, one floating across
Bucket 1 marketplace-ops and AI features). Below two engineers
the path stretches and risks not finishing the financial-rails
work before the operator's first paying tenant.

## Decision gates (recap)

| Gate | After phase | What it proves |
|---|---|---|
| 0 | Phase 0 | Schema rename and identity federation are not blockers |
| 1 | Phase 1 | The rails work end-to-end for a real connected account |
| 2 | Phase 2 | The product works for at least one beta tenant |
| 3 | Phase 3 | The unit economics work at small but real scale |
| 4 | Phase 4 (per item) | A specific tenant request justifies a specific post-MVP build |

If any gate fails: stop, diagnose, and either fix or kill that
piece of the build. Do not push through a failed gate.

## Closed questions from earlier docs

This synthesis closes the following open questions:

| Open question source | Question | Resolution |
|---|---|---|
| README | Which CRM (SF / HubSpot / Attio / Pipedrive) for Direction A? | Doc 04 / 09: operator-side first target = whichever the operator uses; tenant-side targets = SF + HubSpot, sequenced by tenant ICP |
| README | Build vs. integrate at the platform level | Hybrid per bucket, not a single answer (doc 01) |
| README | What concrete AI features matter | Doc 05's tier 1: activity summarisation, threshold/drift alerts, semantic search |
| 01 | Is "engagement health + behavioural timeline" enough to be a product? | Yes, when paired with revenue-bearing primitives (doc 02) |
| 01 | Where does the engagement-layer UX live? | Inside `extension-crm` in the platform UI; export to external CRMs is a separate flow (doc 07) |
| 01 | Bucket 2's data model | Doc 05 |
| 02 | Express vs. Custom Connect accounts | Express ratified (doc 06) |
| 02 | Direct vs. destination charge | Destination ratified (doc 06) |
| 02 | DAC7 ingest and report generation | Schema in doc 05 (TaxArtifact polymorphic by jurisdiction); generation pipeline outlined in Phase 3 above |
| 02 | Fee structure model | Doc 08 |
| 02 | Marketplace-ops dashboard scope | Bespoke, 10 core views, in-platform operator-only role at MVP (doc 04) |
| 02 | Currency support | EUR + CHF day-one; GBP / USD admitted; CNY/CNH deferred (docs 06 / 08 / 10) |
| 02 | Rails-abstraction depth | Small `RailsProvider` interface with NormalisedEvent (doc 06) |
| 04 | Reverse-ETL vs. custom-coded connector for Bucket 1 | Spike reverse-ETL first; custom only if economics break |
| 04 | First sales-CRM target | Whichever the operator uses |
| 04 | DAC7 reporting view location | Threshold visibility in marketplace-ops; report generation in a separate tax-ops module |
| 05 | Where the extension lives in the repo | `packages/extension-crm/` (doc 07) |
| 07 | Shared SDK layer with doc 04 | Factor `packages/connectors-sdk/` when duplication is real (doc 07) |

## Residual operator-side decisions

These are decisions the analysis cannot make. They depend on
the operator's actual GMV forecast, tenant ICP, contract policies,
and product judgement. They must be ratified before MVP launch:

1. **Final fee tier thresholds** (doc 08). The 7% / 5% / 4% / 3.5%
   numbers are illustrative. Operator validates against forecast
   GMV distribution and tenant willingness-to-pay.
2. **First sales-CRM target for tenant-side export** (doc 07,
   Phase 4). SF or HubSpot first, depending on tenant ICP.
3. **Promotional / introductory pricing strategy** (doc 08).
4. **Fee transparency UX** in tenant and partner views (doc 08).
5. **Operator's CRM choice**, which determines doc 04's first
   sales-CRM connector target.
6. **Operator team size and shape** for the build. Affects
   timeline; not the architecture.
7. **External tax advisor engagement** (doc 02). VAT / DAC7
   review before MVP launch is non-negotiable; choosing the
   advisor is operator-side.
8. **Audit / compliance posture** (SOC 2 / ISO 27001 / etc.)
   that some enterprise tenants will require. Out of scope here;
   operator's compliance roadmap.

## Risks

The bets that, if they break, kill or substantially reshape the
recommendation:

1. **VAT / DAC7 complexity exceeds external-advisor's bandwidth.**
   Operator-as-MoR under destination charge has subtle VAT
   implications in DACH (doc 02 flagged). If the tax advisor
   says "this needs a different MoR model," doc 06's destination
   charge default revisits and the schema admits a switch.
2. **Tenant ICP turns out to be sub-€20 ticket-size flows**
   (doc 08 sensitivity caveat). Stripe fixed costs dominate at
   that ticket size; the recommended fee model breaks. Mitigation:
   either pivot to a tenant ICP with larger ticket sizes, or add
   a flat-plus-percentage fee variant for low-ticket tenants.
3. **Schema-per-tenant ceiling hits faster than expected.** Per
   doc 05's open question, low-thousands of tenants is the
   PostgreSQL-per-schema ceiling. If MVP success drives 5k+
   tenants in year one, the isolation model needs revisiting.
   Mitigation: monitor tenant growth, plan a logical-partition
   migration as a contingency.
4. **Stripe deprecates a primitive.** Account Links → Embedded
   Components migration (doc 06) is non-trivial. Mitigation:
   the `RailsProvider` interface absorbs some of the change,
   not all of it. Plan a periodic Stripe-API-version review.
5. **AI features tier 1 ships but doesn't move the needle.**
   Empirical question per doc 05 / Phase 3. Mitigation: tier 1
   is < 1 person-month total build; if it's dead weight,
   abandoning it costs little. Tier 2 / 3 are not built
   speculatively, by design.
6. **China-readiness directive turns out to require deeper
   architectural changes than the abstraction layer admits.**
   Doc 10 territory. Concrete risks: data localisation may
   require a separate Trellis-CN deployment with its own DB,
   not a single-region multi-tenant model. The "region above
   tenant" dimension flagged in project memory is admitted in
   the architecture but not built. Mitigation: doc 10 lays
   this out before China expansion is near-term, not after.
7. **Operator's CRM choice creates a dual-build trap** if it
   diverges from tenant ICP. If the operator uses HubSpot but
   tenant ICP is enterprise-on-Salesforce, the operator builds
   one connector for itself and a different one for tenants
   first. Mitigation: factor the SDK package early in this
   case (doc 07 Phase 4 contingency).
8. **Identity-federation work slips in Phase 0.** The
   tenant-admin / operator role taxonomy is a hard prereq for
   gating UIs. Mitigation: track the in-flight branches; do
   not start Phase 1 if Phase 0 is incomplete.

## What this doc deliberately does not decide

- The China expansion implementation detail (doc 10's territory).
- Specific operator-side product decisions enumerated under
  "Residual operator-side decisions" above.
- The exact contract / commercial terms for tenant onboarding
  (legal team's domain).
- Pricing of the CRM extension itself separate from transaction
  fees (operator-side product decision; the recommendation
  defaults to "free, cost recovered through fees" but admits a
  per-seat / per-tenant subscription if the operator wants to
  layer one).
- Bucket 3 (audience engagement / lifecycle marketing).
  Reclassified as a non-CRM platform feature; deserves its own
  scoping doc if pursued.
- Whether the Trellis-as-a-platform commercial model (selling
  this to *other* operators) is in scope. The current
  analysis assumes one operator per Trellis instance per
  doc 01; offering Trellis as a packaged platform to external
  operators is a separate strategic question.

## Pointer to deferred work

[10-china-expansion-readiness.md](10-china-expansion-readiness.md)
will document the China-readiness implementation when expansion
becomes near-term. The architectural shape (rails-neutral schema,
polymorphic tax artifacts, region-routable layer) is locked in by
this recommendation. The implementation — Alipay / WeChat Pay /
UnionPay rails, fapiao tax artifacts, PIPL-compliant data
localisation, real-name KYC — is deferred. The bar this
recommendation commits to: "don't paint over the door."
