/**
 * Unit Tests: computeSetupStatus
 *
 * Tests every state combination that produces a different nextStep.code.
 * loadSetupStatus is tested via routes/setup-status.test.ts with a DB mock.
 */

import { describe, expect, it } from "vitest";
import { computeSetupStatus, type SetupStatusInput } from "../../../src/lib/tenant/setup-status.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function base(): SetupStatusInput {
  return {
    tenantId: "tenant-123",
    tenantExists: true,
    hasTestSignIn: false,
    domains: [],
    idp: null,
    roleMappings: [],
  };
}

const verifiedDomain = {
  domain: "example.com",
  verifiedAt: new Date("2026-01-01T00:00:00Z"),
};

const pendingDomain = {
  domain: "example.com",
  verifiedAt: null,
};

const activeIdp = {
  kind: "OIDC",
  status: "ACTIVE",
  issuerUrl: "https://login.example.com",
};

const disabledIdp = {
  kind: "OIDC",
  status: "DISABLED",
  issuerUrl: "https://login.example.com",
};

const roleMapping = {
  id: "rm-1",
  externalGroup: "sg-admins",
  tenantRole: "ADMIN",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("computeSetupStatus", () => {
  // Case 1: no domains → DOMAIN_REQUIRED
  it("returns DOMAIN_REQUIRED when no domains are present", () => {
    const result = computeSetupStatus(base());

    expect(result.nextStep.code).toBe("DOMAIN_REQUIRED");
    expect(result.nextStep.endpoint).toContain("/domains");
    expect(result.domains).toHaveLength(0);
    expect(result.idp).toBeNull();
    expect(result.roleMappings).toHaveLength(0);
    expect(result.tenant.status).toBe("ok");
    expect(result.tenant.tenantId).toBe("tenant-123");
  });

  // Case 2: domain pending, none verified → DOMAIN_VERIFICATION_PENDING
  it("returns DOMAIN_VERIFICATION_PENDING when domain is claimed but not verified", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [pendingDomain],
    });

    expect(result.nextStep.code).toBe("DOMAIN_VERIFICATION_PENDING");
    expect(result.nextStep.endpoint).toContain("/verify");
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]?.status).toBe("pending");
    expect(result.domains[0]?.verifiedAt).toBeNull();
  });

  // Case 3: domain verified, no IdP → IDP_REQUIRED
  it("returns IDP_REQUIRED when domain is verified but no IdP is connected", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
    });

    expect(result.nextStep.code).toBe("IDP_REQUIRED");
    expect(result.nextStep.endpoint).toContain("/identity-provider");
    expect(result.domains[0]?.status).toBe("verified");
    expect(result.domains[0]?.verifiedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // Case 4 (variant): IdP present but DISABLED → IDP_REQUIRED
  it("returns IDP_REQUIRED when IdP exists but is DISABLED", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
      idp: disabledIdp,
    });

    expect(result.nextStep.code).toBe("IDP_REQUIRED");
    expect(result.nextStep.message).toContain("DISABLED");
    expect(result.idp).not.toBeNull();
    expect(result.idp?.status).toBe("DISABLED");
  });

  // Case 4: IdP active, no role mappings → ROLE_MAPPING_REQUIRED
  it("returns ROLE_MAPPING_REQUIRED when IdP is active but no role mappings exist", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
      idp: activeIdp,
    });

    expect(result.nextStep.code).toBe("ROLE_MAPPING_REQUIRED");
    expect(result.nextStep.endpoint).toContain("/role-mappings");
    expect(result.idp?.kind).toBe("OIDC");
    expect(result.idp?.status).toBe("ACTIVE");
    expect(result.roleMappings).toHaveLength(0);
  });

  // Case 5: all present, no test sign-in → TEST_SIGN_IN
  it("returns TEST_SIGN_IN when everything is set up but no sign-in recorded", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
      idp: activeIdp,
      roleMappings: [roleMapping],
      hasTestSignIn: false,
    });

    expect(result.nextStep.code).toBe("TEST_SIGN_IN");
    expect(result.nextStep.endpoint).toContain("/auth/discover");
    expect(result.roleMappings).toHaveLength(1);
    expect(result.roleMappings[0]?.externalGroup).toBe("sg-admins");
    expect(result.roleMappings[0]?.tenantRole).toBe("ADMIN");
  });

  // Case 6: all present + test sign-in recorded → COMPLETE
  it("returns COMPLETE when everything is set up and a sign-in has been recorded", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
      idp: activeIdp,
      roleMappings: [roleMapping],
      hasTestSignIn: true,
    });

    expect(result.nextStep.code).toBe("COMPLETE");
    expect(result.nextStep.message).toContain("complete");
    expect(result.nextStep.remediation).toBe("No action required.");
  });

  // Domain with failedAt → failed status
  it("maps domain with failedAt to failed status", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [
        {
          domain: "bad.com",
          verifiedAt: null,
          failedAt: new Date("2026-01-15T00:00:00Z"),
        },
      ],
    });

    // Still shows as DOMAIN_VERIFICATION_PENDING from nextStep perspective
    // because we have pending/failed but no verified
    expect(result.nextStep.code).toBe("DOMAIN_VERIFICATION_PENDING");
    expect(result.domains[0]?.status).toBe("failed");
  });

  // Mixed domains: one verified, one pending → still continues past domain step
  it("continues to IDP_REQUIRED when at least one domain is verified", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [
        verifiedDomain,
        { domain: "other.com", verifiedAt: null },
      ],
    });

    expect(result.nextStep.code).toBe("IDP_REQUIRED");
    expect(result.domains).toHaveLength(2);
  });

  // tenant section: missing tenant
  it("reflects missing tenant in tenant section", () => {
    const result = computeSetupStatus({
      ...base(),
      tenantExists: false,
    });

    expect(result.tenant.status).toBe("missing");
    // nextStep still walks through the domain check (no domains = DOMAIN_REQUIRED)
    expect(result.nextStep.code).toBe("DOMAIN_REQUIRED");
  });

  // nextStep endpoint includes the tenantId
  it("includes tenantId in endpoint paths", () => {
    const result = computeSetupStatus(base());

    expect(result.nextStep.endpoint).toContain("tenant-123");
  });

  // Role mappings are mapped faithfully
  it("maps multiple role mappings correctly", () => {
    const result = computeSetupStatus({
      ...base(),
      domains: [verifiedDomain],
      idp: activeIdp,
      roleMappings: [
        { id: "rm-1", externalGroup: "sg-admins", tenantRole: "ADMIN" },
        { id: "rm-2", externalGroup: "sg-members", tenantRole: "MEMBER" },
      ],
      hasTestSignIn: true,
    });

    expect(result.roleMappings).toHaveLength(2);
    expect(result.roleMappings[1]?.tenantRole).toBe("MEMBER");
    expect(result.nextStep.code).toBe("COMPLETE");
  });
});
