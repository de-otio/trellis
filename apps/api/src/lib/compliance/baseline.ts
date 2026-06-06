/**
 * Platform compliance baseline.
 *
 * This is a trellis-side copy of the platform baseline that would be served
 * from the static site (S6). It exists here so the API can merge tenant-specific
 * overrides without an external HTTP call.
 *
 * Source: doc/02-technical/identity-federation/11-agent-friendly-compliance.md
 * §"Layer 1: platform baseline"
 *
 * Keep in sync with changes to the published example.com/.well-known/compliance.json.
 */

import type { ComplianceDoc } from "./types.js";

export const BASELINE_COMPLIANCE: ComplianceDoc = {
  version: "1.0.0",
  publishedAt: "2026-05-02T12:00:00Z",
  vendor: {
    name: "Trellis",
    operator: "de otio GmbH",
    registeredAddress: "Germany",
    websitePrivacyPolicy: "https://example.com/legal/privacy",
    websiteTermsOfService: "https://example.com/legal/terms",
    dpaTemplateUrl: "https://example.com/legal/dpa",
    subprocessorListUrl: "https://example.com/legal/subprocessors",
    privacyContact: "privacy@example.com",
    securityContact: "security@example.com",
  },
  regulatoryFrameworks: [
    {
      name: "GDPR",
      scope: "EU/EEA users and customers",
      status: "implemented",
      controls: [
        {
          id: "art-15-right-of-access",
          status: "implemented",
          verification: "API: GET /api/users/me/export",
        },
        {
          id: "art-17-right-to-erasure",
          status: "partial",
          notes:
            "Soft-delete + Cognito disable in MVP; full cascade Phase 3.",
          verification: "API: DELETE /api/users/me",
        },
        {
          id: "art-20-data-portability",
          status: "implemented",
          verification: "API: GET /api/users/me/export?format=json",
        },
        {
          id: "art-28-processor-obligations",
          status: "implemented",
          verification: "DPA template at https://example.com/legal/dpa",
        },
        {
          id: "art-30-records-of-processing",
          status: "implemented",
          notes: "Audit log + structured event emission per tenant.",
          verification: "API: GET /api/tenants/{id}/audit",
        },
        {
          id: "art-32-security-of-processing",
          status: "implemented",
          verification: "doc/02-technical/architecture/09-security.md",
        },
        {
          id: "art-33-breach-notification",
          status: "policy",
          notes: "72-hour runbook in place; tested annually.",
          verification: "https://example.com/legal/breach-policy",
        },
        {
          id: "art-44-international-transfers",
          status: "implemented",
          notes:
            "Region-pinned tenants; AWS SCCs cover sub-processor transfers.",
          verification: "https://example.com/legal/transfers",
        },
      ],
    },
    {
      name: "CCPA",
      scope: "California residents",
      status: "policy",
      notes:
        "Privacy policy includes 'Do Not Sell or Share' notice; right-to-know and right-to-delete handled via the same endpoints as GDPR Art. 15 and 17.",
    },
    {
      name: "SOC 2 Type II",
      scope: "Service Organization Controls audit",
      status: "not_yet_certified",
      notes: "On roadmap for first enterprise customer demand.",
    },
    {
      name: "ISO 27001",
      scope: "Information Security Management System",
      status: "not_yet_certified",
      notes: "On roadmap; not currently a customer requirement.",
    },
  ],
  dataResidency: {
    supportedRegions: [
      { code: "EU", awsRegion: "eu-central-1", default: true },
      { code: "US", awsRegion: "us-east-1", default: false, status: "phase-2" },
    ],
    guarantee:
      "A tenant pinned to a region has all of its data (Postgres rows, S3 objects, Cognito users, DynamoDB items) stored in that region. Cross-region transfers occur only for AWS-internal replication (when enabled), governed by AWS SCCs.",
    verification:
      "doc/02-technical/architecture/identity-federation/07-security-and-isolation.md#gdpr-alignment",
  },
  encryption: {
    atRest: [
      { what: "RDS PostgreSQL", method: "AES-256 (AWS-managed KMS key)" },
      {
        what: "S3 objects (media)",
        method: "AES-256 (SSE-KMS, AWS-managed key)",
      },
      { what: "DynamoDB", method: "AES-256 (AWS-managed KMS key)" },
      {
        what: "Secrets Manager (IdP secrets)",
        method: "AES-256 (AWS-managed KMS key)",
      },
    ],
    inTransit: [
      {
        what: "Public endpoints",
        method: "TLS 1.2 minimum, TLS 1.3 preferred (ACM certs)",
      },
      { what: "RDS connections", method: "TLS within VPC" },
      {
        what: "Inter-service (ECS ↔ Cognito ↔ Lambda)",
        method: "TLS",
      },
    ],
    byok: {
      status: "not_supported_in_mvp",
      phaseAvailable: "Phase 3+ (enterprise)",
    },
  },
  subprocessors: {
    platform: [
      {
        name: "Amazon Web Services",
        purpose: "Cloud infrastructure",
        regions: ["eu-central-1"],
        url: "https://aws.amazon.com",
      },
      {
        name: "OpenAI",
        purpose: "Image moderation API",
        url: "https://openai.com/policies/",
        scope: "image content only; no user PII passed",
      },
      {
        name: "Microsoft (per tenant via federation)",
        purpose:
          "Optional: Identity Provider for tenants who choose it",
        url: "https://learn.microsoft.com/entra",
        scope:
          "claims only; never passes Trellis data to Microsoft",
      },
    ],
    tenantSpecific:
      "See /api/tenants/{id}/compliance.json#subprocessors for the IdP and any other tenant-elected sub-processors.",
  },
  audit: {
    platform: {
      available: true,
      format: "JSON / CSV export",
      retentionDays: 30,
      longerRetentionAvailable: "Phase 2 (request via support)",
    },
    tenant: {
      available: true,
      endpoint: "GET /api/tenants/{id}/audit",
      scope: "Tenant admins see all admin actions in their tenant",
    },
  },
  incidentResponse: {
    breachNotificationWindowHours: 72,
    communicationChannel: "Email to all tenant admins + status page banner",
    statusPage: "https://status.example.com",
    securityContact: "security@example.com (PGP key at /security.txt)",
  },
  deletionAndPortability: {
    rightToErasure: {
      endpoint: "DELETE /api/users/me",
      behavior:
        "MVP: soft-delete + Cognito disable + grace period 7 days, then hard delete. Full tenant cascade Phase 3.",
      completionTargetDays: 30,
    },
    dataPortability: {
      endpoint: "GET /api/users/me/export",
      format: "JSON (structured, schema versioned)",
    },
    tenantOffboarding: {
      available: true,
      endpoint: "POST /api/tenants/{id}/request-deletion (Phase 3)",
      interimGuidance:
        "MVP: tenant admin disconnects IdP and contacts support; deletion is operator-driven during MVP.",
    },
  },
};
