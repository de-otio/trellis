/**
 * Setup-status: machine-friendly tenant onboarding progress.
 *
 * `computeSetupStatus` is a pure function — it does no I/O and can be tested
 * without a database.  `loadSetupStatus` performs the Prisma query and calls
 * `computeSetupStatus` with the results.
 */

import type { Env } from "../../env.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type TenantStatusValue = "ok" | "created" | "missing";

export interface SetupTenantSection {
  status: TenantStatusValue;
  tenantId: string;
}

export type DomainStatus = "verified" | "pending" | "failed";

export interface SetupDomain {
  domain: string;
  verifiedAt: string | null;
  status: DomainStatus;
}

export type IdpStatus = "ACTIVE" | "PENDING" | "DISABLED";

export interface SetupIdp {
  kind: string;
  status: IdpStatus;
  issuerUrl: string | null;
}

export interface SetupRoleMapping {
  id: string;
  externalGroup: string;
  tenantRole: string;
}

export type NextStepCode =
  | "DOMAIN_REQUIRED"
  | "DOMAIN_VERIFICATION_PENDING"
  | "IDP_REQUIRED"
  | "ROLE_MAPPING_REQUIRED"
  | "TEST_SIGN_IN"
  | "COMPLETE";

export interface NextStep {
  code: NextStepCode;
  message: string;
  endpoint: string;
  remediation: string;
}

export interface SetupStatus {
  tenant: SetupTenantSection;
  domains: SetupDomain[];
  idp: SetupIdp | null;
  roleMappings: SetupRoleMapping[];
  nextStep: NextStep;
}

// ── Input shapes (fed from Prisma results) ─────────────────────────────────

export interface SetupStatusInputDomain {
  domain: string;
  verifiedAt: Date | null;
  failedAt?: Date | null;
}

export interface SetupStatusInputIdp {
  kind: string;
  status: string;
  issuerUrl: string | null;
}

export interface SetupStatusInputRoleMapping {
  id: string;
  externalGroup: string;
  tenantRole: string;
}

export interface SetupStatusInput {
  tenantId: string;
  tenantExists: boolean;
  /**
   * Has at least one successful SSO sign-in been recorded?
   * Trellis records the first successful federated sign-in so this flag
   * can flip `TEST_SIGN_IN` → `COMPLETE`.
   */
  hasTestSignIn: boolean;
  domains: SetupStatusInputDomain[];
  idp: SetupStatusInputIdp | null;
  roleMappings: SetupStatusInputRoleMapping[];
}

// ── Pure computation ────────────────────────────────────────────────────────

/**
 * Deterministically derive the setup-status object from snapshot data.
 * No side effects; safe to call in unit tests without any database.
 */
