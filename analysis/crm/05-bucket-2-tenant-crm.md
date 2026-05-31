# Bucket 2 — Tenant's CRM (first-party extension)

Bucket 2 covers relationship #2 from doc 01: the **enterprise tenant
managing its own B2B partners and influencers**. Per docs 01 and 02
this is the only bucket that gets a first-party Trellis-built
surface, and per doc 02 it is anchored on financial primitives —
Partner, Payout Account, Agreement, Payment, Platform Fee, Tax
Artifact — not on a generic contact-and-notes data model.

This doc designs that extension: the data model, the multi-tenant
placement, the user-identity overlap, the application surface, and
a ranked list of AI features that survive scrutiny vs. the ones
that don't.

Out of scope: Stripe ingestion details (doc 06 owns), pushing
Bucket 2 data out to a tenant's external CRM (doc 07), pricing
(doc 08), the synthesis recommendation (doc 09).

## Caveats and scope

- **Multi-tenant isolation is schema-per-tenant.** Per the
  `prisma/schema.prisma` comment at line 15 on `main`. Per-tenant
  entities live in tenant schemas; cross-tenant entities (operator
  system of record, taxonomy) live in a shared schema. The
  placement decision matters and is made entity-by-entity below.
- **Legacy `Partner` ↔ doc-02 `Partner` naming collision.** Same
  caveat as docs 03 and 04. The current `Partner` model is the
  predecessor of `Tenant`. The "Partner" used throughout this doc
  is doc 02's meaning (tenant's B2B counterparty), not the legacy
  schema name. The rename is a prerequisite for landing this work,
  but is not designed here.
- **Financial primitives are designed, not built.** Doc 02
  specifies them; doc 06 will build the Stripe-ingestion side. This
  doc treats them as a stable contract.
- **Identity-federation models** (`Tenant`, `TenantMember`,
  `TenantIdentityProvider`, …) are designed and in flight on
  `feat/T3-tenant-crud`, `feat/T5-idp-crud`,
  `feat/identity-federation-v0.7`. This doc treats them as
  available.
- **Export to external CRM is deferred to doc 07.** That work is
  shaped by Bucket 2's data model but not part of this doc.

## What changes in the framing

Doc 01 called Bucket 2 "engagement-native" and walked back the
"lightweight relationship manager" framing. Doc 02 added the
revenue-bearing dimension — payments flow through this dataset, so
DAC7, KYC, and tax artifacts ride along. The extension's design
follows from those two facts:

1. **Engagement is the differentiated UX** — the partner timeline
   is composed of real on-platform activity (mentions, posts,
   comments, collaborations), not typed-in notes. This is what
   no off-the-shelf CRM gets natively.
2. **Money is the load-bearing primitive** — without Payment /
   Platform Fee / Tax Artifact in the data model, the extension
   is decorative; the operator does not earn revenue.

These two pull in opposite directions. Engagement-native UX wants
to centre activity feeds. Revenue-bearing data wants to centre
agreements and payments. The synthesis: **agreements are the
spine, with engagement and payments hung off them**. A partner
without an agreement is a contact-level record; with an agreement
it becomes a revenue-bearing relationship.

## Data model

The financial primitives sketched in doc 02 (table at line 211)
are the starting point. Each entity below specifies shape,
ownership, schema placement, key indexes, and lifecycle.

### Entity-by-entity sketch

**Partner** (per-tenant schema)

The relationship target. Individual or organisation.

```
Partner
├── id (PK)
├── displayName
├── kind: "individual" | "organisation"
├── legalName              -- DAC7-required when reportable
├── countryCode            -- DAC7
├── taxIdentifier          -- TIN, optional until reportable
├── vatId                  -- B2B partners
├── address                -- structured for DAC7
├── status: "active" | "inactive" | "blocked"
├── createdAt / updatedAt
└── (no userId — see PartnerContact)
```

Notes:
- Per-tenant. Each tenant's Partner roster is invisible to other
  tenants by virtue of schema-per-tenant placement.
