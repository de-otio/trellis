# Actors and Relationships

The CRM scoping doc ([README.md](README.md)) framed the question as a
choice between three directions (integrate / custom / hybrid) for a
single CRM product. That framing assumes there is *one* CRM. This doc
shows there isn't: the relationship-management needs in a Trellis-powered
product split into distinct architectural buckets with different buyers,
different access models, and different right answers.

The split is the load-bearing decision. Once the buckets are named, the
direction for each falls out almost mechanically.

> [!NOTE]
> [02-operator-revenue-model.md](02-operator-revenue-model.md) narrows
> Bucket 2 further: the operator earns transaction fees on
> tenant↔partner payments, so Bucket 2 is anchored on financial
> primitives (Partner, Payout Account, Agreement, Payment, Platform
> Fee, Tax Artifact) — not just contacts and notes. It also splits
> Bucket 1 into a sales-CRM surface and a marketplace-ops dashboard.
> The bucket structure here still holds; doc 02 fills in the
> revenue-driven detail.

## Actors

Three actor classes matter for this analysis:

- **Operator** — the company running a Trellis-based product. Owns the
  vertical extension, the deployment, and the commercial relationship
  with all paying customers. There is exactly one operator per Trellis
  instance.
- **Enterprise tenant** — a business that has provisioned a tenant
  inside the operator's app. Pays the operator (directly or indirectly)
  and uses Trellis to engage its own audience and partners. Many
  tenants per operator.
- **End user** — an individual who has an account on the platform.
  Sub-classes that matter here:
  - **Follower** — a consumer following a tenant for content
  - **Influencer** — a high-value individual creator. May be a partner
    of one or more tenants, may have a direct relationship with the
    operator, or both
  - **B2B partner** — a vendor, sponsor, or business collaborator of a
    tenant. Often an enterprise represented by named contacts, not a
    single individual

Influencer-vs-B2B-partner is a soft distinction: a creator working with
a brand is structurally a B2B partner of that tenant. The class label
matters less than the *relationship* the record participates in.

## The four relationships

| # | Relationship | Owner of the relationship |
|---|---|---|
| 1 | Operator ↔ Enterprise tenant | Operator |
| 2 | Enterprise tenant ↔ B2B partners (incl. influencers as partners) | Enterprise tenant |
| 3 | Enterprise tenant ↔ followers (B2C) | Enterprise tenant |
| 4 | Operator ↔ Influencers | Operator |

"Owner of the relationship" answers *whose CRM is it?* — i.e., which
party manages the record, sees the history, and acts on it. That column
is the basis for the bucket split.

### #1 — Operator ↔ Enterprise tenant

Classical SaaS sales and account management. Pipeline-shaped: trial →
POC → contract → expansion → renewal. Owned by the operator's
commercial team. Standard CRM territory: account, opportunity, MRR/ARR,
health score, renewal date, contact roles, multi-stakeholder threads.

The signal Trellis uniquely contributes: high-fidelity tenant usage
data — DAU/MAU per tenant, post volume, feature adoption, integration
activity, admin login cadence, support-ticket frequency. Standard
product analytics, but already in the same database as the customer
record so no ETL.

### #2 — Enterprise tenant ↔ B2B partners

The tenant managing its own influencers, sponsors, agencies, and
business collaborators. Pipeline-shaped or relationship-shaped
depending on the deal type (sponsorship deal, exclusive content
arrangement, co-marketing, vendor onboarding).

The relationship history *is* the on-platform activity: posts the
partner appeared in, mentions, comments, collaborations,
cross-promotion. A separate CRM has to ingest this via ETL and
loses fidelity; an in-platform CRM has it natively.

This relationship is multi-tenant by construction — each tenant has
its own partner roster, and tenants must not see each other's
records.

### #3 — Enterprise tenant ↔ followers

Marketing automation in CRM clothing. High volume, low ACV per
relationship, mostly handled by software, not humans: lifecycle
messaging, segmentation, broadcast, churn/reactivation, fan tiers.

Salesforce ships this as "Marketing Cloud" — a separate product line
from "Sales Cloud" — and the separation is real. Calling this a CRM
muddies the analysis.

### #4 — Operator ↔ Influencers

Direct relationships between the operator and high-value creators on
the platform: creator deals, exclusivity arrangements, promotion
slots, recognition programs. Spans tenants — a top creator may be
relevant across many tenant communities.

