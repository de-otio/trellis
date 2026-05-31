/**
 * Unit tests for the foundation RegionRegistry adapter.
 *
 * Covers the singleton construction, the country->region mapping faithfully
 * extracted from the legacy region-detection.ts, the allowed list / default,
 * and the reset helper.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  EU_COUNTRY_CODES,
  TRELLIS_REGIONS,
  getRegionRegistry,
  resetRegionRegistry,
} from "../../src/lib/region-registry.js";

describe("region-registry", () => {
  beforeEach(() => {
    resetRegionRegistry();
  });

  describe("getRegionRegistry", () => {
    it("returns a registry whose allowed list is exactly US/EU/CN", () => {
      const registry = getRegionRegistry();
      const allowed = [...registry.allowed()].sort();
      expect(allowed).toEqual(["CN", "EU", "US"]);
    });

    it("uses EU as the default region (GDPR-safe fallback)", () => {
      expect(getRegionRegistry().getDefault()).toBe("EU");
    });

    it("caches the registry instance across calls", () => {
      const a = getRegionRegistry();
      const b = getRegionRegistry();
      expect(a).toBe(b);
    });

    it("constructs a fresh instance after reset", () => {
      const a = getRegionRegistry();
      resetRegionRegistry();
      const b = getRegionRegistry();
      expect(a).not.toBe(b);
    });
  });

  describe("countryToRegion", () => {
    it("maps CN -> CN", () => {
      expect(getRegionRegistry().countryToRegion("CN")).toBe("CN");
    });

    it("maps US -> US", () => {
      expect(getRegionRegistry().countryToRegion("US")).toBe("US");
    });

    it("maps every EU member-state code -> EU", () => {
      const registry = getRegionRegistry();
      for (const code of EU_COUNTRY_CODES) {
        expect(registry.countryToRegion(code)).toBe("EU");
      }
    });

    it("is case-insensitive on the country code", () => {
      const registry = getRegionRegistry();
      expect(registry.countryToRegion("cn")).toBe("CN");
      expect(registry.countryToRegion("de")).toBe("EU");
    });

    it("returns null for unmapped countries (catch-all is applied by the wrapper, not the registry)", () => {
      const registry = getRegionRegistry();
      for (const code of ["GB", "JP", "CA", "MX", "BR", "AU"]) {
        expect(registry.countryToRegion(code)).toBeNull();
      }
    });

    it("returns null for unknown markers", () => {
      const registry = getRegionRegistry();
      expect(registry.countryToRegion("XX")).toBeNull();
      expect(registry.countryToRegion("T1")).toBeNull();
    });
  });

  describe("exported constants", () => {
    it("TRELLIS_REGIONS lists the three regions", () => {
      expect([...TRELLIS_REGIONS]).toEqual(["US", "EU", "CN"]);
    });

    it("EU_COUNTRY_CODES contains the 27 EU member states", () => {
      expect(EU_COUNTRY_CODES).toHaveLength(27);
      // spot-check a few representative members
      expect(EU_COUNTRY_CODES).toContain("DE");
      expect(EU_COUNTRY_CODES).toContain("FR");
      expect(EU_COUNTRY_CODES).toContain("SE");
    });
  });
});
