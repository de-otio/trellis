---
title: Compliance
description: How Trellis supports GDPR and related obligations — data subject rights, residency, encryption, sub-processor transparency, and a machine-readable compliance surface.
sidebar: Compliance
order: 30
---

# Compliance

Trellis treats compliance as a design constraint rather than a bolt-on. Data
protection, residency, and transparency obligations are mapped to concrete pieces
of the system, and the relevant facts are published in a machine-readable form so
that they can be checked rather than taken on faith.

## Data subject rights

Trellis is designed to support the data subject rights that apply to a social
platform:

| Right | How Trellis supports it |
|---|---|
| **Access** (Art. 15) | A user can export their personal data — profile, tenant memberships, and audit-log entries about them — through an export endpoint. |
| **Rectification** (Art. 16) | Profile fields are user-editable; data sourced from an external identity provider is corrected upstream and flows through on the next token refresh. |
| **Erasure** (Art. 17) | A user can request deletion, which removes or disables their identity and cascades to their data. |
| **Restriction** (Art. 18) | A membership can be suspended, removing the user from active operations without deleting their data. |
| **Portability** (Art. 20) | The same export produces structured, schema-versioned JSON. |
| **Objection** (Art. 21) | For tenant participation that depends on federation, the user's control is to leave the tenant. |

## Notice and action (DSA Art. 16 and 17)

Trellis ships the mechanism for the Digital Services Act's notice-and-action
obligations; the deployment supplies the jurisdiction — the offence categories
and the legal copy — because core cannot truthfully invent either. The full
route contract is in the [Content reports API](../reference/content-reports-api.md).

| Obligation | How Trellis supports it |
|---|---|
| **Notice** (Art. 16(1)–(2)) | An authenticated user files a report with `POST /api/reports` against a post, comment, media item, entity, user or URL, choosing from the deployment-seeded category vocabulary served by `GET /api/report-categories`. Core routes only on each category's `RoutingClass` (`ILLEGAL_PRIORITY`, `ILLEGAL`, `POLICY_VIOLATION`, `FEEDBACK`) and never learns what a category means. |
| **Confirmation of receipt** (Art. 16(4)) | Sent on filing, and readable back at any time from `GET /api/reports/:id` — the report row's existence is the receipt, so a lost email never costs the reporter their confirmation. |
| **Decision and redress information** (Art. 16(5)) | A `SUPER_ADMIN` drives `pending → acknowledged → decided` on `POST /api/admin/content-reports/:id/decision`; the terminal transition is what sends the reporter the decision notice, so a report cannot be decided without its reporter being notified. The redress copy travels with the decision. |
| **Timely, diligent, non-arbitrary handling** (Art. 16(6)) | The review queue (`GET /api/admin/content-reports`) is ordered oldest-first because the handling is deadline-bearing; the lifecycle allows only `pending → acknowledged → decided`, and an illegal transition is refused (`409`) rather than overwriting a decision. |
| **Statement of reasons** (Art. 17) | Written when content is restricted. The reporter's status poll surfaces only the fact and the kind of restriction — never the affected user or the template parameters. A statement may be written *suppressed*: the audit record exists but delivery to the affected user is skipped, which is how the illegal-priority carve-out avoids tipping off the account. |
| **Illegal-content carve-out** | A category routing to `ILLEGAL_PRIORITY` does not wait for a human before its first protective steps: the resource is hidden, the original is preserved under an **evidence hold** through the injected `EvidencePreservationStore`, a suppressed statement is written, media is marked so it is never offered the appeal path, and a `pending` authority report is created. The hold is honoured by the nightly hard-delete purge, the account-deletion media erasure and the orphaned-media purge, so evidence is never destroyed while a case is open. |
| **Reporting to authorities** | **Human-gated, always.** Core creates the authority report and submits nothing — filing goes through `markAuthorityReportSubmitted` after review. An unreviewed accusation that auto-filed would be a worse failure than a delayed one, and a denial-of-service vector against any user. |

