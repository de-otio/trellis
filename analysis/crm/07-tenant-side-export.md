# Tenant-Side Export

Doc 01 named this surface in passing under "Bucket 2 needs export,
not just import": some enterprise tenants run their own Salesforce
or HubSpot instance and will want the Bucket 2 relationship data
pushed *into* it. This is the **inverse direction** of doc 04's
operator → operator's-CRM connector — same shape, different source,
different configuration owner, different multi-tenancy story.

This doc designs that export: what gets pushed, who configures the
push, how identity maps from a Trellis Partner to a tenant's
external Account, how data isolation between tenants is enforced
on a connector that the operator hosts, and where this overlaps
with doc 04 (and where it doesn't, which is most places).

## Caveats and scope

- **Bucket 2 only.** Tenant ↔ partner relationships, owned by the
  tenant. The operator's data (PlatformFee, TaxArtifact, dispute
  history) is **not** in scope and not pushed. Tenants see only
  their own subset of the operator-shared tables.
- **Doc 04 is the baseline.** Connector mechanics
  (one-way push, idempotency on Trellis IDs in custom fields,
  event-driven + batch reconciliation, outbox pattern) carry over.
  This doc names what changes when the source is per-tenant and
  the target CRM is the tenant's, not the operator's.
- **Doc 05 is the data model.** Partner, PartnerContact,
  Agreement, Engagement, Payment, PayoutAccount as defined in
  doc 05. Per-tenant placement matters: the export reads
  per-tenant schemas plus a tenant-scoped slice of the
  operator-shared tables.
- **Doc 06 is the financial pipeline.** Payment / PlatformFee
  rows exist by virtue of doc 06's webhook ingestion. The export
  reads them; it does not generate them.
- **Identity-federation models** still designed and in flight per
  doc 03. Tenant-admin authentication and per-tenant role gating
  use those primitives.
- **Schema-per-tenant** still the isolation model.

## How this differs from doc 04

The two integrations look superficially similar — both push
Trellis data into a Salesforce / HubSpot / Attio instance — but
the differences dominate the design:

| Dimension | Doc 04 (Bucket 1, operator → operator's CRM) | Doc 07 (Bucket 2, tenant → tenant's CRM) |
|---|---|---|
| **Source** | Operator-shared tables: Tenant aggregates, operator-managed contacts | Per-tenant schema: that tenant's Partner / Agreement / Engagement |
| **Target** | One CRM (the operator's) | N CRMs (one per tenant who turns this on) |
| **OAuth connections** | One, operator-owned | One per tenant per target CRM |
| **Configuration owner** | Operator's IT | Tenant's IT — but operator hosts the configuration UX |
| **Records pushed** | Tenant → Account, tenant admins → Contacts, aggregates as custom fields | Partner → Account, PartnerContact → Contact, agreements/payments as custom fields and activities |
| **Privacy boundary** | Single-tenant; the operator sees its own data | Multi-tenant; tenant A's connector must not see tenant B's data |
| **Volume** | One Account per tenant (tens to thousands of accounts) | Per tenant: tens to thousands of partners; aggregate across tenants is tens of thousands to millions |
| **Backfill** | Modest (operator's tenant roster) | Substantial (each tenant's full partner history) |
| **Tenant-side config UX** | Not needed | Required |

The connector code in doc 04 is solving a single OAuth-flow / rate-
limit / SDK-wrapping problem. Doc 07 layers a multi-tenancy problem
on top: per-tenant credentials, per-tenant schema mapping, per-
tenant rate limits (tenant's CRM org has its own limit, not the
operator's), per-tenant push logs, per-tenant data isolation.

The two share the SDK / OAuth / format-translation code at the
bottom layer. They share nothing in the orchestration, configuration,
or runtime layer above. Treating them as the same connector
collapses the privacy boundary and is the largest correctness risk
in this design.

## What gets exported

The exportable subset of Bucket 2, in roughly the order a CRM user
would expect to find it:

| Trellis source | External CRM target | Notes |
|---|---|---|
| **Partner** | Account | Identified in CRM by `trellis_partner_id__c` custom field. Properties: legal name, country, kind (individual / org), status, current agreement state, KYC status. |
| **PartnerContact (with User)** | Contact under the Account | Identified by `trellis_partner_contact_id__c`. Display name + email from the User row, fallback to PartnerContact override fields. |
| **PartnerContact (without User)** | Contact under the Account | Same custom field; populated entirely from PartnerContact override fields (manual entry). |
| **Agreement** | Custom object or Opportunity (CRM-dependent) | `trellis_agreement_id__c`. Status, kind, effective dates, currency, rate-model summary. |
| **Engagement aggregates** | Custom fields on Account | Last activity date, post count (90d), mention count (90d), engagement-trend flag. Refreshed daily. |
| **Payment summary** | Custom fields on Account; optionally Activity events | Total volume (90d), payment count (90d), most recent payment date, status of most recent payment. The operator's revenue (PlatformFee) is **not** in this export. |
| **Notes** | Notes on Account | Tenant-authored only. |

The export is **about the partner, from the tenant's POV**. It's
not a verbatim copy of the Trellis schema. Specifically:

- Tenant-side records only. PartnerContact's `userId` is not
  surfaced as an attribute on the Contact record; the User identity
  is internal to Trellis.
- No financial data the operator owns. PlatformFee, TaxArtifact,
  and operator-side dispute records are **not** pushed.
- Engagement is aggregated, not raw. The CRM is not the place to
  replicate the engagement timeline; it links back to Trellis for
  detail.

### What does *not* get exported (and why)

- **PlatformFee and operator revenue.** Tenant-side surface
  doesn't need it; sending it is a leak of operator economics.
- **TaxArtifact.** DAC7 reporting is the operator's filing
  obligation. The tenant sees their own DAC7 readiness in
  Trellis, but the operator's reporting data is operator-owned.
- **Other tenants' data, ever.** The largest single privacy
  boundary in this design.
- **Raw engagement events.** Aggregates only. The full timeline
  lives in Trellis with a deep link from the CRM record.
- **User identity beyond the PartnerContact's name and email.**
  A User who is a contact for Partner A in tenant 1 should not
  be discoverable as a contact for Partner B in tenant 2 via
  this export. Each tenant's CRM sees their own PartnerContact
  records only, with the User's display fields denormalised.

## Per-tenant configuration

The connector is operator-hosted, tenant-configured. Setup flow:

1. **Tenant admin opens "Integrations → External CRM" inside the
   Trellis UI** (per-tenant scope, gated by tenant-admin role
   from identity federation work).
2. **Tenant chooses a target CRM** (Salesforce / HubSpot / Attio /
   …). Choice list determined by what the operator has built; see
   "First-target choice" below.
3. **Tenant authenticates via OAuth.** Standard authorization-code
   flow, scoped to that target CRM. The connector receives an
   access + refresh token, stored encrypted, scoped to this
   tenant only.
4. **Custom-field provisioning.** The connector inspects the
   target org's metadata. If the required custom fields
   (`trellis_partner_id__c` etc.) aren't present, it offers to
   create them (or, if the tenant prefers, lets the tenant create
   them manually and confirm). For Salesforce this is a Metadata
   API call; for HubSpot, a properties API call.
5. **Backfill scope choice.** Tenant picks: "current state only"
   (push present partner roster, no history), "last 90 days,"
   or "everything." Default: current state only — see "Backfill"
   below.
6. **Activate.** Connection moves from `configured` to `active`;
   ongoing change events start flowing.

The configuration UI is operator-built once, served to all
tenants. The OAuth credentials, mappings, and runtime state live
in tenant-scoped tables.

### Tenant-scoped tables (export side)

Per-tenant schema:

```
ExportConnection
├── id (PK)
├── targetCrm: "salesforce" | "hubspot" | ...
├── status: "configured" | "active" | "paused" | "error"
├── lastFullSyncAt
├── createdAt / updatedAt

ExportConnectionCredential (operator-shared, separate
encryption-at-rest layer)
├── exportConnectionId (FK)
├── tenantId
├── accessTokenEncrypted
├── refreshTokenEncrypted
├── tokenExpiresAt
├── scopes

ExportFieldMapping
├── id (PK)
├── exportConnectionId (FK)
├── trellisField: "partner.legal_name" | "agreement.status" | ...
├── targetField: "Account.LegalName__c" | ...
├── transform (nullable JSONB)

ExportPushLog
├── id (PK)
├── exportConnectionId (FK)
├── trellisEntity: "partner" | "agreement" | ...
├── trellisId
├── targetExternalId (nullable)
├── operation: "upsert" | "delete"
├── status: "pending" | "succeeded" | "failed"
├── attemptCount
├── lastError
├── pushedAt
```

The credential table sits operator-shared with per-tenant
encryption keys (or one operator-side KMS key with tenant-scoped
access policies — implementation detail). Other tables live
per-tenant.

This shape mirrors doc 04's connector tables, but per-tenant. The
SDK code that calls the target CRM's API is shared between docs 04
and 07; the orchestration is not.

## Data flow shape

Same outbox pattern as doc 04, applied per-tenant:

```
Per-tenant:

Trellis API mutates Partner / Agreement / etc.
  │
  ▼
Outbox row written in same transaction (per-tenant table)
  │
  ▼
Per-tenant export worker
  │
  ▼
Lookup ExportConnection for tenant
  │ (skip if not active)
  ▼
Read credentials (decrypt)
Translate Trellis change → target CRM API call
Idempotent upsert via target's custom field
Update ExportPushLog
```

The worker runs per-tenant, draining the per-tenant outbox. A
single worker process can serve many tenants by polling
schemas in turn; the tenant's CRM rate limit is the bottleneck,
not the operator's worker concurrency.

### Change events

Two delivery shapes coexist (same as doc 04):

- **Event-driven** for individual record changes (partner created,
  agreement status changed, payment succeeded). Sub-minute latency.
- **Daily batch reconciliation** for engagement aggregates and to
  recover from missed events. Refreshes the rolled-up custom
  fields on Account.

Engagement aggregates are computed per-tenant from per-tenant
schemas plus the User table; the export reads the aggregate, not
the source events. This keeps the volume manageable.

## Identity mapping

The Partner ↔ User overlap from doc 05 returns here in a different
shape. The tenant's external CRM has its own model:

- **Account** = the partner organisation (or individual presented
  as an organisation-of-one).
- **Contact** = an individual associated with the Account.

Mapping:

- `Partner` → `Account`. 1:1, keyed by `trellis_partner_id__c`.
- `PartnerContact` → `Contact`. 1:1, keyed by
  `trellis_partner_contact_id__c`. The Contact is associated with
  the Account.
- `User` (when bound via PartnerContact.userId) → no direct
  representation in the external CRM. The Contact carries
  display name / email; the User's existence elsewhere is not
  exposed.

Why not push the User identity? Because:

1. The same User may be a PartnerContact for multiple tenants.
   Pushing a "Trellis User ID" into tenant A's CRM as a stable
   key on the Contact would let tenant A's CRM recognise the
   same person if they ever reappear — which is fine in
   isolation, but if the User is also a Contact in tenant B's
   CRM via the same export pipeline, tenant A and tenant B's
   CRMs now both share a stable cross-platform key. Inadvertent
   data correlation by either side becomes possible.
2. The tenant's CRM operates in its own world. The Contact is
   the tenant's record, with their own ID. The User is
   Trellis-internal.

Per-tenant mapping uses the `PartnerContact.id` (per-tenant) as
the stable key. The User's ID never crosses the export boundary.

### Mapping discovery

Two-direction-discovery is needed for backfill and reconnection:

- **Trellis → external:** has this Trellis Partner been pushed
  to this CRM before? Look up by `trellis_partner_id__c` in the
  CRM. If found, upsert against that record; if not, create.
- **External → Trellis:** the tenant may already have an Account
  in their CRM corresponding to a Partner being onboarded in
  Trellis. The first export of that Partner should *match* the
  existing Account, not create a duplicate.

The naive approach (match by name + country) is brittle. Better:
during the configuration flow, offer the tenant a **mapping UI**:

- "We found 47 Accounts in your Salesforce that look like
  potential matches for partners in Trellis. Confirm each match
  or skip."
- The tenant resolves matches once; the resulting bindings are
  written to `ExportPushLog` as pre-existing
  `targetExternalId` mappings.

This is a one-time onboarding cost. Skipping it means
guaranteed duplicates in the tenant's CRM, which kills tenant
trust in the integration.

## Privacy and tenant isolation

Single largest correctness concern.

### Schema-level isolation

Per-tenant tables (Partner, Agreement, ExportPushLog, etc.) live
in tenant schemas. Cross-tenant queries from the export worker
are simply impossible at the schema level — the worker connects
with a `search_path` set to the tenant's schema for each cycle.

### Operator-shared table isolation

Payment, PlatformFee, TaxArtifact (operator-shared with `tenantId`)
are read by the export only with an explicit `WHERE tenantId =
:current_tenant` predicate. The application layer enforces this;
no schema-level guarantee.

**Mitigation:** wrap operator-shared reads in a tenant-scoped
repository function that takes `tenantId` as required input. No
direct table access from the connector worker. Audit query: grep
the codebase for `Payment.findMany`, fail if any usage doesn't
go through the tenant-scoped wrapper.

### Credential isolation

`ExportConnectionCredential` rows are per-tenant. The decryption
operation is gated by tenant context. A credential leak (one
tenant's Salesforce token used to push another tenant's data) is
the worst-case failure mode of this design.

**Mitigation:**

- Credentials encrypted at rest with AWS KMS.
- Decryption call carries the tenant ID; KMS grant scoped per
  tenant where feasible (operationally heavyweight at low tenant
  counts; revisit at scale).
- Worker never holds credentials for two tenants in the same
  process state. One tenant's run completes (or fails and is
  rolled back) before the next tenant's credentials are
  decrypted.

### Audit and observability

Every push operation logs: tenant ID, target CRM, target
external ID, source Trellis ID, outcome. The log is reviewable
per-tenant by the tenant admin (transparency) and aggregated by
the operator (incident response). Cross-tenant push attempts
(if any ever occurred) would be obvious in the operator-side
audit.

## Backfill

A tenant turning on export has historical data: partners going
back the lifetime of the tenant. Three options for what the
backfill includes:

1. **Current state only.** Push every Partner / PartnerContact /
   active Agreement once; refresh aggregates daily; do not push
   historical Payments or closed Agreements as activities.
   **Default.** Cleanest result; no firehose into the CRM.
2. **Last 90 days.** Current state plus the last 90 days of
   payments, agreement state changes, and engagement summaries
   as activities. Tenant gets a meaningful but bounded history.
3. **Everything.** Current state plus all historical activities.
   The CRM looks like the partner roster has been there forever.
   Risk: floods activity timelines, eats CRM API quota, makes the
   import look ridiculous when there are years of dense activity.

The choice is per-tenant, made at configuration time. Default to
**current state only**: the tenant can request expansion if they
want it, and the conservative default avoids the
"surprised by a thousand activity entries" failure mode.

Backfill runs as a one-shot job, not as ongoing event flow.
Status (in progress / completed / failed) is visible in the
configuration UI. Re-running backfill from scratch is a tenant-
visible button (with a "this will create N new activity entries"
warning).

## Reverse-ETL revisited

Doc 04 flagged reverse-ETL tooling (Hightouch / Census /
Polytomic) as a buy-by-default candidate for the operator's
connector. Does the same recommendation hold here?

**Probably not for MVP.** The multi-tenancy aspect changes the
economics:

- Reverse-ETL tools assume one source warehouse, N destinations.
  Per-tenant credentials, per-tenant filtering, per-tenant
  schema (literally — different PostgreSQL schemas per tenant)
  do not fit the model cleanly. Some tools support row-level
  destination routing via columns; doing it via schemas is
  awkward.
- The privacy boundary is harder to verify. A Hightouch
  destination that accidentally writes tenant A's row to
  tenant B's CRM is a catastrophic failure with no schema-level
  defence. Building this in-house, with tenant context in every
  layer, is more auditable.
- Tenant-facing configuration UX (custom-field provisioning,
  mapping discovery, backfill scope) is part of the product.
  Hightouch et al. don't ship a tenant-fronted UX layer.
- Per-tenant cost. Reverse-ETL tools price per destination per
  row; at N tenants × M rows, the cost compounds against the
  operator's revenue.

**MVP recommendation: build the export in Trellis.** The SDK /
OAuth / format-translation layer can share code with doc 04's
implementation. Reconsider reverse-ETL when:

- The first 2-3 enterprise tenants are on, and pricing /
  reliability evidence is available.
- A reverse-ETL vendor adds first-class multi-tenant primitives
  (per-tenant credentials at the platform level).
- The operator's per-tenant per-row volume justifies the
  consolidation.

## Where this lives in the repo

The complexity of this surface (per-tenant credentials, encrypted
credential storage, OAuth flows, target-CRM SDKs, mapping
discovery UX, push-log machinery) raises a fair question: is this
substantial enough to be its own thing, separate from the Bucket 2
CRM extension? The answer lands at three layers, with three
different recommendations.

### Layer 1 — The Bucket 2 CRM (doc 05)

A Trellis extension. Doc 05 already names this:
`packages/extension-crm/` (working name), registered via
`registerExtension()`. The Partner / PartnerContact / Agreement /
Engagement entities, the partner-detail UI, the agreement and
payment workflows live here. **Not in core**, because no other
Trellis-powered product needs the CRM data model; it's
verticalised relationship-management.

### Layer 2 — The export pipeline (this doc)

**MVP: ship inside `extension-crm`.** Two paths were considered:

- **Inside `extension-crm`.** The Partner / Agreement entities the
  export reads are already there; no inter-extension dependency;
  the configuration UI lives next to the partner UI; faster to
  ship. **Default.**
- **Separate `extension-connectors`.** Cleaner separation; a
  future where doc 04's operator-side connector reuses the same
  SDK layer is easier to factor; introduces extension-to-extension
  dependency, which Trellis's current extension API does not have
  a strong story for (see `packages/extension-api/`).

The complexity here is mostly the multi-tenancy machinery, which
is **Bucket-2-specific** at MVP. Splitting it into a separate
extension does not make it less complex; it moves the seam without
changing the work. Default to the simpler shape.

The split becomes worth doing **when the second consumer of the
connector machinery exists** — concretely, when doc 04's
operator-side connector ships and the SDK / OAuth / push-log
code is duplicated. At that point factor a shared package out
(see Layer 3 below).

### Layer 3 — The connector SDK / framework (cross-cutting)

A shared **package**, not necessarily an extension:
`packages/connectors-sdk/` (or similar). Houses:

- Target-CRM SDK wrappers (Salesforce, HubSpot, …)
- OAuth flow primitives (authorization-code, token refresh)
- Encrypted credential storage primitives (KMS integration,
  decrypt-with-tenant-context wrapper)
- Idempotent upsert primitives
- Push-log table shape and worker patterns

Both doc 04 (operator-side connector, single-tenant) and doc 07
(tenant-side connector, multi-tenant) would import this package.
It's a shared library, not a `registerExtension()`-style
extension — there are no routes, no metadata schemas, no
config-schema contributions. It's plumbing.

**Build it when the duplication is real**, not before. Doc 04 is
likely the first connector to ship; this doc's export pipeline
follows. Factor at the point the second consumer lands.

### Layer 4 — Trellis core

**No.** OAuth, encrypted credentials, push logs, and target-CRM
SDKs do not earn a place in core today. The argument "platform-
level concerns belong in core" is plausible in the abstract but
fails the "is there a second consumer right now?" test. The day
core has a non-CRM consumer of OAuth + encrypted credentials,
revisit; until then, this is application-layer code.

### Summary of placement

| Layer | Where | When |
|---|---|---|
| Bucket 2 CRM data model + UI | `packages/extension-crm/` | Doc 05's v1 |
| Export pipeline (this doc) | Inside `extension-crm` initially | When first enterprise tenant requests it (doc 07's v1) |
| Connector SDK / framework | `packages/connectors-sdk/` (factored) | When doc 04's operator-side connector ships and SDK code is duplicated |
| OAuth / credential primitives in core | n/a | Defer indefinitely |

This closes doc 05's "where the extension lives in the repo" open
question (in scope: Bucket 2 CRM = `packages/extension-crm/`) and
defers the connector-package factoring until there are two
consumers.

## Build sizing

Order-of-magnitude, single target CRM:

- **Foundation** (per-tenant ExportConnection schema,
  configuration UI, OAuth flow, encrypted credential storage,
  Salesforce SDK wrapping): **~2-3 person-months**.
- **Push pipeline** (outbox, worker, idempotent upsert, push
  log, backfill mode, daily reconciliation): **~2 person-months**.
- **Mapping discovery UI** (one-time tenant onboarding flow):
  **~3-4 person-weeks**.
- **Custom-field provisioning** (Metadata API for SF, properties
  API for HubSpot): **~2-3 person-weeks**.
- **Per additional CRM target**: ~50-70% of the first, same
  pattern as doc 04.

**Total to a usable v1 (one CRM target):** ~4-6 person-months.

Sequencing relative to other Bucket 2 work: the export is **not**
a v1 prerequisite for Bucket 2 itself. Tenant CRM (doc 05) ships
first; export ships when the first enterprise tenant requests
the integration. Likely 3-6 months after Bucket 2 v1.

## First-target choice

Same trade-offs as doc 04, with one difference: the target is the
*tenant's* CRM, not the operator's. The operator chooses which
targets to support; tenants pick from that menu.

- **Salesforce first** if the operator's tenant ICP is mid-market /
  enterprise EU. Most likely the right answer for DACH.
- **HubSpot first** if the operator's tenant ICP is SMB / creator-
  led. Cheaper to build (simpler API, no Metadata-API custom-field
  ceremony).

Operator-side decision; doc 09 (recommendation) ratifies based on
tenant ICP at MVP.

A tenant on a target the operator hasn't built (e.g. Pipedrive,
Attio) gets "this connector is on our roadmap" — not "build it
yourself." Custom per-tenant connectors are not a viable model.

## Open questions

1. **Operator audit access to tenant credentials.** Should the
   operator be able to revoke a tenant's stored OAuth tokens?
   (Yes — for incident response, e.g. tenant offboarding,
   credential leak.) Should the operator be able to *use* them?
   (No — separation of duties.)
2. **Tenant-initiated re-sync after CRM-side data loss.** If a
   tenant restores a Salesforce backup that's older than the
   current Trellis state, the connector's idempotency keys still
   work (re-creates as needed). But "we lost a week of data, can
   you re-push everything from a week ago" needs a UX.
3. **Self-managed Salesforce sandboxes vs. production orgs.**
   Some tenants will want to test in sandbox first. The
   configuration UX should let a tenant connect to a sandbox,
   switch to production, and migrate the mappings.
4. **Bidirectional sync (read from external CRM into Trellis).**
   Out of scope for this doc. Scoping it later if a real need
   emerges; doc 01's framing ("opposite of integration from
   Bucket 1, must not be conflated") is deliberate — adding
   bidirectional now blurs the boundary.
5. **Multi-target per tenant.** Can a tenant connect Salesforce
   *and* HubSpot simultaneously? Schema admits it (the
   `targetCrm` column on ExportConnection allows multiple rows
   per tenant); UX needs to confirm it's actually a use case
   before building.
6. **Pricing of the export feature.** Free with Bucket 2,
   priced add-on, or per-tenant per-CRM-connection? Out of
   scope here; doc 09's territory.
7. **Connector-package factoring trigger.** "When doc 04's
   connector ships and code is duplicated" is the rule per the
   "Where this lives in the repo" section. Concrete trigger:
   if the OAuth + token-refresh + push-log code in
   `extension-crm` and the doc-04 implementation diverges
   meaningfully (different bug fixes, different retry semantics)
   on the same target CRM, that's the cue to factor.

## What this doc deliberately does not decide

- The exact target-CRM list at MVP (doc 09 picks based on
  tenant ICP).
- The pricing or packaging of the export.
- Bidirectional sync (deferred until a real need is proven).
- Whether the connector code shares a workspace with doc 04's.
- The tenant-admin role taxonomy that gates the configuration UI
  (identity-federation work).
- Cross-CRM conventions (how Trellis fields map to "the
  Salesforce shape" vs. "the HubSpot shape") — implementation
  detail, decided per target.