- Lifecycle: created when the tenant adds a partner, soft-deleted
  via `status` (DAC7 retention forbids hard delete for 5 years
  after the last reportable transaction).
- DAC7 fields are optional at create time; the system requires
  them when an Agreement crosses the reporting threshold.

**PartnerContact** (per-tenant schema)

The bridge between a `Partner` and zero or more `User` accounts.
Resolves the identity-overlap concern from doc 01.

```
PartnerContact
├── id (PK)
├── partnerId (FK → Partner)
├── userId (FK → shared User table; nullable)
├── role: "primary" | "billing" | "operational" | "other"
├── displayName            -- override when no User attached
├── email                  -- override when no User attached
├── invitationStatus: "none" | "invited" | "accepted"
├── createdAt / updatedAt
```

Notes:
- A Partner has 0..N contacts. A contact has 0 or 1 User.
- The same User can be a PartnerContact on partners across
  multiple tenants — the User row is shared, but each tenant's
  PartnerContact is in that tenant's schema. Tenant A cannot see
  tenant B's records via the User identity.
- An invited Partner gets a one-time link that, when accepted,
  binds the User to the PartnerContact. Pre-acceptance, the
  Partner is still a usable record (for agreements, notes, manual
  payment data) — the User binding is an upgrade, not a
  prerequisite.

**Agreement** (per-tenant schema)

Commercial terms between tenant and partner. The spine.

```
Agreement
├── id (PK)
├── partnerId (FK → Partner)
├── title
├── kind: "sponsorship" | "rev_share" | "fixed_fee" | ...
├── status: "draft" | "active" | "completed" | "terminated"
├── effectiveFrom / effectiveTo
├── rateModel (JSONB)      -- structured terms
├── currencyCode
├── notes
├── createdAt / updatedAt
```

Notes:
- A Partner has 0..N Agreements over time. Most active partners
  have one current Agreement.
- `rateModel` is intentionally JSONB at MVP. Encoding rev-share
  splits, milestone fees, performance bonuses, etc. in a
  normalised relational shape is premature before the agreement
  shapes are observed in production. Promote frequently used
  fields to columns later.
- Agreements generate Payments (the operator's side) — see below.

**Engagement** (per-tenant schema, derived view)

On-platform activity associated with a partner. Doc 03 inventoried
the source signals; this is the per-partner rollup surface.

```
Engagement (view or materialised)
├── partnerId
├── windowFrom / windowTo
├── postCount              -- partner-as-user posts
├── mentionCount           -- mentions of the partner
├── commentCount
├── collaborationCount
├── lastActivityAt
└── -- engagement timeline (event stream, separate)
```

Notes:
- Computed, not authored. Source rows live in Trellis core (Post,
  PostComment, Activity, etc., per doc 03).
- The materialised version is a per-tenant rollup table refreshed
  on a cadence (hourly to daily, depending on UI freshness needs).
- The event-timeline version is a query, not a stored table —
  joins core tables filtered by the partner's User IDs (via
  PartnerContact).
- Engagement is the differentiated UX. Per-partner activity
  feeds, "what has this partner done in the last 30 days," and
  drift detection (engagement falling) all live here.

**Payment** (operator-shared schema, with `tenantId`)

A charge / payout / refund event. Operator is system of record.

```
Payment
├── id (PK)
├── tenantId               -- which tenant initiated this
├── agreementId            -- nullable for ad-hoc
├── partnerId              -- denormalised for ops queries
├── kind: "charge" | "payout" | "refund" | "dispute"
├── grossAmount / currencyCode
├── netToPartner           -- after platform fee
├── platformFeeId (FK → PlatformFee)
├── rails: "stripe_connect" | "alipay" | ...
├── railsExternalId        -- Stripe charge / payout ID, etc.
├── status
├── occurredAt
├── createdAt / updatedAt
```

Notes:
- Cross-tenant by design. The operator's marketplace-ops dashboard
  (doc 04) reads this. Each tenant can also view its own subset,
  scoped by `tenantId`.
