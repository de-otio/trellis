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
