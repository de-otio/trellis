# Bucket 1 — Operator's CRM

Bucket 1 covers the relationships the **operator** owns:
- #1 Operator ↔ Enterprise tenant (SaaS sales / CS)
- #4 Operator ↔ Influencer (creator deals)

Per doc 01 the bucket has a single owner (the operator's commercial /
ops team) but per doc 02 it splits into **two surfaces** with
different shapes:

1. A **sales / CS CRM** for human-managed account work.
   Pipeline-shaped, contact-centric, almost certainly in an external
   tool (Salesforce, HubSpot, …). Trellis pushes signals into it.
2. A **marketplace-ops dashboard** for the transaction-volume,
   take-rate, risk, and DAC7-readiness views the operator needs to
   *run* the marketplace day to day. Pipeline-shaped tools model
   these awkwardly. Almost certainly bespoke.

The two share underlying data (tenant identity, partner roster
size, payment events) but not UX, not audience, and not cadence.
Treating them as one product produces something mediocre at both.

This doc designs each surface independently, then sequences the
build.

## Caveats and scope

- "Operator" is the company running a Trellis-based product. Per
  doc 01 there is exactly one operator per Trellis instance.
- "Tenant" here means the legacy `Partner` model in
  `prisma/schema.prisma` — the legacy/doc-02 name collision flagged
  in doc 03 still applies. When this doc says "Tenant → Account
  mapping", the source row is `Partner` in the current schema; a
  rename is part of the work, not a precondition for the analysis.
- Bucket 2 (tenant ↔ partner) is **out of scope**. The
  marketplace-ops dashboard reads aggregates over tenant-side
  activity (GMV, partner-roster size, dispute counts) but does not
  surface individual partner records. Per-tenant partner work
  belongs to doc 05.
- Relationship #4 (operator ↔ influencer) is treated as a
  record-type variation on relationship #1 in the sales/CS CRM,
  per doc 01's "deprioritises #4 in early work" note. Naming it
  here so the connector design admits it; not designing a
  separate motion.
- The financial primitives (Payment, Platform Fee, Tax Artifact)
  are not in the schema yet. Doc 02 specifies them; doc 06 will
  design the Stripe ingestion. This doc treats them as a contract
  to be built, not as something that exists.

## Surface 1 — Sales / CS CRM (push connector)

### What it's for

The operator's commercial team runs trial-to-contract pipelines on
tenant accounts (#1) and the occasional creator deal (#4). They
already live in a CRM — typically Salesforce in mid-market /
enterprise DACH / EU, HubSpot in SMB and creator-led startups, less
often Attio or Pipedrive. They will not move to a Trellis-built
CRM for forecasting or contract work.

What's missing is **signal quality**: the existing CRM has whatever
the rep typed into it, not whatever the tenant actually did in the
product. The connector closes that gap.

### Direction (one-way push, not bidirectional sync)

**Trellis → external CRM only.** Bidirectional sync is genuinely
hard (conflict resolution, soft-delete semantics, rate limits,
metadata-API drift) and the value of reading back from the external
CRM into Trellis is low — Trellis already owns the engagement
truth.

The push includes two delivery modes that coexist:

- **Event-driven webhooks** for high-fidelity, low-latency activity
  (tenant trial signup, first admin login, first post published,
  feature-flag toggled by tenant admin, contract milestone).
  Latency target: sub-minute.
- **Daily batch reconciliation** for aggregates and corrections
  (DAU/MAU rollups for the previous day, payment-volume totals,
  partner-roster size, health score deltas). Re-asserts the
  authoritative state and recovers from missed webhooks.

Idempotency is keyed on the Trellis ID, written to a custom field
on the external record (e.g. `trellis_tenant_id__c` on Account).
Repeated deliveries of the same event are upserts, not duplicates.

### What gets mapped where

The connector's record-mapping contract, derived from Trellis
sources currently available (per doc 03) and projected sources
(per doc 02):

| External CRM record | Trellis source | Notes |
|---|---|---|
| **Account** | `Partner` (the tenant; legacy schema name) | Identified by `trellis_tenant_id__c` custom field. Properties: legal name, country, signup date, plan tier, subscription status. |
| **Contact** | `User` rows linked to the tenant via `User.partnerId` (currently) or `TenantMember` (designed, in flight on `feat/T3-tenant-crud` per doc 03) | One Account → many Contacts. Role distinction (admin / billing / standard) lives in identity-federation work, surfaced as a Contact-side flag. |
| **Activity** | `SecurityEvent` rows (logins, MFA, IdP events) for tenant admins; high-value product events emitted by the API | Selectively mapped — full event firehose would drown the CRM. See "What we do *not* push." |
| **Custom fields on Account** | Aggregates: DAU/MAU per tenant, post volume, feature-adoption flags, payment volume, partner-roster size, health score | Computed daily; pushed via batch. Health-score scheme deferred to doc 05/09. |
| **Opportunity** | Operator-managed (manual in CRM) | Trellis does not create opportunities. It enriches them via the Account it's attached to. Auto-creating opportunities from product events is brittle and the rep wants to own the pipeline definition. |
| **Lead** | Optional: pre-trial signups that haven't activated yet | Out of MVP scope. Mostly applies to self-serve trials. |

The same shape carries relationship #4 (operator ↔ influencer):
- Influencer → Contact under a special "Creators" Account (or
  per-influencer Account if the influencer is structurally a small
  business with multiple contacts).
- Creator deal → Opportunity (manual in CRM) with a separate stage
  set / record type from tenant deals.
- The connector pushes the same engagement-aggregate custom
  fields to the influencer's Contact / Account record (post
  volume, follower count, recent activity). This reuses Bucket 2
  signals — see doc 03's "audience-engagement" section — but
  scoped to the specific influencer, not aggregated over the
  whole platform.