- This is the schema-placement exception case. It cannot live in
  per-tenant schema because the operator queries across tenants.
  Same justification as the taxonomy tables in `schema.prisma`.
- Stripe-specific fields are confined to `railsExternalId` and a
  separate `payment_rails_extension` typed table. The core schema
  is rails-neutral per doc 02's China-readiness directive.

**PlatformFee** (operator-shared schema, with `tenantId`)

Operator's slice of a Payment.

```
PlatformFee
├── id (PK)
├── paymentId (FK → Payment)
├── tenantId               -- denormalised
├── grossAmount            -- the operator's revenue
├── feeRateApplied         -- % or fixed, captured for audit
├── currencyCode
├── createdAt
```

Notes:
- Append-only. A refund or dispute creates a new PlatformFee row
  (negative amount) rather than mutating the original. Audit
  trail is mandatory.
- Aggregation source for the marketplace-ops dashboard's
  "operator revenue" view (doc 04).

**PayoutAccount** (per-tenant schema; rails-extension data
operator-shared)

Where a partner gets paid. Rails-agnostic core, rails-specific
typed extension.

```
PayoutAccount (per-tenant)
├── id (PK)
├── partnerId (FK → Partner)
├── rails: "stripe_connect" | "alipay" | ...
├── kycStatus: "pending" | "approved" | "rejected" | "expired"
├── countryCode
├── currencyCode
├── isDefault              -- one default per partner
├── createdAt / updatedAt

PayoutAccountStripeConnect (operator-shared, joinable by id)
├── payoutAccountId (PK / FK)
├── tenantId               -- for cross-schema query rules
├── stripeAccountId        -- the connected account ID
├── chargesEnabled / payoutsEnabled
├── lastWebhookAt
```

Notes:
- The PayoutAccount row lives per-tenant (it's tenant-partner
  data). The rails-specific extension lives operator-shared
  because Stripe webhooks address `stripeAccountId` directly and
  the operator needs to look up the owning tenant from a webhook.
- Adding Alipay or WeChat Pay later means adding a new
  `PayoutAccountAlipay` table; the per-tenant `PayoutAccount`
  stays unchanged.

**TaxArtifact** (operator-shared schema, with `tenantId`)

DAC7 report rows, VAT-compliant invoices, future fapiao /
1099 / etc. Polymorphic by jurisdiction.

```
TaxArtifact
├── id (PK)
├── tenantId
├── partnerId
├── jurisdiction: "EU_DAC7" | "DE_VAT" | "CN_FAPIAO" | ...
├── reportingPeriod        -- e.g. "2026"
├── kind: "report_row" | "invoice" | ...
├── data (JSONB)           -- shape per jurisdiction
├── status: "draft" | "issued" | "filed"
├── filedAt
├── createdAt / updatedAt
```

Notes:
- Operator-shared because the operator is the Reporting Platform
  Operator under DAC7.
- `data` is JSONB by jurisdiction discriminator. EU_DAC7 carries
  the 30+activities / €2k aggregation per partner per year;
  DE_VAT carries the VAT invoice line items; CN_FAPIAO (later)
  carries fapiao number, type, and Golden Tax integration data.
- Generation pipeline: nightly job aggregates Payments per
  partner per period; threshold-crossing creates the
  TaxArtifact in `draft`; year-end batch promotes drafts to
  `issued`; manual / API call to `filed` after submission.

### Schema placement summary

| Entity | Placement | Why |
|---|---|---|
| Partner | Per-tenant | Tenant-confidential roster |
| PartnerContact | Per-tenant | Same |
| Agreement | Per-tenant | Same |
| Engagement (rollup) | Per-tenant | Computed from per-tenant + shared sources |
| PayoutAccount (core) | Per-tenant | Tenant-partner data |
| PayoutAccountStripeConnect (extension) | Operator-shared | Stripe webhooks address it directly |
| Payment | Operator-shared (`tenantId`) | Operator is system of record |
| PlatformFee | Operator-shared (`tenantId`) | Operator's revenue |
| TaxArtifact | Operator-shared (`tenantId`) | Operator is Reporting Platform Operator |

