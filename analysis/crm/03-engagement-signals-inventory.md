# Engagement Signals Inventory

[02-operator-revenue-model.md](02-operator-revenue-model.md) established
the financial primitives the platform needs to *gain* (Partner, Payout
Account, Agreement, Payment, Platform Fee, Tax Artifact). This doc
inventories the engagement signals the platform already *has* —
organised by which bucket consumes them — so the per-bucket docs (04
and 05) can specify precisely what flows into the operator's surfaces
and the tenant's CRM, and what additional capture is needed.

The asymmetry called out in the README still holds: Trellis sits on
high-fidelity engagement data that no off-the-shelf CRM gets natively.
This doc makes that claim concrete.

## Caveats and scope

- **"Engagement signal" here means non-financial signal.** Money-movement
  data is not yet in the schema (see doc 02); it arrives via Stripe
  Connect once that integration is built. Until then, every signal
  below is a behavioural / relational / content signal.
- **The schema lives in Trellis; the deployment lives in Trellis.**
  Per the project CLAUDE.md, Trellis is not deployed standalone — its
  Prisma models are consumed by Trellis, which holds the populated
  data. Schema-level claims here are about Trellis; data-volume
  claims are about whatever Trellis (or any future Trellis-based
  product) accumulates in production.
- **Multi-tenant isolation is schema-per-tenant, not column-per-row.**
  The schema explicitly says `NO tenantId - schema-per-tenant provides
  isolation` ([schema.prisma:15](../../prisma/schema.prisma#L15)).
  Most engagement signals therefore live in per-tenant Postgres
  schemas, not in a global table joined by `tenantId`. Per-tenant
  aggregation is a per-schema query (or fan-out across schemas)
  rather than a `GROUP BY tenant_id`. Exceptions are the few tables
  that *do* carry `tenantId` because they hold tenant-scoped *config*
  shared across schemas (e.g. `TaxonomyDimension`,
  `TaxonomyCategory`).
- **Schema baseline for this doc.** Two parts of the schema are
  genuinely in flight and the inventory below has to acknowledge
  that:
  1. **Multi-tenant identity federation.** The design lives in
     `doc/02-technical/identity-federation/`; the implementation
     (`Tenant`, `TenantMember`, `TenantIdentityProvider`,
     `TenantDomain`, `TenantInvitation`, `TenantRoleMapping`) is on
     in-flight branches (`feat/T3-tenant-crud`,
     `feat/T5-idp-crud`, `feat/identity-federation-v0.7`) and not
     yet merged. Today's main has only the legacy `Partner` model
     (B2B SSO; `User.partnerId`, `SecurityEvent.partnerId`), which
     is the *predecessor* of `Tenant` and represents a
     SSO-providing organisation, not a tenant's B2B partner.
     Inventory items that depend on the new `Tenant*` family are
     flagged **(designed, in flight)** so the gap is visible.
  2. **Bucket 2 financial primitives.** None of the doc 02 entities
     (Partner-of-tenant, Payout Account, Agreement, Payment,
     Platform Fee, Tax Artifact) exist yet. The existing `Partner`
     model name collision is a future renaming problem; doc 02's
     "Partner" is a different concept from today's `Partner`.
- **The Trellis vs. extension boundary moves.** Items below tagged
  *"may relocate"* are ones the
  [generic-core analysis](../generic-core/) flagged as candidates to
  move out of core into a vertical extension. Doc 03 catalogues
  signals where they live today; the bucket assignment doesn't change
  if they relocate.

## Quick map: signal categories → buckets

| Signal category | Bucket 1 (operator) | Bucket 2 (tenant) | Bucket 3 (audience) |
|---|---|---|---|
| Tenant-level activity (DAU/MAU, post volume, feature adoption) | Primary | Indirect | — |
| Identity-federation events (SAML/OIDC, JIT provisioning) | Primary | Indirect | — |
| User-level activity (logins, posting cadence, profile completeness) | Indirect (aggregate) | Primary (per-partner) | Primary (per-follower) |
| Relationship signals (follows, mentions, collaborations) | — | Primary | Primary |
| Content signals (sentiment, taxonomy, moderation) | Indirect | Primary | Primary |
| Federation / ActivityPub | Indirect | Indirect | Indirect |
| Financial / transaction (doc 02) | **Missing — to build** | **Missing — to build** | n/a (out of scope) |

"Primary" = the bucket directly consumes this signal. "Indirect" =
the bucket consumes an aggregate or derived form. "—" = not relevant.

## Bucket 1 — Operator's CRM signals

The operator needs (a) tenant-account health for the sales/CS surface,
and (b) marketplace-ops metrics for the bespoke dashboard (per doc 02).
Both are aggregations over per-tenant activity.

### Tenant-level activity

Currently in the schema (read per-tenant-schema unless otherwise noted):

- **Tenant content volume** — `Post.createdAt`,
  `PostComment.createdAt` rolled up per schema. Post / comment
  volume per tenant per period.
- **Entity inventory** — `Entity.entityType`, `Entity.status`,
  counted per schema. Entity counts per tenant by type and status.
- **Group activity** — `Group`, `GroupMember.joinedAt`. Membership
  churn signals per schema.
- **Member roster (designed, in flight).** `TenantMember.lastActiveAt`,
  `TenantMember.status`, `TenantMember.isJitProvisioned` will provide
  per-tenant active-member count, JIT-provisioning rate, and status
  distribution once the identity-federation work merges. Until then,
  the closest proxy is `User.partnerId` membership and SSO-related
  `SecurityEvent` rows.
- **Admin login cadence** — `SecurityEvent` rows of type `sso_login`
  / `sso_failed`, scoped via `partnerId` (legacy) or `TenantMember`
  (post-merge), plus Cognito sign-in logs. Together these support
  "is the tenant admin engaged?" indicators.
- **Feature adoption proxies** — taxonomy usage
  (`PostTaxonomyTag`, `EntityTaxonomyTag`), notification
  preferences, custom-audience usage (`CustomAudience`,
  `CustomAudienceMember`). These are derived signals, not stored
  as flags.

What's *not* there as a stored aggregate:

- **DAU/MAU per tenant.** The components are scattered:
  `SecurityEvent` for SSO sign-ins, Cognito logs, and post / comment
  timestamps as activity proxies. Sessions live in DynamoDB
  (KV-only), not Prisma. No rolled-up DAU/MAU metric is persisted in
  the relational schema; a scheduled aggregation job would need to
  write into a new table (likely a global one, since the metric is
  per-tenant and the operator wants it cross-tenant).
- **Tenant health score.** Computable from the above; not stored.

### Identity-federation events (designed, in flight)

Per `doc/02-technical/identity-federation/`, multi-tenant SAML/OIDC is
a first-class capability of Trellis. The implementation is in flight
on `feat/T3-tenant-crud`, `feat/T5-idp-crud`, and
`feat/identity-federation-v0.7`. Once it lands, the data captured
maps directly to account-health signals:

- **IdP configuration health** — `TenantIdentityProvider.status`,
  metadata refresh state, last successful issuer probe. A failing
  IdP is a tenant-health red flag.
- **JIT provisioning rate** — `TenantMember.isJitProvisioned` count
  over time tells the operator how active the tenant's workforce
  rollout is.
- **Domain verification** — `TenantDomain.verified` and verification
  age. Indicates onboarding progress.
- **Role-mapping coverage** — `TenantRoleMapping` rows per tenant.
  An empty mapping table on a tenant with active SAML usage is an
  onboarding-incomplete signal.
- **Invitation activity** — `TenantInvitation` rows, acceptance vs.
  expiry rate, age of pending invitations.

These signals are particularly valuable in Bucket 1 because they
correlate with onboarding success and renewal risk in a way that no
external CRM can see without bespoke ETL.

In the interim (legacy `Partner` schema), the available proxies are
weaker: `User.partnerId` for membership, SSO-related `SecurityEvent`
rows for IdP-error visibility, and `Invitation` rows for invitation
activity. The CRM connector design (doc 04) should target the
post-merge schema; the legacy schema is not worth wiring up for the
short window before identity-federation lands.

### Marketplace-ops signals (Bucket 1's second surface)

Per doc 02, the operator's marketplace-ops dashboard wants GMV,
take-rate, partner-roster size, dispute rate, payment frequency,
average payment size. **None of these exist today.** They appear once
the doc 02 financial primitives are built. Until then, the
marketplace-ops surface has no data; only the sales-CRM half of
Bucket 1 is feedable from the current schema.

The CRM connector design (doc 04) needs to handle the asymmetry:
sales-CRM signals push from day one, marketplace-ops signals push
from "Stripe Connect live" forwards.

## Bucket 2 — Tenant's CRM signals

Bucket 2 is engagement-native: the relationship history *is*
on-platform activity. The signals below are the substrate the tenant
uses to evaluate, manage, and report on their B2B partners.

### Partner-as-user activity

When a partner has at least one Trellis user account on the platform
(common — most influencers, employees of sponsors, etc.), the tenant
can see:

- **Profile state** — `User.username`, `User.handle`,
  `User.profileVisibility`, `User.identityVerified`, `User.emailVerified`.
  Verification + completeness as a partner-readiness signal.
- **Posting cadence** — `Post.authorId` over time. Active partner
  vs. dormant.
- **Comment / engagement** — `PostComment.authorId` volume and
  pattern; `PostSentiment` and `CommentSentiment` distribution
  associated with the partner's content.
- **Followers / network position** — graph database
  (`:RELATES_TO` edges, not in Prisma) holds scored social-graph
  data; this is the "reach" signal a tenant cares about for
  influencer evaluation.
- **DM activity** — `DirectMessage` send/receive counts and read
  status; useful only when both parties consent to surface this in
  the CRM.

### Tenant ↔ partner relationship signals

- **Mentions** — `PostSubject` records partner-as-subject in tenant
  posts; primary vs. secondary subject. The most direct "this
  partner appeared in our content" signal.
- **Entity ownership / collaboration** — `EntityOwnership` rows
  (with role, `addedAt`, `removedAt`, `status`). The partner
  co-owning a tenant entity is a relationship event with a
  timeline.
- **Engagement tier signals** — `CircleConfig` and
  `CircleReadState`. Tier-of-closeness signals derived from a
  user's own social graph.
- **Threading / conversation depth** — `PostComment.rootUri`,
  `PostComment.replyToUri`. Conversation density is a partner
  engagement-quality signal.

### Tenant content signals adjacent to partners

- **Taxonomy adoption** — `PostTaxonomyTag`, `EntityTaxonomyTag`.
  Which dimensions a tenant uses, and whether partners' content
  aligns with the tenant's taxonomy choices.
- **Content classification** — `Post.screeningRiskLevel`,
  `Post.contentCategory`. Risk profile of partner-associated
  content.
- **Moderation events** — `Post.hiddenByAuthor`, `Post.deletedAt`,
  `PostComment.editedAt` + `originalText`. Partner content
  retracted or edited is a CRM-relevant signal.
- **Link reputation** — `LinkCheck.status`, `LinkReport`,
  `DomainReputation`. Partner posting low-reputation links is a
  red flag worth surfacing.
- **Media metadata** — `MediaFile` width/height/duration/EXIF/GPS.
  Generally a content-quality signal; GPS may be a privacy-sensitive
  field that should not surface in a CRM by default.

### Partner identity in the tenant's space (designed, in flight)

Identity-federation signals also matter at Bucket 2 granularity when
the partner is an enterprise represented through SAML/OIDC. Once the
`Tenant*` family lands:

- **Multi-contact partner shape.** A partner organisation may have
  several `TenantMember` rows (different humans at the same
  partner). Doc 01 already flagged the partner ↔ contact ↔ user
  modelling decision.
- **Contact-level activity.** `TenantMember.lastActiveAt` per
  contact, per partner, gives "is this contact still warm?"
  signals that Salesforce-style CRMs ask about explicitly.

Today's `User.partnerId` model collapses these to a single user-row
per person and doesn't model "contact" separately. Doc 05's data
model needs to be drafted against the post-merge schema, not the
current one.

## Bucket 3 — Audience engagement signals (out of scope, catalogued)

Doc 01 reclassified this as a non-CRM platform capability. The
underlying signals exist and are rich:

- Follower graph state, follower content engagement, lifecycle
  events (signup, first action, dormancy), churn / reactivation
  events derived from session history.
- B2C-scale notification preferences, reaction distributions,
  sentiment aggregates per follower-audience.
- Parental-control / child-safety signals (`ParentalLink`,
  related guardian / consent flows). These are vertical-specific
  privacy-sensitive signals; may relocate.

If Bucket 3 is ever pursued, the inventory exists. Not analysed
further here.

## Cross-cutting signals (ActivityPub federation)

Per the project CLAUDE.md, ActivityPub via Fedify is feature-flagged
off by default but designed-for. When enabled it adds:

- **Federated identity** — `User.actorUri`, `Entity.actorUri`,
  inbox/outbox URLs.
- **Inter-instance activity** — raw `Activity` records.

For Bucket 1 these appear as a tenant-feature-adoption signal
("does this tenant have AP enabled, what's the federated activity
volume?"). For Bucket 2 they extend the partner activity surface
across the fediverse rather than just the tenant's instance. For
Bucket 3 they are part of the audience surface.

Federation doesn't introduce new CRM-shape signals; it widens the
scope of existing ones. Worth naming so it isn't rediscovered later.

## Gaps that matter

What the schema does *not* have, sorted by which bucket needs it:

### Bucket 2 — gaps that block the build

These are required-from-day-one if Bucket 2 is to support the
operator's revenue model (per doc 02):

- **Partner-of-tenant as a first-class entity.** Today's `Partner`
  model is a *different concept* (legacy B2B-SSO predecessor of
  `Tenant`); the doc 02 "Partner" — a tenant's B2B partner roster
  member — does not exist. Partner-of-tenant ≠ user; some partners
  have multiple users; some have none yet. The naming collision
  needs to be resolved when this is built (rename legacy `Partner`
  → `Tenant`, then introduce a new `Partner` for the doc 02
  meaning).
- **Agreements with commercial terms.** No model captures rate,
  schedule, scope, or conditions of a tenant↔partner deal.
- **Payment events.** No charge / payout / refund records.
- **Payout destinations and KYC state.** No payout-account
  abstraction.
- **Platform-fee accounting.** No per-transaction fee record.
- **Tax artifacts.** No VAT-invoice / DAC7 record. Polymorphic
  by jurisdiction (per doc 02).
- **Multi-contact partner relationships.** No "Contact" entity
  scoping multiple `TenantMember`s to a single Partner-of-tenant.

### Bucket 1 — gaps that block the marketplace-ops surface

These are downstream of the Bucket 2 gaps and don't need separate
modelling — they are aggregations over the Bucket 2 entities once
built:

- GMV, take-rate, fee revenue per tenant
- Partner-roster size and churn per tenant
- Dispute rate, refund rate, failed-payment rate per tenant

The sales-CRM half of Bucket 1 has *no* schema gaps — the existing
tenant-activity and identity-federation signals are sufficient to
push into Salesforce / HubSpot / Attio as part of doc 04.

### Notable gaps that don't block any bucket

Worth noting so they don't get rediscovered:

- **No DAU/MAU aggregation table.** Computable but not stored.
  Whether the marketplace-ops dashboard needs a persisted
  aggregate vs. on-the-fly computation is a doc 04 decision.
- **No support-ticket history.** Out of scope; lives in whatever
  helpdesk product the operator uses (Zendesk / Intercom /
  Linear). The CRM connector may pull tickets in from there
  rather than store them.
- **No email-engagement data.** Bucket 3 territory; not relevant to
  Bucket 1 or 2.
- **No explicit health-score field.** Computable from the above;
  may be persisted as a denormalised cache once the formula is
  set. Doc 04 / 05 territory.
- **No explicit moderation-action history.** Hidden / deleted /
  edited states are observable on the affected records, but a
  dedicated "moderation event" log doesn't exist. Adequate for
  CRM context; insufficient if a moderation-trail audit becomes
  a separate requirement.

## Implications for next docs

- **Doc 04 (operator's CRM)** can specify the sales-CRM connector
  shape from existing data. The marketplace-ops dashboard waits on
  Bucket 2 financial primitives, and doc 04 should describe both
  states (pre-Stripe and post-Stripe).
- **Doc 05 (tenant's CRM)** has rich engagement signals to build on
  from day one, but the entity model still needs the doc 02
  financial primitives added. Doc 05 should specify the
  relationship between (existing) `User` / `Entity` /
  `EntityOwnership` / `PostSubject` and the (new) `Partner` /
  `Agreement` / `Payment` entities — particularly the partner ↔ user
  identity-overlap problem flagged in doc 01.
- **Doc 06 (Stripe Connect design)** doesn't depend on this
  inventory.
- **Doc 07 (tenant-side export)** depends on the identity-mapping
  decisions made in doc 05.

## What this doc deliberately does not decide

- The persisted-vs-computed split for derived signals (DAU/MAU,
  health scores). Doc 04 / 05 territory.
- The schema additions to close the Bucket 2 financial-primitive
  gaps. Doc 05 + doc 06 territory.
- AI feature ranking. Needs the data inventory above as input —
  defer to doc 05.
- Whether engagement signals should surface in real time or in
  batch. Doc 04 / 05 territory.
