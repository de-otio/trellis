# Data Minimization & Data Residency

Anything stored is subpoena-able and breachable into exactly the fusion
platforms described in [01 §4](./01-threat-landscape.md#4-legal-compulsion).

## 1. Client-metadata storage paths — verified, plus a rule

> **Correction (2026-06-04):** an earlier revision of this document claimed
> `media-handler.ts` persists raw IP + User-Agent with media metadata. On
> verification, that is wrong: media-handler reads the headers only to pass
> them to `TrellisAuditLogger` (`apps/api/src/lib/audit-composer.ts`), which
> applies the PII filter (`apps/api/src/lib/audit/pii-filter.ts` —
> `anonymizeIp`) and tiered retention. `MediaFile` has no IP/UA fields.

Verified state of client-metadata (IP / User-Agent) storage:

| Path | Anonymization | Retention | Status |
|---|---|---|---|
| Audit events (`audit-composer.ts`) | PII allowlist + `anonymizeIp` | 30/90/365d tiered, locked | ✅ |
| Media operations (`media-handler.ts`) | via audit path only; nothing on `MediaFile` | n/a | ✅ |
| `SecurityEvent` (raw IP/UA for security forensics, `prisma/schema.prisma`) | raw (deliberate — forensics) | `retentionUntil` + hourly cron cleanup (`apps/api/src/lib/security-event-cleaner.ts`, `apps/api/src/lambda/hourly-cron.ts`) | ✅ bounded |
| `Consent` (IP at consent time) | raw (deliberate — legal evidence) | tied to consent lifecycle | ✅ justified |

The rule worth writing down (and enforcing in review):

> **Client metadata (IP/UA/device identifiers) is stored only through a path
> that enforces either anonymization or an explicit retention bound.** New
> storage of raw client metadata alongside domain data — where it accumulates
> indefinitely and silently — is a review blocker. When abuse forensics needs
> client signals (see [06-registration-friction.md](./06-registration-friction.md)),
> capture them with an explicit retention field, SecurityEvent-style.

This extends the data-minimization stance already present in the
identity-federation design (store only the claims used; log claim names,
never values) from the identity layer to all client metadata.

## 2. Tenant-level data residency

Storage jurisdiction determines which states can compel data into their
"lawful" fusion platforms. Trellis already has region-aware tenant placement
on the long-term roadmap (data localisation for the China expansion; the
identity-federation design's compliance principles include cross-border
placement), and the `Tenant` model already carries a `region` field.

This threat model adds a second, independent justification: residency is not
only a compliance feature (GDPR cross-border rules) but a **protective
control for users** — a tenant serving an at-risk community can choose a
storage jurisdiction whose compulsion regime its users can live with.

No new work item beyond reaffirming the existing roadmap entry; the point is
that the justification is double, so the priority should reflect both
drivers.
