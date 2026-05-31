# Agent-Friendly Compliance Discovery

How an IT engineer can hand a compliance review to their AI agent and get an answer without reading through legal pages, support ticketing, or guesswork.

## The persona scenario

> _"Does Trellis fulfill the compliance requirements of the company?"_
> — IT engineer @ a customer org, talking to Claude Code

This is the question that gets vendors green-lit or rejected. Internal IT, legal, and DPO need answers like:

- "Is data residency in the EU guaranteed?"
- "Are sub-processors disclosed?"
- "Can we get a DPA?"
- "What's the breach-notification window?"
- "Is GDPR Art. 17 (right to erasure) actually implemented?"
- "Does Trellis have SOC 2? ISO 27001?"
- "What encryption is used at rest? In transit?"
- "Can EU employees be excluded from US data flows?"

These questions are asked by the agent on the engineer's behalf. The agent's job is to **collect verifiable answers from Trellis's machine-readable compliance surface**, compare them against the company's requirements (which the agent loaded from the company's compliance policy doc), and report gaps with citations.

This doc designs the surface that makes that possible.

## Design principles

Inherits from [10-agent-friendly-onboarding.md §design-principles](./10-agent-friendly-onboarding.md#design-principles-for-agent-friendliness) and adds:

| # | Principle | What it means | Concrete consequence |
|---|---|---|---|
| C1 | **Single source of truth** | The agent gets every compliance fact from one canonical endpoint. No scraping the marketing site. | `/.well-known/compliance.json` and `/.well-known/compliance.md` (markdown for human, JSON for agent). |
| C2 | **Verifiable, not aspirational** | Each claim is either a fact (we do X), a documented control (we have a policy), or a certification (we have an audit). Marketing language is forbidden in this surface. | Every entry has a `status: implemented \| planned \| not_applicable` and a `verification` link. |
| C3 | **Versioned and timestamped** | Compliance posture changes. Agents need to know when a fact was last reviewed. | Each entry has `lastVerifiedAt`. The bundle has a top-level `version` and `publishedAt`. |
| C4 | **Per-tenant overrides** | Some facts are tenant-specific (e.g. region). | `/api/tenants/{id}/compliance.json` returns the tenant-applicable subset (region, sub-processors actually in use, etc.). |
| C5 | **Linkable evidence** | Where a third-party artifact is the proof, link to it. | DPA template URL, SOC 2 report download (when it exists), pen-test summary, sub-processor list URL. |
| C6 | **No information leakage by design** | A tenant's compliance profile reveals their sub-processors (their IdP); a *prospective* customer's discovery shouldn't reveal existing customers. | The unauthenticated `/.well-known/compliance.json` is the platform baseline; `/api/tenants/{id}/compliance.json` requires tenant-admin auth. |

## The compliance surface

Three layers, each addressable by an agent.

### Layer 1: platform baseline — public, unauthenticated

`https://example.com/.well-known/compliance.json` and `compliance.md`.

Schema (see [JSON Schema](#json-schema) below):

```json
{
  "version": "1.0.0",
  "publishedAt": "2026-05-02T12:00:00Z",
  "vendor": {
    "name": "Trellis",
    "operator": "de otio GmbH",
    "registeredAddress": "...",
    "websitePrivacyPolicy": "https://example.com/legal/privacy",
    "websiteTermsOfService": "https://example.com/legal/terms",
    "dpaTemplateUrl": "https://example.com/legal/dpa",
    "subprocessorListUrl": "https://example.com/legal/subprocessors",
    "privacyContact": "privacy@example.com",
    "securityContact": "security@example.com"
  },
  "regulatoryFrameworks": [
    {
      "name": "GDPR",
      "scope": "EU/EEA users and customers",
      "status": "implemented",
      "controls": [
        { "id": "art-15-right-of-access", "status": "implemented", "verification": "API: GET /api/users/me/export" },
        { "id": "art-17-right-to-erasure", "status": "partial", "notes": "Soft-delete + Cognito disable in MVP; full cascade Phase 3.", "verification": "API: DELETE /api/users/me" },
        { "id": "art-20-data-portability", "status": "implemented", "verification": "API: GET /api/users/me/export?format=json" },
        { "id": "art-28-processor-obligations", "status": "implemented", "verification": "DPA template at https://example.com/legal/dpa" },
        { "id": "art-30-records-of-processing", "status": "implemented", "notes": "Audit log + structured event emission per tenant.", "verification": "API: GET /api/tenants/{id}/audit" },
        { "id": "art-32-security-of-processing", "status": "implemented", "verification": "doc/02-technical/architecture/09-security.md" },
        { "id": "art-33-breach-notification", "status": "policy", "notes": "72-hour runbook in place; tested annually.", "verification": "https://example.com/legal/breach-policy" },
        { "id": "art-44-international-transfers", "status": "implemented", "notes": "Region-pinned tenants; AWS SCCs cover sub-processor transfers.", "verification": "https://example.com/legal/transfers" }
      ]
    },
    {
      "name": "CCPA",
      "scope": "California residents",
      "status": "policy",
      "notes": "Privacy policy includes 'Do Not Sell or Share' notice; right-to-know and right-to-delete handled via the same endpoints as GDPR Art. 15 and 17."
    },
    {
      "name": "SOC 2 Type II",
      "scope": "Service Organization Controls audit",
      "status": "not_yet_certified",
      "notes": "On roadmap for first enterprise customer demand."
    },
    {
      "name": "ISO 27001",
      "scope": "Information Security Management System",
      "status": "not_yet_certified",
      "notes": "On roadmap; not currently a customer requirement."
    }
  ],
  "dataResidency": {
    "supportedRegions": [
      { "code": "EU", "awsRegion": "eu-central-1", "default": true },
      { "code": "US", "awsRegion": "us-east-1", "default": false, "status": "phase-2" }
    ],
    "guarantee": "A tenant pinned to a region has all of its data (Postgres rows, S3 objects, Cognito users, DynamoDB items, Neo4j data) stored in that region. Cross-region transfers occur only for AWS-internal replication (when enabled), governed by AWS SCCs.",
    "verification": "doc/02-technical/architecture/identity-federation/07-security-and-isolation.md#gdpr-alignment"
  },
  "encryption": {
    "atRest": [
      { "what": "RDS PostgreSQL", "method": "AES-256 (AWS-managed KMS key)" },
      { "what": "S3 objects (media)", "method": "AES-256 (SSE-KMS, AWS-managed key)" },
      { "what": "DynamoDB", "method": "AES-256 (AWS-managed KMS key)" },
      { "what": "Secrets Manager (IdP secrets)", "method": "AES-256 (AWS-managed KMS key)" },
      { "what": "Neo4j AuraDB", "method": "AES-256 (Neo4j-managed)" }
    ],
    "inTransit": [
      { "what": "Public endpoints", "method": "TLS 1.2 minimum, TLS 1.3 preferred (ACM certs)" },
      { "what": "RDS connections", "method": "TLS within VPC" },
      { "what": "Inter-service (ECS ↔ Cognito ↔ Lambda)", "method": "TLS" },
      { "what": "AuraDB (Bolt protocol)", "method": "TLS" }
    ],
    "byok": { "status": "not_supported_in_mvp", "phaseAvailable": "Phase 3+ (enterprise)" }
  },
  "subprocessors": {
    "platform": [
      { "name": "Amazon Web Services", "purpose": "Cloud infrastructure", "regions": ["eu-central-1"], "url": "https://aws.amazon.com" },
      { "name": "Neo4j Aura", "purpose": "Managed graph database", "regions": ["eu-central-1"], "url": "https://neo4j.com/cloud/aura/" },
      { "name": "OpenAI", "purpose": "Image moderation API", "url": "https://openai.com/policies/", "scope": "image content only; no user PII passed" },
      { "name": "Microsoft (per tenant via federation)", "purpose": "Optional: Identity Provider for tenants who choose it", "url": "https://learn.microsoft.com/entra", "scope": "claims only; never passes Trellis data to Microsoft" }
    ],
    "tenantSpecific": "See /api/tenants/{id}/compliance.json#subprocessors for the IdP and any other tenant-elected sub-processors."
  },
  "audit": {
    "platform": {
      "available": true,
      "format": "JSON / CSV export",
      "retentionDays": 30,
      "longerRetentionAvailable": "Phase 2 (request via support)"
    },
    "tenant": {
      "available": true,
      "endpoint": "GET /api/tenants/{id}/audit",
      "scope": "Tenant admins see all admin actions in their tenant"
    }
  },
  "incidentResponse": {
    "breachNotificationWindowHours": 72,
    "communicationChannel": "Email to all tenant admins + status page banner",
    "statusPage": "https://status.example.com",
    "securityContact": "security@example.com (PGP key at /security.txt)"
  },
  "deletionAndPortability": {
    "rightToErasure": {
      "endpoint": "DELETE /api/users/me",
      "behavior": "MVP: soft-delete + Cognito disable + grace period 7 days, then hard delete. Full tenant cascade Phase 3.",
      "completionTargetDays": 30
    },
    "dataPortability": {
      "endpoint": "GET /api/users/me/export",
      "format": "JSON (structured, schema versioned)"
    },
    "tenantOffboarding": {
      "available": true,
      "endpoint": "POST /api/tenants/{id}/request-deletion (Phase 3)",
      "interimGuidance": "MVP: tenant admin disconnects IdP and contacts support; deletion is operator-driven during MVP."
    }
  }
}
```

### Layer 2: tenant-scoped — auth required

`https://api.example.com/api/tenants/{id}/compliance.json`

Returns the platform baseline, **filtered** to what's tenant-relevant, plus tenant-specific facts:

- Tenant's pinned region.
- The tenant's specific sub-processors in use (their IdP — name, type, region, contact).
- The tenant's audit-log retention setting (when configurable).
- The tenant's data residency configuration.
- The tenant's incident-response contact list (they configure who hears about a breach).
- A pre-filled DPA URL (`https://app.example.com/legal/dpa?tenant=...`) with the tenant as the controller.

Same JSON schema; subset + override semantics.

### Layer 3: question-and-answer endpoint (Phase 2)

For complex questions an agent might ask in natural language, a `POST /api/compliance/query` endpoint backed by retrieval over the JSON facts above. Out of MVP scope; Phase 2 for "smooth enterprise compliance review."

## Sample agent transcript

```
Human: We're evaluating Trellis. Does it fulfill our compliance requirements?

Agent: I'll check Trellis's compliance posture against your company's
requirements. Let me find both first.

[tool: read_local_file ./compliance/policy.md]
  → company requires: GDPR-compliant, EU data residency, sub-processor
    list, DPA, encryption at rest + transit, breach notification ≤72h,
    right-to-erasure within 30 days, audit log on demand. Nice-to-have:
    SOC 2 Type II.

[tool: web_fetch https://example.com/.well-known/compliance.json]

Comparing to your policy requirements:

| Your requirement | Trellis posture | Status |
|---|---|---|
| GDPR compliant | All Art. 5–34 controls implemented or policy-backed | ✅ Met |
| EU data residency | Default region eu-central-1; tenant-pinned | ✅ Met |
| Sub-processor list disclosed | List published; tenant-specific overrides exposed | ✅ Met |
| DPA available | Self-serve template at https://example.com/legal/dpa | ✅ Met |
| Encryption at rest | AES-256 across all stores (RDS, S3, DynamoDB, Secrets Manager, Neo4j) | ✅ Met |
| Encryption in transit | TLS 1.2+ (1.3 preferred) | ✅ Met |
| Breach notification ≤72h | Documented 72h window; runbook in place | ✅ Met |
| Right-to-erasure within 30 days | DELETE /api/users/me; 30-day completion target | ⚠️ MVP is partial — full tenant cascade is Phase 3. User-level deletion works fully today. |
| Audit log on demand | GET /api/tenants/{id}/audit; CSV/JSON export | ✅ Met |
| SOC 2 Type II (nice-to-have) | Not yet certified; on roadmap | ❌ Gap (acceptable per your "nice-to-have" tag) |

Summary:
  - 9 of 10 requirements fully met.
  - 1 partial: tenant-cascade deletion (the platform supports user-level
    erasure today; org-tenant cascade-delete is Phase 3 per their roadmap).
  - 1 gap: SOC 2 Type II not yet certified — flagged as nice-to-have
    in your policy, so not a blocker.

Recommendation: Trellis meets your hard requirements. The SOC 2 gap is
worth flagging during procurement as a future-state ask. Documentation
trail is at https://example.com/.well-known/compliance.json (versioned).

Want me to also check our region requirements? Or pull the DPA for review?
```

The transcript demonstrates: 1 local file read + 1 HTTP fetch produced a complete answer. No human compliance reviewer needed for the first pass.

## Why this matters commercially

A typical enterprise procurement loop with a vendor:

1. Customer's IT/legal sends a 200-question security questionnaire.
2. Vendor's solutions engineer fills it out (4 hours).
3. Customer's reviewer reads it, asks 30 follow-ups (2 hours).
4. Round-trip until both sides converge (1–3 weeks).

With agent-friendly compliance:

1. Customer's agent fetches `compliance.json`.
2. Agent answers 80% of the questionnaire from facts.
3. Human reviewer checks the agent's findings (15 minutes).
4. Optional follow-ups for the remaining 20%.

Trellis-side cost: writing the JSON once and keeping it current. Customer-side cost: drops by an order of magnitude. **This shifts compliance from a sales blocker to a sales accelerator.**

Per [README §P2](./README.md#p2-it-friendly-onboarding-for-the-influential-customers): IT influence flips from "this vendor wasted my afternoon" to "this vendor made my job easier."

## MVP deliverables

The compliance surface is light by design — most facts already exist in code/docs; we just need to expose them.

- [ ] **Static `compliance.json`** at `https://example.com/.well-known/compliance.json` and `https://api.example.com/.well-known/compliance.json` (same content, both URLs). Initial JSON committed to the repo, served by the static-site stack. Versioned in source control.
- [ ] **`compliance.md`** — human-readable rendering of the same facts. Same `/.well-known/` path. Generated from the JSON via a build step or hand-maintained alongside (acceptable since the file is small and changes infrequently).
- [ ] **`/security.txt`** at root per [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) with security contact + PGP key.
- [ ] **`subprocessors.json`** at `https://example.com/legal/subprocessors.json` mirroring the structured list in `compliance.json` for direct linkability.
- [ ] **DPA template** at `https://example.com/legal/dpa` — markdown, downloadable, fillable. Lawyer review before publishing.
- [ ] **Tenant compliance endpoint:** `GET /api/tenants/{id}/compliance.json` (auth: tenant admin or API token) returning baseline + tenant-specific overrides.
- [ ] **JSON Schema** for the bundle, published at `https://example.com/.well-known/compliance.schema.json`. So agents (and future tooling) can validate.
- [ ] **Linked from `/llms.txt`** so an agent finds it automatically.

## Phase 2 deliverables

- **Trellis DPA self-serve** — admin clicks "Generate DPA," gets a pre-filled PDF with their tenant info, downloads. Phase 2.
- **`POST /api/compliance/query`** — agent-facing question-answer endpoint backed by retrieval over the JSON facts. Phase 2 if customer agents need it.
- **Compliance attestations dashboard** — Flutter UI for tenant admins showing the same data graphically. Phase 2 (the JSON surface is sufficient for agents in MVP).
- **Annual review cadence** — every 12 months, run an internal audit pass to refresh `lastVerifiedAt` timestamps. First review: 12 months after MVP launch.
- **SOC 2 Type II** — pursue when first enterprise customer demands it. Updates `compliance.json` accordingly.
- **ISO 27001** — same trigger.

## JSON Schema

The bundle is small and stable; we maintain a JSON Schema for it so consumers (agents and other tools) can validate.

```jsonc
// /.well-known/compliance.schema.json (sketch — full schema MVP-deliverable)
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["version", "publishedAt", "vendor", "regulatoryFrameworks", "dataResidency", "encryption", "subprocessors", "audit", "incidentResponse", "deletionAndPortability"],
  "properties": {
    "version":     { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    "publishedAt": { "type": "string", "format": "date-time" },
    "vendor":      { "$ref": "#/$defs/vendor" },
    "regulatoryFrameworks": { "type": "array", "items": { "$ref": "#/$defs/framework" } },
    "dataResidency": { "$ref": "#/$defs/residency" },
    "encryption":   { "$ref": "#/$defs/encryption" },
    "subprocessors":{ "$ref": "#/$defs/subprocessors" },
    "audit":        { "$ref": "#/$defs/audit" },
    "incidentResponse": { "$ref": "#/$defs/incident" },
    "deletionAndPortability": { "$ref": "#/$defs/deletion" }
  },
  "$defs": { /* ... */ }
}
```

The schema is itself versioned (the `version` field above is the *content* version; the schema version is in the URL path or a separate field if we ever change shapes).

## Risks and anti-patterns

| Risk | Mitigation |
|---|---|
| `compliance.json` claims something we don't actually do | Every claim has a `verification` link to running code, a runbook, or an audited artifact. Reviewers can spot-check. CI lint flags claims without `verification`. |
| Document drifts from reality (we add a sub-processor, forget to update) | Adding a sub-processor is a deliberate change that touches CDK + this JSON. Code-review checklist enforces. Phase 2: emit a CI warning when CDK adds a service whose name isn't in the JSON. |
| Customer agents misread "policy" status as "implemented" | Schema enforces `status: implemented \| policy \| partial \| not_yet_certified \| planned \| not_supported`; agents are instructed (via the bundle's docstring) to treat anything other than `implemented` as a partial. |
| Marketing language sneaks in | This file is read by adversarial reviewers. CI lint forbids words from a deny-list (`world-class`, `enterprise-grade`, `bank-level`, `military-grade`, etc.). Stick to facts. |
| Sensitive infra detail leaks (e.g. exact RDS instance class) | Deliberately omitted. The bundle says "AES-256 at rest" not "RDS m7g.large in eu-central-1a, primary at i-..." Schema review catches over-specification. |
| Tenant-specific bundle leaks cross-tenant info | `/api/tenants/{id}/compliance.json` is auth-gated; only returns the requested tenant's data. Tested in cross-tenant isolation suite. |
| Out-of-date `lastVerifiedAt` makes the bundle look stale | Annual review cadence; CI warns when any `lastVerifiedAt` is older than 18 months. |

## Definition of done — agent-friendly compliance MVP

- [ ] `compliance.json` published at `/.well-known/compliance.json`, all required fields populated.
- [ ] `compliance.md` published, kept in sync via build step or commit discipline.
- [ ] JSON Schema published, `compliance.json` validates against it.
- [ ] `subprocessors.json` published.
- [ ] `/security.txt` published.
- [ ] DPA template at `/legal/dpa`, lawyer-reviewed.
- [ ] `GET /api/tenants/{id}/compliance.json` returns tenant-specific bundle.
- [ ] `/llms.txt` links to all of the above.
- [ ] Test fixture: an agent transcript demonstrating the canonical flow ("does Trellis meet our requirements?").
- [ ] CI lint forbids unverified claims and marketing language in `compliance.json`.

## Cross-references

- [10-agent-friendly-onboarding.md](./10-agent-friendly-onboarding.md) — sibling capability for setup
- [07-security-and-isolation.md §gdpr-alignment](./07-security-and-isolation.md#gdpr-alignment) — the source of truth for the GDPR fact set surfaced here
- [README §P3](./README.md#p3-compliance-is-a-first-class-design-constraint-not-an-afterthought) — the principle this design serves