Pipeline-shaped, but typically lower volume than #1, with different
deal economics (rev share, tiered access, campaign-based).

## Whose CRM is it? — the bucket split

Grouping the four relationships by owner produces three buckets, not
three directions:

### Bucket 1 — Operator's CRM (relationships #1 and #4)

Single workspace, accessed by the operator's commercial team.
Relationships #1 (tenant accounts) and #4 (influencer partnerships)
share primitives — account, contact, deal/agreement, activity
history, health score — and differ mostly in record type and stage
definitions. Sensible to manage them in the same CRM.

Properties:
- **Single-workspace.** One operator, one team, one set of records.
- **Two surfaces, not one.** Once the marketplace revenue model is
  in scope (see doc 02), Bucket 1 splits into a *sales / CS CRM*
  for the human-managed tenant relationship and a separate
  *marketplace-ops dashboard* for transaction-volume, take-rate,
  and risk views. The two share data but not UX.
- **Standard SaaS CRM shape on the sales side.** Pipeline + account
  + activity log; Salesforce/HubSpot/Attio all fit.
- **Bespoke shape on the marketplace-ops side.** GMV, take-rate,
  partner-roster growth, dispute rates — Salesforce-style pipelines
  model these awkwardly. Likely bespoke or a revenue-ops bolt-on.
- **Trellis's unique contribution is signal, not surface.** The
  operator already has, or will have, an external CRM on the sales
  side. What's missing is high-quality engagement and transaction
  signal flowing into it.

### Bucket 2 — Tenant's CRM (relationship #2)

Multi-tenant, in-product, engagement-native, **and revenue-bearing**.
Each enterprise tenant gets its own scoped relationship dataset,
accessed from inside the tenant's space using the same identity they
use for the rest of the platform — and that dataset is also the
substrate that money flows through (see doc 02).

Properties:
- **Multi-tenant by construction.** Per-tenant data isolation is a
  hard requirement, not a feature.
- **Engagement-native.** The relationship history *is* on-platform
  activity. ETL into an external system is lossy and defeats the
  point.
- **Anchored on financial primitives, not contacts.** Once payments
  are in scope, the entity model leads with Partner, Payout Account,
  Agreement, Payment, Platform Fee, and Tax Artifact (per doc 02);
  contact-and-notes UX sits *on top of* those primitives, not in
  place of them.
- **Often the only CRM the tenant has.** Small and mid-size tenants
  rarely run Salesforce. They are paying the operator partly so they
  don't have to.
- **Lives in the platform UI.** Same login, same identity model,
  same tenant scope as the rest of the product.

### Bucket 3 — Audience engagement (relationship #3)

Not a CRM. Marketing automation / lifecycle messaging / segmented
broadcast. A feature of the social platform itself. Excluded from
this analysis; deserves its own scoping if pursued.

## How the buckets change the direction

The earlier three-direction framing collapses into one default per
bucket:

| Bucket | Direction | Why |
|---|---|---|
| 1 — Operator's CRM | **Hybrid push-out + bespoke marketplace-ops (Direction C, two-surface)** | Sales-CRM side: operator has or will have an external CRM; what's missing is signal quality, not UI surface — build connectors. Marketplace-ops side: bespoke dashboard fed by Stripe + Trellis, since SaaS-CRM pipelines model GMV/take-rate awkwardly (see doc 02). |
| 2 — Tenant's CRM | **First-party extension (Direction B, narrowed to application layer over Stripe Connect rails)** | Multi-tenancy, engagement-native data, and the long tail of CRM-less tenants make the in-platform build genuinely necessary; the marketplace revenue model adds financial primitives that must live in this dataset. Buy the rails (Stripe Connect), build the application. |
| 3 — Audience engagement | Out of scope | Reclassify as a non-CRM platform capability. |

Direction A (pure integration with no Trellis-built relationship
surface) loses on Bucket 2: there is no realistic way to resell
Salesforce/HubSpot instances to every tenant, and the tenant doesn't
want to leave the product to manage in-platform partners.

Direction B (custom CRM as a single product) loses on Bucket 1: the
operator's commercial team already lives in established tooling and
won't move to a Trellis-built CRM for forecasting and contract work.

The hybrid the user proposed becomes architecturally specific:
**build the tenant-side CRM as a Trellis extension; push signals
into the operator's existing CRM via connector**. Two products,
sharing engagement primitives.

## Implications and constraints

These came out of the bucket analysis and need to be carried into the
per-bucket docs:

