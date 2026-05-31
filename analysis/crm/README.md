# CRM Extension Analysis

This folder is the design artefact for whether and how Trellis should
grow a CRM capability. The conclusion lives in
[09-recommendation.md](09-recommendation.md); docs 01-08 are the
supporting analysis. This README is preserved as the original scoping
question — the framing that the analysis answered.

## Status

**Analysis complete. Read [09-recommendation.md](09-recommendation.md)
for the headline and recommended path.**

No CRM-related code in `apps/api` or `packages/extension-api` yet —
this folder is design, not implementation. Doc 10 (China expansion
readiness) is deferred until China expansion is near-term; the
architectural shape locked in by docs 02 and 06 keeps the door open
without forcing the implementation now.

> [!NOTE]
> **Back-office schema-shape coordination.** The financial primitives
> here (`Partner` / `Payment` / `PlatformFee` / `TaxArtifact`,
> ZUGFeRD / DAC7) are the issuer-side mirror of De Otio's back-office
> (Quaestor) invoice schema. Both are still design-only, and
> money-movement schemas are the most expensive thing to retrofit, so
> the **field shapes** (ZUGFeRD field set, audit-log shape,
> project/`entity` tag) should be aligned with the consumer side
> *before* either is coded — shapes shared, not code. See
> [`../../doc/02-technical/architecture/14-back-office-cost-attribution.md`](../../doc/02-technical/architecture/14-back-office-cost-attribution.md)
> and, in the `quaestor` repo,
> `doc/processes/invoice-automation/trellis-issuer-handoff.md`.

---

## Why a CRM is even on the table

Trellis is the generic core for multi-tenant social platforms. Every
deployment of a Trellis-powered product has a customer-facing business
model, and that business model has relationships to manage. Today the
platform owns rich engagement data (logins, posts, comments, follows,
tenant membership, feature usage) but has no surface for managing the
*relationship* layer above that data — sales, partnerships, ad deals,
high-touch support, creator agreements.

The interesting observation is that the engagement data Trellis already
holds is *exactly* the kind of signal a CRM tries to acquire from third
parties (product analytics, marketing automation, support tools). Trellis
sits on the source of truth for "is this customer healthy?" — a position
that no external CRM gets natively.

That asymmetry is what makes "build vs. integrate" non-obvious. If
Trellis-powered products only needed pipeline tracking and contact
management, the answer would be "buy Salesforce/HubSpot." The fact that
the most valuable signals already live in Trellis changes the calculus.

---

## What jobs would a Trellis CRM actually do?

A "modern social media app" rolls up several distinct customer-relationship
jobs, and the right answer for each is probably different. Naming them
explicitly so we don't paper over the differences:

1. **B2B tenant sales** — selling Trellis-powered products to organisations.
   Pipeline-shaped: trial → POC → contract → expansion. Needs MSAs,
   procurement, multi-stakeholder threads, forecast hygiene. This is
   classical SaaS sales.
2. **Creator / partnership deals** — bespoke arrangements with high-value
   individual creators (rev share, exclusives, promo). Pipeline-shaped but
   the stages, legal, and economics differ sharply from B2B SaaS.
3. **Ad / sponsor sales** — selling inventory or sponsored placement.
   Classic media sales motion: media kits, IO contracts, campaign
   delivery, post-campaign reporting.
4. **B2C lifecycle / churn** — managing the consumer subscriber base.
   Less "pipeline", more "lifecycle marketing + churn prediction +
   reactivation". Volume is high, ACV is low, automation is mandatory.
5. **High-touch support / account management** — every interaction with
   support attaches to a customer record. Case-management-shaped, not
   pipeline-shaped.
6. **Internal community management** — moderators, ambassadors, beta
   testers tracked as relationships, not revenue. Often overlooked, often
   important, rarely well served by traditional CRMs.

