/**
 * Tenant compliance merge.
 *
 * Pure function: takes the platform baseline and tenant-specific facts,
 * returns a merged ComplianceDoc with tenant overrides applied.
 *
 * Tenant overrides:
 *  - dataResidency.activeRegion  — from tenant's dataRegion field (or "EU" default)
 *  - subprocessors.identityProvider — from the tenant's TenantIdentityProvider row
 *  - dataMinimization.tenantSpecific.activeIntegrations — list of IdP integrations
 *  - lastVerifiedAt on overridden fields — set to the merge timestamp
 *
 * Design reference:
 *   doc/02-technical/identity-federation/11-agent-friendly-compliance.md §"Layer 2"
 */

import type { ComplianceDoc, IdentityProviderSubprocessor, DataMinimizationIntegration } from "./types.js";

export interface TenantComplianceInput {
  /** ISO region code, e.g. "EU" or "US". Defaults to "EU" when absent. */
  region: string | null | undefined;
}

export interface IdpComplianceInput {
  kind: string;
  issuerUrl: string | null | undefined;
}

/**
 * Merge tenant-specific facts into the platform baseline.
 *
 * @param baseline  The immutable platform baseline (from baseline.ts).
 * @param tenant    Tenant row data needed for compliance fields.
 * @param idp       The tenant's TenantIdentityProvider row, or null if none.
 * @param mergedAt  ISO-8601 timestamp of the merge (injected for testability).
 * @returns         A new ComplianceDoc with tenant overrides applied.
 */
export function mergeTenantOverrides(
  baseline: ComplianceDoc,
  tenant: TenantComplianceInput,
  idp: IdpComplianceInput | null,
  mergedAt: string = new Date().toISOString(),
): ComplianceDoc {
  const activeRegion = tenant.region ?? "EU";

  // Build the merged dataResidency section.
  const dataResidency = {
    ...baseline.dataResidency,
    activeRegion,
    lastVerifiedAt: mergedAt,
  };

  // Build the merged subprocessors section.
  const subprocessors = { ...baseline.subprocessors };
  // Remove the tenantSpecific notice since we're now in the tenant scope.
  delete subprocessors.tenantSpecific;

  if (idp && idp.issuerUrl) {
    const idpSubprocessor: IdentityProviderSubprocessor = {
      kind: idp.kind,
      issuerUrl: idp.issuerUrl,
      name: idpNameForKind(idp.kind),
      lastVerifiedAt: mergedAt,
    };
    subprocessors.identityProvider = idpSubprocessor;
  }

  // Build the dataMinimization section listing active integrations.
  const activeIntegrations: DataMinimizationIntegration[] = [];
  if (idp && idp.issuerUrl) {
    activeIntegrations.push({
      type: idp.kind,
      issuerUrl: idp.issuerUrl,
    });
  }

  const dataMinimization = {
    tenantSpecific: {
      activeIntegrations,
      lastVerifiedAt: mergedAt,
    },
  };

  return {
    ...baseline,
    dataResidency,
    subprocessors,
    dataMinimization,
  };
}

function idpNameForKind(kind: string): string {
  switch (kind.toUpperCase()) {
    case "OIDC":
      return "OIDC Identity Provider";
    case "SAML":
      return "SAML Identity Provider";
    default:
      return "Identity Provider";
  }
}