export function computeSetupStatus(input: SetupStatusInput): SetupStatus {
  const { tenantId, tenantExists, hasTestSignIn, domains, idp, roleMappings } = input;

  // ── tenant section ────────────────────────────────────────────────────────
  const tenantSection: SetupTenantSection = {
    status: tenantExists ? "ok" : "missing",
    tenantId,
  };

  // ── domains section ───────────────────────────────────────────────────────
  const domainItems: SetupDomain[] = domains.map((d) => ({
    domain: d.domain,
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
    status: d.verifiedAt ? "verified" : d.failedAt ? "failed" : "pending",
  }));

  // ── idp section ───────────────────────────────────────────────────────────
  const idpSection: SetupIdp | null = idp
    ? {
        kind: idp.kind,
        status: idp.status as IdpStatus,
        issuerUrl: idp.issuerUrl,
      }
    : null;

  // ── roleMappings section ──────────────────────────────────────────────────
  const roleMappingItems: SetupRoleMapping[] = roleMappings.map((r) => ({
    id: r.id,
    externalGroup: r.externalGroup,
    tenantRole: r.tenantRole,
  }));

  // ── nextStep computation ──────────────────────────────────────────────────
  const verifiedDomains = domainItems.filter((d) => d.status === "verified");
  const unverifiedDomains = domainItems.filter((d) => d.status !== "verified");
  const idpActive = idpSection !== null && idpSection.status === "ACTIVE";

  let nextStep: NextStep;

  if (domainItems.length === 0) {
    nextStep = {
      code: "DOMAIN_REQUIRED",
      message: "Add a domain to verify ownership before connecting an identity provider.",
      endpoint: `POST /api/tenants/${tenantId}/domains`,
      remediation: "Call POST /api/tenants/{id}/domains with { \"domain\": \"yourdomain.com\" } to claim your domain.",
    };
  } else if (verifiedDomains.length === 0 && unverifiedDomains.length > 0) {
    // Has domains claimed but none verified (includes pending and failed states).
    nextStep = {
      code: "DOMAIN_VERIFICATION_PENDING",
      message: "At least one domain is claimed but not yet verified. Add the DNS TXT record and verify.",
      endpoint: `POST /api/tenants/${tenantId}/domains/{domainId}/verify`,
      remediation: "Add the TXT record to your DNS provider then call POST /api/tenants/{id}/domains/{domainId}/verify.",
    };
  } else if (idpSection === null) {
    nextStep = {
      code: "IDP_REQUIRED",
      message: "No identity provider is connected. Connect an OIDC IdP to enable federated sign-in.",
      endpoint: `POST /api/tenants/${tenantId}/identity-provider`,
      remediation: "Call POST /api/tenants/{id}/identity-provider with { \"kind\": \"OIDC\", \"issuerUrl\": \"...\", ... }.",
    };
  } else if (!idpActive) {
    // IdP exists but is DISABLED or PENDING
    nextStep = {
      code: "IDP_REQUIRED",
      message: `Identity provider is not active (status: ${idpSection.status}). Enable it to allow federated sign-in.`,
      endpoint: `PATCH /api/tenants/${tenantId}/identity-provider`,
      remediation: "Call PATCH /api/tenants/{id}/identity-provider with { \"status\": \"ACTIVE\" }.",
    };
  } else if (roleMappingItems.length === 0) {
    nextStep = {
      code: "ROLE_MAPPING_REQUIRED",
      message: "No role mappings are configured. Add at least one mapping to assign roles to IdP groups.",
      endpoint: `POST /api/tenants/${tenantId}/role-mappings`,
      remediation: "Call POST /api/tenants/{id}/role-mappings with { \"externalGroup\": \"...\", \"tenantRole\": \"MEMBER\" }.",
    };
  } else if (!hasTestSignIn) {
    nextStep = {
      code: "TEST_SIGN_IN",
      message: "Setup looks complete. Perform a test federated sign-in to confirm the flow works end-to-end.",
      endpoint: `GET /api/auth/discover`,
      remediation: "Use a test account in your IdP to sign in via POST /api/auth/discover and verify the redirect flow.",
    };
  } else {
    nextStep = {
      code: "COMPLETE",
      message: "Tenant setup is complete. Federated sign-in is operational.",
      endpoint: `GET /api/tenants/${tenantId}/setup-status`,
      remediation: "No action required.",
    };
  }

  return {
    tenant: tenantSection,
    domains: domainItems,
    idp: idpSection,
    roleMappings: roleMappingItems,
    nextStep,
  };
}

// ── Loader (Prisma I/O) ─────────────────────────────────────────────────────

/**
 * Fetch all data needed to compute setup-status in a single read transaction,
 * then return the computed status object.
 */
export async function loadSetupStatus(
  tenantId: string,
  env: Env,
): Promise<SetupStatus | null> {
  const { createPrisma } = await import("../../db.js");
  const db = createPrisma(env);

  // Single transaction to get a consistent snapshot.
  const [tenant, domains, idpRow, roleMappings, testSignInEvent] = await db.$transaction([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    }),
    db.tenantDomain.findMany({
      where: { tenantId },
      select: { domain: true, verifiedAt: true },
      orderBy: { domain: "asc" },
    }),
    db.tenantIdentityProvider.findUnique({
      where: { tenantId },
      select: { kind: true, status: true, issuerUrl: true },
    }),
    db.tenantRoleMapping.findMany({
      where: { tenantId },
      select: { id: true, idpGroupName: true, tenantRole: true },
      orderBy: { idpGroupName: "asc" },
    }),
    db.securityEvent.findFirst({
      where: {
        tenantId,
        type: "tenant.federated_login.success",
      },
      select: { id: true },
    }),
  ]);

  if (!tenant) return null;

  return computeSetupStatus({
    tenantId,
    tenantExists: true,
    hasTestSignIn: Boolean(testSignInEvent),
    domains,
    idp: idpRow
      ? { kind: String(idpRow.kind), status: String(idpRow.status), issuerUrl: idpRow.issuerUrl }
      : null,
    roleMappings: roleMappings.map((r) => ({
      id: r.id,
      externalGroup: r.idpGroupName,
      tenantRole: String(r.tenantRole),
    })),
  });
}