These are not all the same product. A platform decision ("build a CRM
extension") that doesn't pick which of these jobs is dominant will
produce something that is mediocre at all of them.

**Open question for the next doc:** which of these is the dominant job
in the first realistic Trellis deployment? The answer changes the
analysis.

> [!NOTE]
> [01-actors-and-relationships.md](01-actors-and-relationships.md)
> reframes this question by splitting the relationships by *owner*
> (operator vs. tenant) and shows that the answer is not one product
> but two. The bucket split there supersedes the three-direction
> framing below.
>
> [02-operator-revenue-model.md](02-operator-revenue-model.md)
> further narrows Bucket 2 by making the operator's role concrete
> (transaction-fee marketplace on Stripe Connect rails, DACH/EU
> first), which fixes the entity model and pulls Bucket 1 into a
> two-surface shape (sales-CRM + marketplace-ops dashboard).

---

## Three directions worth comparing

### Direction A — Integrate with an existing CRM

Trellis emits events and data to an external CRM (Salesforce, HubSpot,
Attio, …) via API. The external CRM is the system of record for
relationships; Trellis is just a richer-than-usual data source.

- **Strengths:** zero re-invention, enterprise trust, ecosystem of
  marketing automation / BI / AI tools, existing seller workflows.
- **Weaknesses:** the canonical SF data model (Lead/Account/Opportunity)
  was built for B2B field sales in industries that aren't social media;
  bidirectional sync is genuinely hard (conflict resolution, rate
  limits, soft-delete semantics); license cost; engagement signals
  lose fidelity through ETL; auth/identity mapping is fiddly; building
  against SF metadata API is a real engineering investment.
- **Open questions:** which CRM (SF vs. HubSpot vs. Attio vs. Pipedrive)?
  One-way out (cheap, loses bidirectional value) or two-way (expensive,
  most of the value)? Is the integration owned by Trellis core, or by
  each vertical's extension?

### Direction B — Fully custom AI-first CRM extension

A first-party extension that builds its own contact / account / deal /
note primitives, with AI-first UX (no manual data entry, semantic
search over notes and threads, auto-summarisation, predictive pipelines
fed by real engagement data).

> [!NOTE]
> Superseded by [01-actors-and-relationships.md](01-actors-and-relationships.md)
> and [02-operator-revenue-model.md](02-operator-revenue-model.md).
> Direction B is now narrowed to **a Trellis extension that builds
> the application layer (CRM + agreements + reporting) on top of
> Stripe Connect rails** — financial processing, KYC/KYB, payouts,
> tax calculation, and dispute primitives are bought, not built. The
> entity model is anchored on Partner / Payout Account / Agreement /
> Payment / Platform Fee / Tax Artifact (doc 02), not a generic
> contact-and-notes schema.

- **Strengths:** data lives next to engagement signals so health
  scoring and behavioural triggers are native, not ETL'd; narrower
  scope means less to build than a general CRM; AI-native UX from day
  one with no retrofit baggage; full control of pricing and roadmap.
- **Weaknesses:** the boring half of CRM work (email send/receive,
  calendar, billing/Stripe, e-sig, contract storage, dialer) still
  has to exist somewhere; "AI makes building cheap" is a real but
  routinely-overestimated thesis — building enough surface to be
  useful is still significant; no ecosystem of pre-built plugins
  (no native Outreach, Gong, Marketo equivalents); reps trained on
  Salesforce will resist.
- **Open questions:** what concrete AI features move the needle in
  daily use vs. being demo-bait? How thin can the manual-data-entry
  layer get before reps revolt? What do we do about email/calendar
  — build it, embed Nylas/similar, or punt to Direction C?

### Direction C — Hybrid: own the engagement, integrate the commodity

Trellis owns the engagement-derived layer of the customer record
(health score, network position, behaviour timeline, in-app
interactions, ICP fit signals from on-platform behaviour) and pushes
those signals into an external CRM that owns the commodity layer
(deal stages, forecasting, email, contracts, billing).

This is the one the user didn't initially propose but is arguably the
most defensible.

- **Strengths:** each side does what it's good at; doesn't bet on
  "AI-first CRM" being a category before there's evidence it is;
  one-way-out integration is dramatically easier than bidirectional
  sync; positions Trellis as a *complement* to existing tools rather
  than a replacement, which lowers buyer friction; the engagement-data
  surface is genuinely differentiated and could ship as a small,
  focused product.
- **Weaknesses:** the customer still pays for the external CRM and
  trains reps on two systems; risk of becoming "just another data
  source" with no UX surface and therefore no pricing power; the
  engagement-health story has to be *strong* on its own — if it's
  marginal, this collapses to "expensive Segment connector".
- **Open questions:** is "engagement health score + behavioural
  timeline + in-app interactions" enough to be a real product, or
  just a feature of the platform? Where does the UX live —
  embedded inside SF, separate dashboard, in-product card?

---

## What this scoping doc is not deciding

- **Build vs. integrate at the platform level.** Premature until the
  dominant job is named (see "What jobs" section above).
- **Which AI features matter.** The "AI-first" pitch in Direction B
  needs concrete ranked features before it can be evaluated;
  hand-waving doesn't count.
- **Pricing model.** Out of scope here.
- **Multi-tenancy semantics.** Big topic — does each Trellis tenant
  get its own CRM dataset, or is there a meta-CRM owned by the
  vertical operator? Deferred to per-direction docs because the
  answer differs.

---

## Docs in this folder

The numbered docs are designed to be read in order.

| # | Doc | Topic |
|---|---|---|
| – | [README.md](README.md) (this file) | Original scoping question and framing |
| 01 | [actors-and-relationships](01-actors-and-relationships.md) | Three buckets, four relationships, bucket-direction mapping |
| 02 | [operator-revenue-model](02-operator-revenue-model.md) | Operator as payment intermediary; Stripe Connect; DACH/EU compliance; China-readiness |
| 03 | [engagement-signals-inventory](03-engagement-signals-inventory.md) | What signals Trellis has today, organised by bucket |
| 04 | [bucket-1-operator-crm](04-bucket-1-operator-crm.md) | Sales-CRM connector + marketplace-ops dashboard |
| 05 | [bucket-2-tenant-crm](05-bucket-2-tenant-crm.md) | First-party tenant-side CRM extension; data model; AI feature ranking |
| 06 | [stripe-connect-design](06-stripe-connect-design.md) | Account type, charge model, webhook ingestion, rails-abstraction interface |
| 07 | [tenant-side-export](07-tenant-side-export.md) | Bucket 2 → tenant's external CRM (multi-tenant inverse-direction integration) |
| 08 | [fee-structure](08-fee-structure.md) | Tiered % paid by partner, with worked unit economics |
| 09 | [recommendation](09-recommendation.md) | **Synthesis and recommended path** |
| 10 | china-expansion-readiness | Deferred; see project memory |

---

## Decision criteria to keep in mind

When comparing directions in later docs, the lens should be:

- **What does Trellis uniquely have that no off-the-shelf CRM gets?**
  If the answer is "nothing", buy.
- **What is the realistic engineer-month budget?** Custom CRM work
  expands.
- **Who is the buyer?** A vertical operator who already lives in
  Salesforce has very different preferences from a creator-led
  startup.
- **What's the maintenance shape?** A CRM integration is forever:
  SF API versions, OAuth scopes, sandbox/prod parity, rate-limit
  handling. A custom build has a different forever-cost
  (feature parity treadmill, support, security).
