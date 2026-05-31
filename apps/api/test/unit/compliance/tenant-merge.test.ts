/**
 * Unit Tests: mergeTenantOverrides
 *
 * Pure-function tests — no DB, no mocks needed.
 */

import { describe, expect, it } from "vitest";
import { mergeTenantOverrides } from "../../../src/lib/compliance/tenant-merge.js";
import { BASELINE_COMPLIANCE } from "../../../src/lib/compliance/baseline.js";

const FIXED_TS = "2026-05-03T00:00:00.000Z";

describe("mergeTenantOverrides", () => {
  describe("dataResidency.activeRegion", () => {
    it("sets activeRegion from tenant.region when provided", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.dataResidency.activeRegion).toBe("EU");
    });

    it("defaults to EU when tenant.region is null", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: null },
        null,
        FIXED_TS,
      );
      expect(result.dataResidency.activeRegion).toBe("EU");
    });

    it("defaults to EU when tenant.region is undefined", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: undefined },
        null,
        FIXED_TS,
      );
      expect(result.dataResidency.activeRegion).toBe("EU");
    });

    it("sets lastVerifiedAt on dataResidency", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.dataResidency.lastVerifiedAt).toBe(FIXED_TS);
    });

    it("preserves supportedRegions and other baseline fields", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.dataResidency.supportedRegions).toEqual(
        BASELINE_COMPLIANCE.dataResidency.supportedRegions,
      );
      expect(result.dataResidency.guarantee).toBe(
        BASELINE_COMPLIANCE.dataResidency.guarantee,
      );
    });
  });

  describe("subprocessors.identityProvider", () => {
    it("includes identityProvider when IdP is configured with OIDC", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OIDC", issuerUrl: "https://login.example.com/tenant-x" },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider).toMatchObject({
        kind: "OIDC",
        issuerUrl: "https://login.example.com/tenant-x",
        lastVerifiedAt: FIXED_TS,
      });
    });

    it("includes identityProvider when IdP is configured with SAML", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "SAML", issuerUrl: "https://saml.example.com/metadata" },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider).toMatchObject({
        kind: "SAML",
        issuerUrl: "https://saml.example.com/metadata",
      });
    });

    it("omits identityProvider when idp is null", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider).toBeUndefined();
    });

    it("omits identityProvider when idp.issuerUrl is null", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OIDC", issuerUrl: null },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider).toBeUndefined();
    });

    it("removes tenantSpecific notice from subprocessors in tenant bundle", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.subprocessors.tenantSpecific).toBeUndefined();
    });

    it("preserves platform subprocessors", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.subprocessors.platform).toEqual(
        BASELINE_COMPLIANCE.subprocessors.platform,
      );
    });
  });

  describe("dataMinimization.tenantSpecific.activeIntegrations", () => {
    it("lists IdP as active integration when configured", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OIDC", issuerUrl: "https://login.example.com/t" },
        FIXED_TS,
      );
      expect(result.dataMinimization?.tenantSpecific?.activeIntegrations).toHaveLength(1);
      expect(result.dataMinimization?.tenantSpecific?.activeIntegrations[0]).toMatchObject({
        type: "OIDC",
        issuerUrl: "https://login.example.com/t",
      });
    });

    it("returns empty activeIntegrations when no IdP configured", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.dataMinimization?.tenantSpecific?.activeIntegrations).toHaveLength(0);
    });

    it("sets lastVerifiedAt on dataMinimization", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.dataMinimization?.tenantSpecific?.lastVerifiedAt).toBe(FIXED_TS);
    });
  });

  describe("baseline passthrough", () => {
    it("preserves all regulatory frameworks from baseline", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.regulatoryFrameworks).toEqual(
        BASELINE_COMPLIANCE.regulatoryFrameworks,
      );
    });

    it("preserves vendor info from baseline", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.vendor).toEqual(BASELINE_COMPLIANCE.vendor);
    });

    it("preserves encryption from baseline", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.encryption).toEqual(BASELINE_COMPLIANCE.encryption);
    });

    it("preserves version and publishedAt from baseline", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        null,
        FIXED_TS,
      );
      expect(result.version).toBe(BASELINE_COMPLIANCE.version);
      expect(result.publishedAt).toBe(BASELINE_COMPLIANCE.publishedAt);
    });

    it("does not mutate the baseline object", () => {
      const baselineCopy = JSON.parse(JSON.stringify(BASELINE_COMPLIANCE));
      mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OIDC", issuerUrl: "https://example.com" },
        FIXED_TS,
      );
      expect(BASELINE_COMPLIANCE).toEqual(baselineCopy);
    });
  });

  describe("OIDC/SAML name labels", () => {
    it("labels OIDC IdP correctly", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OIDC", issuerUrl: "https://idp.example.com" },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider?.name).toBe("OIDC Identity Provider");
    });

    it("labels SAML IdP correctly", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "SAML", issuerUrl: "https://idp.example.com" },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider?.name).toBe("SAML Identity Provider");
    });

    it("labels unknown kind as generic", () => {
      const result = mergeTenantOverrides(
        BASELINE_COMPLIANCE,
        { region: "EU" },
        { kind: "OTHER", issuerUrl: "https://idp.example.com" },
        FIXED_TS,
      );
      expect(result.subprocessors.identityProvider?.name).toBe("Identity Provider");
    });
  });
});
