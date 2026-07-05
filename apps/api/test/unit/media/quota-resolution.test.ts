import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  resolveQuotaLimits,
  type TenantQuotaOverride,
} from "../../../src/lib/media/quota-resolution.js";
import { checkUploadQuota } from "../../../src/lib/media/quota-check.js";
import type { QuotaLimits } from "../../../src/lib/media/quota-types.js";

const DEFAULTS: QuotaLimits = { maxObjects: 1000, maxBytes: 1024 * 1024 * 1024 };

function override(
  bytes: bigint | number | null,
  objects: number | null,
): TenantQuotaOverride {
  return { storageQuotaBytes: bytes, storageQuotaObjects: objects };
}

describe("resolveQuotaLimits — override ?? default", () => {
  it("returns the defaults when the override row is null (tenant missing)", () => {
    expect(resolveQuotaLimits(null, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("returns the defaults when the override row is undefined", () => {
    expect(resolveQuotaLimits(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("returns the defaults when both columns are NULL", () => {
    expect(resolveQuotaLimits(override(null, null), DEFAULTS)).toEqual(DEFAULTS);
  });

  it("byte override wins; object default is kept when its column is NULL", () => {
    const resolved = resolveQuotaLimits(override(BigInt(5_000_000), null), DEFAULTS);
    expect(resolved.maxBytes).toBe(5_000_000);
    expect(resolved.maxObjects).toBe(DEFAULTS.maxObjects);
  });

  it("object override wins; byte default is kept when its column is NULL", () => {
    const resolved = resolveQuotaLimits(override(null, 42), DEFAULTS);
    expect(resolved.maxObjects).toBe(42);
    expect(resolved.maxBytes).toBe(DEFAULTS.maxBytes);
  });

  it("both overrides win together", () => {
    const resolved = resolveQuotaLimits(
      override(BigInt(2) * BigInt(1024 ** 3), 5000),
      DEFAULTS,
    );
    expect(resolved.maxBytes).toBe(2 * 1024 ** 3);
    expect(resolved.maxObjects).toBe(5000);
  });

  it("accepts a plain-number byte override (test fakes / non-Prisma callers)", () => {
    const resolved = resolveQuotaLimits(override(123_456, null), DEFAULTS);
    expect(resolved.maxBytes).toBe(123_456);
  });

  it("a zero override is an override (a frozen tenant), not a fall-through", () => {
    const resolved = resolveQuotaLimits(override(BigInt(0), 0), DEFAULTS);
    expect(resolved.maxBytes).toBe(0);
    expect(resolved.maxObjects).toBe(0);
    // And zero limits deny any upload (fail-closed downstream).
    const verdict = checkUploadQuota(
      { currentObjects: 0, currentBytes: 0 },
      1,
      resolved,
    );
    expect(verdict.allowed).toBe(false);
  });
});

describe("resolveQuotaLimits — fail-closed composition with checkUploadQuota", () => {
  it("a NaN byte override flows through and DENIES (never widens to the default)", () => {
    const resolved = resolveQuotaLimits(override(Number.NaN, null), DEFAULTS);
    expect(Number.isFinite(resolved.maxBytes)).toBe(false);
    const verdict = checkUploadQuota(
      { currentObjects: 0, currentBytes: 0 },
      1,
      resolved,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("an Infinity object override DENIES via the non-finite guard", () => {
    const resolved = resolveQuotaLimits(
      override(null, Number.POSITIVE_INFINITY),
      DEFAULTS,
    );
    const verdict = checkUploadQuota(
      { currentObjects: 0, currentBytes: 0 },
      1,
      resolved,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("a negative byte override DENIES uploads (byte-cap)", () => {
    const resolved = resolveQuotaLimits(override(BigInt(-1), null), DEFAULTS);
    const verdict = checkUploadQuota(
      { currentObjects: 0, currentBytes: 0 },
      1,
      resolved,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("a negative object override DENIES uploads (object-cap)", () => {
    const resolved = resolveQuotaLimits(override(null, -5), DEFAULTS);
    const verdict = checkUploadQuota(
      { currentObjects: 0, currentBytes: 0 },
      1,
      resolved,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("object-cap");
  });

  it("property: null columns always resolve to the defaults; non-null always to the override", () => {
    fc.assert(
      fc.property(
        fc.option(fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) }), {
          nil: null,
        }),
        fc.option(fc.integer({ min: 0 }), { nil: null }),
        (bytes, objects) => {
          const resolved = resolveQuotaLimits(override(bytes, objects), DEFAULTS);
          expect(resolved.maxBytes).toBe(
            bytes === null ? DEFAULTS.maxBytes : Number(bytes),
          );
          expect(resolved.maxObjects).toBe(
            objects === null ? DEFAULTS.maxObjects : objects,
          );
        },
      ),
    );
  });
});