The taxonomy-table exception in `schema.prisma` is the precedent
for the operator-shared entries with `tenantId`: cross-tenant
queries are a real requirement; schema-per-tenant doesn't fit.

### Identity overlap (Partner ↔ User), in detail

The constraint from doc 01:

- A partner is its own entity (organisation or individual)
- Contacts on a partner may or may not be Trellis users
- A Trellis user may participate in multiple partner relationships
  across multiple tenants
- Tenant-scoping applies to partner and contact records but **not**
  to the underlying user identity

The `PartnerContact` table above resolves this. The privacy
property — tenant A cannot enumerate tenant B's relationships via
the shared User — falls out of placement: `PartnerContact` lives
in the per-tenant schema. A query from tenant A's schema cannot
reach tenant B's `PartnerContact` rows even though both reference
the same `User.id`.

Edge cases:

- **A user discovers they are a partner across N tenants.** The
  user's profile UI shows "you are a contact for partners at
  tenant A and tenant C." The list is a query the User-side
  emits; each row is the User confirming a tenant-side
  relationship, not the User reading the tenant's roster.
- **A user revokes their participation as a partner.** Removes
  the User-side binding (sets `userId` to NULL on the
  PartnerContact); the PartnerContact row stays — the partner
  relationship is the tenant's, the User's binding is
  separable.
- **DAC7-reportable transaction tied to an unbound contact.**
  Allowed: legal-name and TIN can be filled manually. The User
  binding is for engagement-history attribution, not for legal
  reporting.

## Application surface

The extension presents the following surfaces to a tenant admin /
operator inside the platform UI:

### Partner list / detail

- List: filterable by status, agreement state, KYC status, last
  activity, DAC7-threshold proximity. Bulk actions (bulk invite,
  bulk export).
- Detail tabs:
  - **Overview** — identity, contacts, current agreement, KYC,
    last activity, "next action" suggestion (see AI features).
  - **Agreements** — list, create, terminate, view history.
  - **Payments** — list of payments, amounts, statuses, fee
    components.
  - **Engagement** — activity timeline (posts, mentions,
    comments, collaborations) and rollup metrics.
  - **Tax** — partner's DAC7 status (below threshold / approaching
    / reportable), generated artifacts, VAT-ID, TIN.
  - **Notes** — typed notes and uploaded documents.

### Agreement workflows

- Create from a template (saved per-tenant agreement kinds).
- Mark agreement active → enables payment creation against it.
- Termination workflow → confirms outstanding payments, generates
  final tax artifacts.

### Payment workflows

- Initiate payment against an active agreement (tenant → operator
  → Stripe → partner). Most of the mechanics are in doc 06; the
  extension surface is the form, the validation, the partner
  selection, and the result confirmation.
- Refund / dispute view.
- Payment search (by partner, date range, status, amount).

### Engagement / activity feed

- Per-partner: chronological feed of on-platform activity that
  matches the partner's bound Users (and aggregated mentions of
  the partner organisation).
- Tenant-wide: "recent partner activity" feed.
- The differentiated value lives here. A separate CRM cannot
  build this view at the same fidelity because the data is
  ETL'd at best.

### Notes, documents, manual records

- Free-text notes per partner / per agreement.
- Document attachments (signed PDFs, invoices, IDs for KYC).
- Activity log entries that aren't auto-derived (phone calls,
  off-platform meetings).

The notes / docs / manual log surface exists because the engagement
feed is incomplete on its own. Off-platform interactions are real
and the rep needs somewhere to put them.

## AI feature ranking

Doc 01's note: *"the AI-first pitch in Direction B needs concrete
ranked features before it can be evaluated; hand-waving doesn't
count."* This section ranks features by likely daily use × build
cost × Trellis-data differentiation.

### Tier 1 — likely to move the needle

These earn their place because Trellis has data no off-the-shelf
CRM has, and the use case is high-frequency.