### What we do *not* push

Push fewer things than you think. Pushing a full event firehose
floods the CRM, kills SF API quota, and trains reps to ignore the
activity timeline. Specifically:

- **No raw posts / comments / DMs.** These are not CRM activities.
  Aggregates only.
- **No follower-level events.** Followers belong to Bucket 3.
- **No partner-level data from Bucket 2.** A tenant's partner
  roster size is fine as an aggregate on the tenant's Account;
  the individual partner records are tenant-confidential and have
  no business in the operator's CRM.
- **No event firehose for non-admin users.** Filter to tenant
  admins / billing contacts. Other tenant users are not in scope
  for the operator's CRM.

### Target CRMs and SDK landscape

| CRM | Target buyer | API shape | Provenance / extraction effort | Recommendation |
|---|---|---|---|---|
| **Salesforce** | Mid-market and enterprise; DACH default | REST + Bulk 2.0 + Streaming + Metadata; OAuth (JWT bearer for server-to-server) | Heaviest. Custom-field provisioning per org via Metadata API. Test sandbox required. | First target if operator targets enterprise tenants. |
| **HubSpot** | SMB, creator-led, marketing-led | REST + Webhooks; OAuth | Lighter. Custom properties manageable via REST. | First target if operator targets SMB / creator economy. |
| **Attio** | AI-native, smaller installed base | Modern REST; OAuth | Lightest, but the smallest installed base. | Stretch target. |
| **Pipedrive** | Sales-led SMB | REST | Light. | Defer. |

**Recommendation: build the first connector against the operator's
own CRM choice.** This is not a customer-facing platform feature
yet — Bucket 1 is operator-internal — so "the operator's CRM" is
known and singular.

If the operator's CRM is Salesforce, accept the heavier integration
investment. The SF SDK / API surface is large, well-documented, and
the patterns are stable across customer Trellis-powered products if
this becomes a sellable feature later.

If the operator is on HubSpot, start there. Migrating to SF later
is more work than starting on SF, but the cost of building the
wrong thing first dwarfs the cost of swap-out — connector code is
~3-6 person-weeks for a minimal version, not 6 months.

A second-CRM target should wait until there's evidence a real
buyer wants it. The first connector is for the operator; the
second is for someone else.

### Build size

Order-of-magnitude estimates, single CRM target:

- **Minimal** (Tenant → Account, custom fields, daily batch):
  ~3-6 person-weeks. Includes auth/OAuth, custom-field
  provisioning, idempotent upsert, retry/backoff.
- **Medium** (+ activity timeline, + webhook event push, +
  reconciliation): ~3-4 person-months total.
- **Per additional CRM target**: ~50-70% of the first. The
  per-CRM SDK code does not reuse; the orchestration, dedupe,
  retry, and aggregation logic does. Resist the temptation to
  build a "CRM abstraction layer" before there's a second
  customer for it — the abstractions you'd write speculatively
  almost never match the second CRM's idiosyncrasies.

### What the connector lives in (Trellis-side)

In-Trellis surface for operating the connector:

- Operator-admin route(s) for connector configuration:
  OAuth-connect target CRM, choose record-type mappings, view sync
  status, replay failed events.
- Per-event push log table for observability (status, attempt
  count, last error, target record ID).
- Outbox pattern: events written to a Trellis-side queue table
  inside the same transaction as the source change, drained by a
  worker. Avoids the dual-write problem.
- Backoff and DLQ for failed pushes; alerts when DLQ fills.
- Operator-only role gate. The connector UI is **not** visible to
  tenant admins. Identity-federation work in flight (per doc 03)
  introduces the role taxonomy that gates this.

### Build vs. buy at the connector layer

A class of products exists that does this exact job — push
product-derived signals into Salesforce / HubSpot — without
custom code:

- **Census** / **Hightouch** / **Polytomic**: reverse-ETL tools
  that read from a SQL warehouse and push to SaaS destinations.
  Mature, multi-target, well-tested.
- **Segment** (now Twilio) Personas: similar shape, more
  marketing-flavoured.

These solve the connector problem in a generic way. Trade-offs:

- **Pro:** zero engineering for the SDK / OAuth / reconciliation
  layer. Multi-target out of the box. Mature change-data-capture
  patterns.
- **Con:** assumes a warehouse. Trellis runs on PostgreSQL
  application DB; either expose CDC from there (extra moving
  part) or bolt a warehouse on (Snowflake / BigQuery / DuckDB
  / Postgres-as-warehouse). Adds a vendor and a contract. The
  operator pays per destination per row. Custom mappings for the
  long tail of fields are still custom configuration work, just
  in the reverse-ETL tool's UI rather than in code.

**Recommendation: evaluate reverse-ETL tooling before writing
custom connector code.** A 1-day spike with Hightouch or Census
against a Trellis read-replica likely beats 4 weeks of bespoke
work. Custom code makes sense only if reverse-ETL economics break
(too many small tenants, per-row pricing dominates) or if a
specific CRM destination needs behaviour the off-the-shelf tools
don't support.

This is a buy-by-default candidate. The recommendation doc (09)
should pick a side.

## Surface 2 — Marketplace-ops dashboard

### What it's for

Running the marketplace day to day. Distinct from the sales CRM
in audience, cadence, and shape:

| Dimension | Sales / CS CRM | Marketplace-ops dashboard |
|---|---|---|
| Audience | Sales reps, CS managers | Ops, finance, risk, on-call |
| Primary unit | Account / Contact / Opportunity | Payment / PlatformFee / aggregate |
| Cadence | Per-deal touchpoints | Daily rollups + real-time alerts |
| Question shape | "What's the next action on this account?" | "What's our take-rate this week and is anything alarming?" |
| External tool fit | Strong (SF, HubSpot, Attio) | Weak (pipelines model GMV badly) |

