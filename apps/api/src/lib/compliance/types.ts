/**
 * Compliance document types.
 *
 * Schema reference: https://example.com/.well-known/compliance.schema.json
 * Design reference: doc/02-technical/identity-federation/11-agent-friendly-compliance.md
 */

export interface ComplianceControl {
  id: string;
  status: "implemented" | "partial" | "policy" | "not_applicable";
  notes?: string;
  verification?: string;
  lastVerifiedAt?: string;
}

export interface RegulatoryFramework {
  name: string;
  scope: string;
  status: "implemented" | "policy" | "not_yet_certified";
  notes?: string;
  controls?: ComplianceControl[];
}

export interface RegionEntry {
  code: string;
  awsRegion: string;
  default: boolean;
  status?: string;
}

export interface DataResidency {
  supportedRegions: RegionEntry[];
  activeRegion?: string;
  guarantee: string;
  verification: string;
  lastVerifiedAt?: string;
}

export interface EncryptionEntry {
  what: string;
  method: string;
}

export interface Encryption {
  atRest: EncryptionEntry[];
  inTransit: EncryptionEntry[];
  byok: { status: string; phaseAvailable?: string };
}

export interface Subprocessor {
  name: string;
  purpose: string;
  regions?: string[];
  url: string;
  scope?: string;
}

export interface IdentityProviderSubprocessor {
  kind: string;
  issuerUrl: string;
  name: string;
  lastVerifiedAt?: string;
}

export interface Subprocessors {
  platform: Subprocessor[];
  identityProvider?: IdentityProviderSubprocessor;
  tenantSpecific?: string;
}

export interface DataMinimizationIntegration {
  type: string;
  issuerUrl?: string;
}

export interface DataMinimization {
  tenantSpecific?: {
    activeIntegrations: DataMinimizationIntegration[];
    lastVerifiedAt?: string;
  };
}

export interface AuditPlatform {
  available: boolean;
  format: string;
  retentionDays: number;
  longerRetentionAvailable?: string;
}

export interface AuditTenant {
  available: boolean;
  endpoint: string;
  scope: string;
}

export interface Audit {
  platform: AuditPlatform;
  tenant: AuditTenant;
}

export interface IncidentResponse {
  breachNotificationWindowHours: number;
  communicationChannel: string;
  statusPage: string;
  securityContact: string;
}

export interface VendorInfo {
  name: string;
  operator: string;
  registeredAddress: string;
  websitePrivacyPolicy: string;
  websiteTermsOfService: string;
  dpaTemplateUrl: string;
  subprocessorListUrl: string;
  privacyContact: string;
  securityContact: string;
}

export interface DeletionAndPortability {
  rightToErasure: {
    endpoint: string;
    behavior: string;
    completionTargetDays: number;
  };
  dataPortability: {
    endpoint: string;
    format: string;
  };
  tenantOffboarding: {
    available: boolean;
    endpoint: string;
    interimGuidance?: string;
  };
}

export interface ComplianceDoc {
  version: string;
  publishedAt: string;
  vendor: VendorInfo;
  regulatoryFrameworks: RegulatoryFramework[];
  dataResidency: DataResidency;
  encryption: Encryption;
  subprocessors: Subprocessors;
  dataMinimization?: DataMinimization;
  audit: Audit;
  incidentResponse: IncidentResponse;
  deletionAndPortability: DeletionAndPortability;
}