1. **Per-partner activity summarisation** — "what has this partner
   done in the last 30 days" rendered as a few sentences over the
   engagement feed. High frequency (every partner detail view),
   leverages on-platform data, low risk (summary is checkable).
   Build cost: ~2-4 weeks. **Ship in v1.**
2. **Threshold / drift alerts** — "partner X has crossed the
   €2,000 DAC7 threshold," "partner Y's engagement has dropped
   60% vs. trailing average," "partner Z's KYC is expiring in 14
   days." Not strictly AI — rule-based + statistical — but the
   alert ranking benefits from learned weights. High value, low
   cost. **Ship in v1.**
3. **Semantic search over notes, threads, and engagement events**
   — "find partners I've discussed exclusivity with" or "partners
   active in fashion content last quarter." Embedding-based search
   over the per-tenant note + activity corpus. Build cost: ~4-6
   weeks. **Ship in v1 or v1.1.**

### Tier 2 — plausibly valuable, evidence-needed

Worth building once v1 is shipped and there's usage data showing
which directions reps actually pull on.

4. **Suggested next action** — "partner X is approaching agreement
   end and engagement is healthy → suggest renewal" /
   "partner Y has missed two payments → suggest follow-up." Mostly
   rules with AI ranking. Risk: trains reps to ignore suggestions
   if precision is poor. Pilot before promoting.
5. **Agreement template suggestion** — given a partner profile,
   suggest which agreement template to start from. Useful for
   tenants with many partner kinds; less so for tenants with one.
   Pilot.
6. **Auto-extracted activity tagging** — classify on-platform
   posts as "promotional," "organic mention," "support," etc. for
   cleaner engagement views. Useful but the classification quality
   needs to clear a bar before it stops being noise. Pilot.

### Tier 3 — probably demo-bait, defer

These pattern-match to "AI in CRM" but earn poor marks on the
build-cost / value test.

7. **AI-generated outreach drafts** — looks great in demo, real
   reps don't trust the tone or the facts. Skip until tier 1 / 2
   features are proven.
8. **Per-comment sentiment scoring at scale** — already exists
   (Trellis has a sentiment model per doc 03's
   `PostSentiment` / `CommentSentiment`). Surfacing in the CRM is
   a UI exercise, not an AI feature. Don't sell it as AI.
9. **Predictive deal forecasting** — too few datapoints per
   partner for a useful model. Aggregate-level forecasting
   (operator-side, doc 04) is more tractable.
10. **AI-driven partner discovery / "who should I work with next"**
    — interesting in principle, weak data per tenant in early days,
    needs cross-tenant signal that privacy doesn't allow without
    careful design. Defer until there's a proven user need.

### Why this ranking is structured this way

The discriminator that keeps a feature in tier 1 is **the data
Trellis uniquely has**. Activity summarisation and drift detection
draw on the engagement feed that no external CRM can ETL at the
same fidelity. Semantic search becomes interesting precisely
because the corpus is the engagement feed, not just typed notes.

The discriminator that pushes a feature to tier 3 is **AI-as-UX
over data the CRM doesn't really have**. Outreach generation,
deal forecasting, predictive partner discovery all need either
strong signal that doesn't exist in early CRM data, or cross-
tenant signal that the privacy model doesn't permit.

This is not a "we will not do AI" stance. It's a stance against
shipping AI features that exist to be in the demo. Tier 1 ships
in v1; the rest is empirical.

## Multi-tenancy model in operation

A few concrete consequences of the placement table above:

- **Schema-per-tenant scaling.** PostgreSQL handles low thousands
  of schemas; beyond that, `pg_class` bloat and connection-pool
  search-path management become real. At 5k+ tenants the model
  needs revisiting (logical partition by tenant, or a different
  isolation strategy). Not an MVP problem, but a known ceiling.
- **Cross-schema queries.** The operator-shared tables
  (Payment, PlatformFee, TaxArtifact) carry `tenantId` and are
  queried by both the marketplace-ops dashboard (cross-tenant)
  and the per-tenant CRM UI (filtered by `tenantId =
  current_tenant`). The application layer must enforce the
  filter; there is no schema-level isolation for these tables.
  This is the single largest correctness risk in the design.