The operator can run the platform without surface 1 (reps muddle
through with whatever's in their CRM today). The operator **cannot**
run the platform without surface 2 — money is moving and disputes,
failed payouts, and KYC blockers do not wait.

### Build vs. bolt-on

Three off-the-shelf candidates, plus bespoke:

| Option | Strength | Weakness | Verdict |
|---|---|---|---|
| **Stripe Sigma** | SQL over Stripe data; cheap (~$0.01 per row queried); strong on transaction analysis | Stripe-only — no Trellis tenant data, no partner-roster, no engagement signals; no UI beyond the Stripe dashboard. | Useful for ad-hoc finance queries; not the dashboard. |
| **Maxio** (formerly SaaSOptics + Chargify) | Subscription billing + revenue ops; strong for ARR / MRR | Built for SaaS subscriptions, not transaction marketplaces. Take-rate analysis is awkward. | Wrong shape. |
| **Chargebee** | Similar to Maxio | Same mismatch. | Wrong shape. |
| **Bespoke** | Full control; can join Stripe + Trellis in the same view | Build cost; ongoing maintenance. | Likely the right answer for the core views. |

**Recommendation: bespoke for the core views, with Stripe Sigma
as an ad-hoc query layer on top of raw Stripe data.** The
"bespoke" sounds expensive but the core views are not numerous
(see below) and the data joins between Stripe events and Trellis
tenant-side activity are exactly what Stripe Sigma can't do.

### Core views

The marketplace-ops surface needs views that answer the operator's
running questions. A first-cut list, ordered by criticality:

1. **GMV by tenant by period** (daily, weekly, monthly). Growth
   deltas. Tenant cohort retention (cohorted by tenant signup
   month).
2. **Take-rate by tenant.** Effective fee % can vary per tenant
   if rates are negotiated; surfacing the realised rate per
   tenant catches mis-priced contracts.
3. **Operator revenue (sum of Platform Fee).** The headline
   number. By period, by tenant, by partner-category if
   tagged.
4. **Payment volume by status** (succeeded / pending / failed /
   refunded / disputed). Trend lines + anomaly highlighting.
5. **Failed-payment rate** per tenant and per partner. Sustained
   elevation flags either tenant fraud, partner fraud, or rails
   misconfiguration.
6. **Dispute rate and dispute exposure** (open disputes, total
   amount under dispute). Disputes are time-sensitive and need
   real-time alerting, not batch.
7. **Partner-roster growth** per tenant (new partners onboarded,
   partner attrition). Leading indicator for tenant health.
8. **KYC status distribution** across the partner roster. Stuck
   KYCs are unbillable revenue.
9. **DAC7 readiness — partners crossing thresholds.** Partners
   approaching > 30 activities or > €2,000 in the calendar year.
   Annual reporting cycle, but the threshold-crossing event
   needs to be visible all year so reportable-partner data is
   complete by year-end.
10. **Pending-payout aggregates** — operator's float position,
    days-of-payout-outstanding distribution.

This list is ~10 views. A bespoke dashboard with 10 SQL-backed
views is a few person-weeks of work, not a quarter. The complexity
isn't the count; it's the data pipeline that feeds them.

### Where it lives (deployment shape)

Two viable shapes:

- **In-platform, operator-only role.** A new operator-admin
  surface inside the Trellis app, gated by an operator role
  (distinct from any tenant role). Same auth, same DB, same
  deployment.
- **Separate operator portal.** A separate web app in the same
  AWS account, reading from the same DB or a dedicated
  read-replica.

**MVP recommendation: in-platform, operator-only role.** Adding a
second deployment is operational overhead the operator doesn't
need on day one. The role-based gate is in flight as part of
identity federation (per doc 03's "designed, in flight"
caveats). Splitting into a separate portal can come later if
operator scale or audit requirements justify it.

### Data pipeline

The dashboard reads aggregates, not raw events. Pipeline:

```
Stripe webhooks ──► Trellis API ──► Payment / PlatformFee tables
                                          │
                                          ▼
                                   Daily rollup job
                                          │
                                          ▼
                                   Aggregate tables ──► Dashboard
                                          ▲
Trellis tenant activity (DAU, partner roster, etc.)
```

- Stripe webhook handler writes Payment / PlatformFee rows
  (designed in doc 06, not yet built).
- A nightly rollup job computes the aggregate tables: per-tenant
  daily GMV, take-rate, payment-status counts. PostgreSQL
  materialised views or plain tables refreshed by cron job —
  both work; the choice is operational, not architectural.
- Trellis tenant-activity rollups (see doc 03) feed the same
  aggregate tables.
- Dashboard reads from the aggregate tables. Sub-100ms response
  on most views.

### Real-time vs. batch

- **Most views: daily.** GMV, take-rate, partner-roster size,
  KYC distribution. The operator's ops team is not trading on
  these; daily lag is fine.
- **Real-time alerts:**
  - Dispute opened (Stripe `charge.dispute.created` webhook)
  - Payment failure spike (window-over-window comparison)
  - KYC blocker on a partner approaching DAC7 threshold
  - Payout failure on operator's float
- The alerting layer is event-driven (webhook → check →
  notification). The dashboard is batch. Same raw data, two
  consumption patterns.

### Build size

Order-of-magnitude:

- **MVP** (raw Stripe webhook handling + 4 core views: GMV,
  take-rate, payment status, dispute alerts): ~1.5-3 person-months.
  Most of the cost is the Stripe webhook ingestion (doc 06's
  surface) and the rollup tables. The dashboard UI is a small
  fraction.
- **Full** (all 10 views + DAC7 readiness + KYC distribution):
  ~3-5 person-months total. Diminishing returns on UI work; the
  data layer is the same.

The MVP overlaps heavily with doc 06's Stripe-Connect work.
Sequencing matters: doc 06's webhook ingestion is a hard
prerequisite. The dashboard is essentially a UI over the data
that doc 06 lands.

## Sequencing — what to build first

The two surfaces have different priorities:

1. **Marketplace-ops MVP first.** Without ops visibility the
   operator cannot run the marketplace. Disputes, failed payouts,
   KYC blockers will happen on day one of payment volume. This
   has to ship with or before the first paying tenant.
2. **Sales / CS CRM connector second.** A nice-to-have until
   tenant volume justifies it. Reps can muddle through with
   whatever's in their CRM today. Build this when sales-team
   complaints about signal quality exceed the cost of building
   the connector — in practice, when there are 10+ active
   tenant accounts.
3. **Marketplace-ops expansion** (DAC7 readiness, partner-roster
   views, KYC distribution) as those needs become live. DAC7
   readiness has a hard deadline (~13 months after first
   reportable transactions); plan the build for ~6 months
   before the first reporting deadline.
4. **Second sales CRM target** only when there's a real buyer
   asking for it. Not speculative.

This ordering inverts the doc-01 framing slightly. Doc 01 framed
Bucket 1 as primarily about the sales-CRM push-out. Once the
revenue model is in (doc 02), the marketplace-ops surface
dominates the priority list — it's load-bearing for running the
business, not a productivity boost on top.

## How this interacts with other docs

- **Doc 03 (engagement signals):** the connector and the dashboard
  both pull from the inventory in doc 03. The dashboard's
  partner-roster and DAC7-readiness views need data that doesn't
  exist yet (doc 03 flags these as "Bucket 1 — gaps that block
  the marketplace-ops surface"). Those gaps are filled by doc 02's
  financial primitives, which doc 06 will build.
- **Doc 06 (Stripe Connect design):** the marketplace-ops MVP is
  the customer of doc 06's webhook ingestion. The dashboard cannot
  ship without it. Doc 06's account-type and charge-model choices
  determine which Stripe events are available to ingest.
- **Doc 05 (Bucket 2):** strictly out of scope here. The
  marketplace-ops dashboard reads aggregates over Bucket 2 data
  (partner counts, GMV per tenant) but does not surface
  individual partner records.
- **Doc 09 (recommendation):** ratifies the buy-vs-build call on
  the connector (reverse-ETL tooling vs. custom code) and the
  dashboard (bespoke vs. bolt-on Stripe Sigma).

## Open questions

1. **Reverse-ETL vs. custom-coded connector.** Recommendation here
   is "evaluate reverse-ETL first." A 1-day spike with Hightouch
   or Census against a Trellis read-replica is the cheapest way to
   resolve this. The recommendation doc should ratify.
2. **First sales-CRM target.** Salesforce or HubSpot? Depends on
   the operator's own CRM. Not a generic decision.
3. **Single-tenant operator portal vs. separate deployment.** MVP
   in-platform; long-term shape depends on scale and audit
   requirements. Probably OK to defer until the in-platform
   surface starts feeling crowded.
4. **DAC7 reporting view location.** Marketplace-ops dashboard or
   a separate tax module? Argument for marketplace-ops: it's the
   surface where partner thresholds are visible all year.
   Argument for separate: the actual XML report generation and
   filing workflow has its own concerns. Likely: threshold
   visibility in marketplace-ops, report generation in a separate
   tax-ops module.
5. **Health-score scheme for sales CRM custom fields.** What goes
   in a "tenant health score" pushed to the Account record?
   Defer to doc 09 — depends on which signals from doc 03 turn
   out to be predictive, which is an empirical question.
6. **Influencer (#4) record-type fork.** Same Account / Contact
   primitives as #1 with a record-type flag is the path of least
   resistance. Whether the engagement signals pushed to an
   influencer Contact differ from those pushed to a tenant
   Account is an open product question. Defer.
7. **Connector retry semantics on the second push-target.** When
   there's a second CRM target, does each target retry
   independently, or is there a fan-out queue per event? Affects
   storage shape on the push-log table. Defer until target #2.

## What this doc deliberately does not decide

- The exact Trellis-side schema for Payment / PlatformFee / KYC
  / Tax Artifact (doc 02 sketches them; doc 06 designs them).
- The Stripe account type (Standard / Express / Custom) and
  charge model (direct / destination / separate) — doc 06's call.
- The marketplace-ops dashboard's exact UI / framework. The
  "10 core views" list is the requirements layer; rendering is
  implementation.
- The operator role taxonomy (operator-admin vs. operator-ops
  vs. operator-finance vs. ...). Identity-federation work
  introduces the framework; the specific roles needed are an
  operator-side decision, deferred.
- Pricing or packaging implications — out of scope for the
  bucket-design docs.