The seams a deployment injects before activating any `ILLEGAL_*` category —
evidence store, authority channel, moderation-feedback sink, statement
delivery, alarm and operator-alert hooks, and the localized reporter templates
— all ship with fail-safe defaults (the stores throw until configured; the
authority channel is a manual no-op).

## Minimum age

Accounts are held by people aged **18 and over**. The minimum is enforced
server-side at every point a date of birth enters the system — the brokered
registration endpoint and just-in-time provisioning on first sign-in — so a
minor account cannot be created, and the platform therefore does not process
children's data as a matter of construction rather than policy. The
guardian-facing endpoints that once managed linked child accounts return
`410 Gone` (see the [User profile API](../reference/user-profile-api.md#former-parental-controls-endpoints)).
The age-tier *policy* tables remain in the codebase as a quarantined,
re-enableable capability; nothing resolves a session to a minor tier while the
product decision stands.

## Data minimization

Federation collects only the claims it needs to identify a user and assign a
role — typically email, name, and group memberships. Surplus claims are not
stored. Group *memberships* of specific users are resolved when a token is issued
and are not persisted. Raw claim values are never written to logs.

## Data residency

A tenant can be pinned to a region, and all of that tenant's data — relational
rows, stored objects, identity records, key/value items, and graph data — stays
in that region. EU tenants default to an EU region. Cross-region movement happens
only for provider-internal replication where enabled, under the cloud provider's
standard contractual clauses.

## Encryption

- **At rest:** all persistent stores are encrypted with AES-256.
- **In transit:** all connections use TLS, with a modern minimum version
  enforced and managed certificates on public endpoints.

See [Security architecture](security-architecture.md) for the full data-protection
posture.

## Sub-processor transparency

The sub-processors Trellis relies on — the cloud provider and its named services,
and any content-moderation or email services — are disclosed. Where a tenant
connects its own identity provider, that provider becomes a tenant-specific
sub-processor, disclosed to that tenant's administrators. Adding a sub-processor
is a deliberate, reviewed change.

## Breach notification

Trellis's audit and structured logging provide the forensic input needed to meet
a 72-hour personal-data breach notification obligation. The notification process
itself is operational and runbook-driven; the technical evidence trail is built
in.

## Audit logs

Administrative actions are recorded to an exportable audit trail. Tenant
administrators can retrieve their own tenant's events; the export is available in
structured form for review.

## A machine-readable compliance surface

Rather than answering the same compliance questionnaire by hand each time,
Trellis publishes its compliance posture in a structured, versioned form that a
reviewer — or a reviewer's tooling — can fetch and check directly.

**Design principles for this surface:**

- **Single source of truth.** Every compliance fact comes from one canonical
  document, not scattered marketing pages.
- **Verifiable, not aspirational.** Each entry carries a status and a link to the
  running code, runbook, or artifact that backs it. Marketing language is
  excluded by policy.
- **Versioned and timestamped.** The surface records when it was published and
  when each fact was last reviewed, so a consumer can judge its freshness.
- **No information leakage.** The public baseline describes the platform. A
  tenant-specific view — which can reveal that tenant's own sub-processors — is
  available only to that tenant's authenticated administrators and never reveals
  one tenant's information to another.

The surface is structured against a published schema, so consumers can validate
it. A tenant-scoped view layers each tenant's specific facts (its pinned region,
its identity provider, its residency configuration) over the platform baseline.

## Article-level mapping

The compliance surface maps each relevant obligation to a concrete part of the
system — access and portability to the export endpoint, erasure to the deletion
cascade, records of processing to the audit log, security of processing to the
encryption and access controls in [Security architecture](security-architecture.md),
and international transfers to region-pinned residency. The mapping is part of the
published surface so it can be reviewed against the running system.

See also [Tenant isolation](tenant-isolation.md) for the technical controls that
keep one tenant's data separated from another's.