- **Engagement rollups across the boundary.** The engagement
  rollup is per-tenant data computed from per-tenant Posts and
  shared User identity. Computation is per-tenant-schema-local,
  joining to the shared User table; no cross-tenant query.
- **Backfill / migration.** Adding a new column to a per-tenant
  table runs a migration per schema. Tooling for this is a
  Trellis core concern, not a CRM-extension concern.

## Build sizing

Order-of-magnitude, foundation only (no AI features):

- **Foundation** (Partner, PartnerContact, Agreement, PayoutAccount
  per-tenant; Payment, PlatformFee skeleton operator-shared;
  basic CRUD UI): **~3 person-months**.
- **Engagement rollup + activity feed UX**: ~1.5 person-months.
- **Tax artifact + DAC7 threshold tracking**: ~2 person-months
  (most of the cost is the data shape, not the UI).
- **Stripe payment integration on top of the schema**: doc 06's
  scope, ~2-3 person-months in addition.
- **Tier 1 AI features**: ~2-4 weeks each, in parallel with the
  rest.
- **Total to a usable v1**: ~6-9 person-months for one engineer,
  faster with two.

This is enough work that staffing dictates timeline more than
scope. Cutting scope without cutting tax / payments breaks the
revenue model; cutting AI features ships a usable v1 that doesn't
look like a 2026 product. The first cut should defer tier 2 / 3 AI
features and ship tier 1 with the foundation.

## Open questions

1. **Schema-per-tenant ceiling.** At what tenant count does the
   PostgreSQL schema-per-tenant model start hurting? Trellis core
   owns the answer, not this extension; flagging here because
   Bucket 2's per-tenant table count is significant (Partner +
   PartnerContact + Agreement + PayoutAccount + per-partner
   tables) and contributes to the ceiling.
2. **Per-tenant agreement templates vs. operator-managed library.**
   Does each tenant define its own agreement kinds, or does the
   operator publish a library? Both can coexist; the question is
   what ships first. Likely operator-published with tenant
   override.
3. **PartnerContact / User onboarding flow.** When a tenant
   invites a partner who already has a User account, the
   acceptance flow is a single-click bind. When they don't, the
   flow is signup + bind. The signup flow needs to not leak
   tenant identity to the User if the User declines. Detail in
   identity-federation docs, not designed here.
4. **AI feature priorities.** The tier-1 set above is a best
   guess. Once v1 is in production, usage analytics tells the
   real story. Defer tier-2 ranking to that point.
5. **Where the extension lives in the repo.** Probably
   `packages/extension-crm/` or similar, registered via
   `registerExtension()` per the existing extension pattern. Not
   a design question yet; just naming for the next ticket.
6. **Whether tenant admins can self-serve every workflow or
   require operator approval for some.** KYC review, dispute
   resolution, agreement legal review — likely operator-
   approved. Operator-side workflow is doc-04 territory; the
   extension surface needs to indicate "pending operator review"
   states.
7. **Soft-delete vs. archival of partners with reportable
   history.** DAC7 retention is 5 years from last reportable
   transaction. The status model handles this but the UX for
   "this partner is closed but legally retained" needs design.

## What this doc deliberately does not decide

- The Stripe webhook ingestion design (doc 06).
- Pushing Bucket 2 data out to the tenant's external CRM
  (doc 07).
- Pricing or packaging of the extension (doc 08).
- Final fee-structure choice (doc 08).
- Synthesis recommendation across buckets (doc 09).
- The China-specific data model variants (doc 10) — the
  rails-neutral entity names and JSONB tax-artifact `data`
  field preserve the option without forcing the design now.
- The operator role taxonomy (operator-admin vs.
  operator-finance vs. …); identity-federation work owns it.
- The exact schema rename for legacy `Partner` → `Tenant` and
  introduction of the new `Partner` model.