### Bucket 2 needs export, not just import

A large enterprise tenant likely runs its own Salesforce or HubSpot
instance and will want the Trellis-side relationship data pushed
into it. The tenant CRM extension owns the in-product UX, but it
must ship with a one-way export capability from day one. This is a
non-trivial constraint on the data model: records must be
externally addressable, change events must be emitted, and identity
mapping (Trellis user ↔ external CRM contact) must be a first-class
concern.

This is the *opposite* direction of integration from Bucket 1, and
the two flows must not be conflated.

### Identity overlap is a schema decision, not an afterthought

In Bucket 2, a tenant's B2B partner record may also be a Trellis
user — an influencer with their own account, an employee of a
sponsor company, a vendor's account manager. Partner ≠ user, but a
partner often *has* a user, sometimes more than one (multiple
contacts at the same partner company), and sometimes none (a
partner the tenant is courting before they've signed up).

The relationship between the partner record and the user record
needs to be explicit:

- A partner is its own entity (organisation or individual)
- Contacts on a partner may or may not be Trellis users
- A Trellis user may participate in multiple partner relationships
  across multiple tenants
- Tenant-scoping applies to partner and contact records but **not**
  to the underlying user identity

Getting this wrong creates either privacy leaks (one tenant seeing
another tenant's partner data via the shared user record) or
duplication (the same person represented as N disconnected contacts
across N tenants).

### Bucket 1 deprioritises #4 in early work

Operator-influencer relationships (#4) are pipeline-shaped but
low-volume relative to operator-tenant relationships (#1).
Treating them as a record-type variation on the same Bucket 1 CRM
is fine for early work; they don't need a dedicated doc until
volume justifies it. Naming them here so they don't get
rediscovered later as a "missing" relationship.

### "Tenant-side push-out" is integration in the same shape as Bucket 1

Bucket 1 builds a Trellis → operator's-CRM connector. Bucket 2's
export feature is a Trellis → tenant's-CRM connector. The shapes
are similar, the targets are the same vendors, but the source data
and the configuration owner differ:

- Bucket 1: operator configures one connection; operator's IT runs it
- Bucket 2: each tenant configures their own connection; tenant's IT
  runs it; the operator hosts the configuration UX

Whether these connectors share code is an open question deferred to
the per-bucket docs. Likely yes for the SF/HubSpot SDK layer, no for
the orchestration and configuration layer.

## What this doc deliberately does not decide

- The operator's revenue model and its consequences for the entity
  model (handled in [02-operator-revenue-model.md](02-operator-revenue-model.md))
- The data model for Bucket 2 (deferred to `05-bucket-2-tenant-crm.md`)
- Which external CRMs to support first in Bucket 1 connectors
  (deferred to `04-bucket-1-operator-crm.md`)
- AI feature ranking for Bucket 2 (deferred to the same doc;
  needs an inventory of engagement signals first — see
  `03-engagement-signals-inventory.md`)
- Pricing and packaging across buckets
- Whether Bucket 3 is pursued at all, and if so on what timeline

## Updated doc plan

Replaces the plan in [README.md](README.md). Doc 02 inserted the
revenue model and renumbered downstream items; the plan below is the
current authoritative one.

1. **`01-actors-and-relationships.md`** — this doc
2. **`02-operator-revenue-model.md`** — operator as payment
   intermediary; Stripe Connect; DACH/EU compliance; financial
   primitives; China-readiness
3. **`03-engagement-signals-inventory.md`** — what Trellis has today,
   organised by which bucket consumes it
4. **`04-bucket-1-operator-crm.md`** — sales-CRM connectors +
   marketplace-ops dashboard (relationships #1 and #4)
5. **`05-bucket-2-tenant-crm.md`** — first-party tenant-side
   extension; data model rooted in the financial primitives from
   doc 02; AI feature ranking
6. **`06-stripe-connect-design.md`** — account type, charge model,
   merchant of record, application-fee mechanism, dispute / refund
   flows
7. **`07-tenant-side-export.md`** — pushing Bucket 2 data out to a
   tenant's own external CRM; identity mapping; change events
8. **`08-fee-structure.md`** — unit economics, model selection
9. **`09-recommendation.md`** — synthesis and recommended path
10. **`10-china-expansion-readiness.md`** — deferred until China
    expansion becomes near-term; rails, data localisation, fapiao,
    FX corridors, real-name KYC

The README will be updated to reflect this plan and the bucket split.
