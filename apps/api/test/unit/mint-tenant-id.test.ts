import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantIdValidationError } from "@de-otio/saas-foundation/tenant";

const { mockDebug } = vi.hoisted(() => ({ mockDebug: vi.fn() }));

vi.mock("../../src/lib/logger.js", () => ({
  getLogger: () => ({
    debug: mockDebug,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  mintTenantId,
  type TenantProvenance,
} from "../../src/lib/mint-tenant-id.js";

const PROVENANCES: TenantProvenance[] = ["session", "ingress", "job"];

beforeEach(() => {
  mockDebug.mockClear();
});

// A valid tenant id: 1–256 chars, no whitespace / C0 controls / DEL.
const validTenantId = fc
  .string({ minLength: 1, maxLength: 256 })
  .filter((s) => /^[^\s\x00-\x1f\x7f]+$/.test(s));

describe("mintTenantId", () => {
  it("brands a valid raw string, erasing to the same string value", () => {
    const branded = mintTenantId("tenant-abc", "session");
    // Brand is compile-time only — the runtime value is the raw string.
    expect(branded).toBe("tenant-abc");
    expect(typeof branded).toBe("string");
  });

  it("accepts every provenance value", () => {
    for (const provenance of PROVENANCES) {
      expect(mintTenantId("tenant-1", provenance)).toBe("tenant-1");
    }
  });

  it("logs the provenance at the mint site (forensic, not a security boundary)", () => {
    mintTenantId("tenant-logged", "ingress");
    expect(mockDebug).toHaveBeenCalledTimes(1);
    expect(mockDebug).toHaveBeenCalledWith(
      "mintTenantId: tenant id minted",
      expect.objectContaining({ provenance: "ingress", tenantId: "tenant-logged" }),
    );
  });

  it.each(PROVENANCES)(
    "logs provenance %s distinctly per mint call",
    (provenance) => {
      mintTenantId("tenant-p", provenance);
      expect(mockDebug).toHaveBeenCalledWith(
        "mintTenantId: tenant id minted",
        expect.objectContaining({ provenance }),
      );
    },
  );

  it("does NOT log when the raw id is rejected (mint never completes)", () => {
    expect(() => mintTenantId("", "session")).toThrow(TenantIdValidationError);
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it.each([
    ["empty string", ""],
    ["leading/trailing whitespace", " tenant "],
    ["internal whitespace", "a b"],
    ["tab", "a\tb"],
    ["newline", "a\nb"],
    ["C0 control", "a\x01b"],
    ["DEL", "a\x7fb"],
  ])("rejects an invalid tenant id (%s) at the mint site", (_label, raw) => {
    expect(() => mintTenantId(raw, "session")).toThrow(TenantIdValidationError);
  });

  it("rejects a raw string longer than 256 chars", () => {
    expect(() => mintTenantId("x".repeat(257), "session")).toThrow(
      TenantIdValidationError,
    );
  });

  it("property: any constraint-satisfying raw round-trips to itself for every provenance", () => {
    fc.assert(
      fc.property(
        validTenantId,
        fc.constantFrom(...PROVENANCES),
        (raw, provenance) => {
          const branded = mintTenantId(raw, provenance);
          expect(branded).toBe(raw);
          // Provenance must not alter the minted value.
          expect(mintTenantId(raw, "session")).toBe(branded);
        },
      ),
    );
  });
});
