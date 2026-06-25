import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  checkUploadQuota,
  type QuotaCheckResult,
} from "../../../src/lib/media/quota-check.js";
import type { QuotaState, QuotaLimits } from "../../../src/lib/media/quota-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function state(currentObjects: number, currentBytes: number): QuotaState {
  return { currentObjects, currentBytes };
}

function limits(maxObjects: number, maxBytes: number): QuotaLimits {
  return { maxObjects, maxBytes };
}

// ---------------------------------------------------------------------------
// Deterministic boundary cases
// ---------------------------------------------------------------------------

describe("checkUploadQuota — object-cap boundary", () => {
  it("allows when currentObjects is strictly below maxObjects", () => {
    const result = checkUploadQuota(state(4, 0), 0, limits(5, 1000));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("denies with object-cap when currentObjects equals maxObjects", () => {
    const result = checkUploadQuota(state(5, 0), 0, limits(5, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("object-cap");
  });

  it("denies with object-cap when currentObjects exceeds maxObjects", () => {
    const result = checkUploadQuota(state(6, 0), 0, limits(5, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("object-cap");
  });

  it("object-cap takes priority over byte-cap", () => {
    // Both caps would be exceeded; object-cap must win.
    const result = checkUploadQuota(state(5, 900), 200, limits(5, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("object-cap");
  });
});

describe("checkUploadQuota — byte-cap boundary", () => {
  it("allows when currentBytes + incomingBytes exactly equals maxBytes", () => {
    const result = checkUploadQuota(state(0, 800), 200, limits(10, 1000));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("allows when currentBytes + incomingBytes is one below maxBytes", () => {
    const result = checkUploadQuota(state(0, 800), 199, limits(10, 1000));
    expect(result.allowed).toBe(true);
  });

  it("denies with byte-cap when currentBytes + incomingBytes is one above maxBytes", () => {
    const result = checkUploadQuota(state(0, 800), 201, limits(10, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("byte-cap");
  });

  it("denies with byte-cap when incoming alone exceeds maxBytes", () => {
    const result = checkUploadQuota(state(0, 0), 1001, limits(10, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("byte-cap");
  });

  it("allows a zero-byte incoming file when under both caps", () => {
    const result = checkUploadQuota(state(3, 500), 0, limits(10, 1000));
    expect(result.allowed).toBe(true);
  });
});

describe("checkUploadQuota — FAIL-CLOSED on bad inputs", () => {
  it("denies when incomingBytes is NaN", () => {
    const result = checkUploadQuota(state(0, 0), NaN, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when incomingBytes is negative", () => {
    const result = checkUploadQuota(state(0, 0), -1, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when incomingBytes is -Infinity", () => {
    const result = checkUploadQuota(state(0, 0), -Infinity, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when incomingBytes is +Infinity", () => {
    const result = checkUploadQuota(state(0, 0), Infinity, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when currentObjects is NaN", () => {
    const result = checkUploadQuota(state(NaN, 0), 0, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when currentBytes is NaN", () => {
    const result = checkUploadQuota(state(0, NaN), 100, limits(10, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when maxObjects is NaN", () => {
    const result = checkUploadQuota(state(0, 0), 0, limits(NaN, 1000));
    expect(result.allowed).toBe(false);
  });

  it("denies when maxBytes is NaN", () => {
    const result = checkUploadQuota(state(0, 0), 0, limits(10, NaN));
    expect(result.allowed).toBe(false);
  });

  it("denies when maxObjects is Infinity (non-finite limit is untrustworthy)", () => {
    const result = checkUploadQuota(state(0, 0), 0, limits(Infinity, 1000));
    expect(result.allowed).toBe(false);
  });
});

describe("checkUploadQuota — zero-quota edge cases", () => {
  it("denies any upload when maxObjects is 0", () => {
    const result = checkUploadQuota(state(0, 0), 0, limits(0, 1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("object-cap");
  });

  it("denies any upload when maxBytes is 0 and incoming > 0", () => {
    const result = checkUploadQuota(state(0, 0), 1, limits(10, 0));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("byte-cap");
  });

  it("allows zero-byte upload when maxBytes is 0 and object count is below cap", () => {
    // Zero bytes + zero budget = exactly at limit; 0 <= 0 is true.
    const result = checkUploadQuota(state(0, 0), 0, limits(10, 0));
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe("checkUploadQuota — properties", () => {
  // Finite non-negative integers for realistic quota domain.
  const safeNat = fc.integer({ min: 0, max: 1_000_000 });
  const safePositive = fc.integer({ min: 1, max: 1_000_000 });

  it("PROPERTY: strictly under both caps => always allowed", () => {
    fc.assert(
      fc.property(
        safeNat,       // currentObjects
        safeNat,       // currentBytes
        safeNat,       // incomingBytes
        safePositive,  // maxObjects (at least 1 so there is headroom)
        safePositive,  // maxBytes headroom
        (currentObjects, currentBytes, incomingBytes, extraObjects, extraBytes) => {
          // Construct limits that guarantee both are under-cap.
          const maxObjects = currentObjects + extraObjects; // strictly above currentObjects
          const maxBytes = currentBytes + incomingBytes + extraBytes; // strictly above sum
          const result = checkUploadQuota(
            state(currentObjects, currentBytes),
            incomingBytes,
            limits(maxObjects, maxBytes),
          );
          return result.allowed === true;
        },
      ),
    );
  });

  it("PROPERTY: at or over object cap => denied with object-cap (bytes notwithstanding)", () => {
    fc.assert(
      fc.property(
        safeNat,   // maxObjects
        safeNat,   // overflow: how far over cap currentObjects is (0 = exactly at)
        safeNat,   // currentBytes
        safeNat,   // incomingBytes
        safeNat,   // maxBytes (may or may not be over — doesn't matter)
        (maxObjects, overflow, currentBytes, incomingBytes, maxBytes) => {
          const currentObjects = maxObjects + overflow; // >= maxObjects
          const result = checkUploadQuota(
            state(currentObjects, currentBytes),
            incomingBytes,
            limits(maxObjects, maxBytes + incomingBytes + currentBytes), // bytes always fine
          );
          return result.allowed === false && result.reason === "object-cap";
        },
      ),
    );
  });

  it("PROPERTY: under object cap but bytes would exceed => denied with byte-cap", () => {
    fc.assert(
      fc.property(
        safePositive, // maxObjects (>0 so currentObjects can be strictly below)
        fc.integer({ min: 0, max: 999_999 }), // currentObjects (below maxObjects)
        safeNat,      // currentBytes
        safePositive, // excess: how much currentBytes+incoming exceeds maxBytes (> 0)
        safeNat,      // maxBytes base
        (maxObjects, currentObjectsOffset, currentBytes, excess, maxBytesBase) => {
          const currentObjects = maxObjects - 1 - (currentObjectsOffset % maxObjects);
          // incomingBytes = maxBytesBase - currentBytes + excess (so sum = maxBytesBase + excess > maxBytesBase)
          // Clamp to avoid negatives when currentBytes > maxBytesBase.
          const maxBytes = currentBytes + maxBytesBase;
          const incomingBytes = maxBytesBase + excess; // currentBytes + incomingBytes = currentBytes + maxBytesBase + excess > maxBytes
          const result = checkUploadQuota(
            state(currentObjects, currentBytes),
            incomingBytes,
            limits(maxObjects, maxBytes),
          );
          return result.allowed === false && result.reason === "byte-cap";
        },
      ),
    );
  });

  it("PROPERTY: result is always a valid QuotaCheckResult shape", () => {
    const anyNumber = fc.oneof(
      fc.integer(),
      fc.float({ noNaN: false }),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.constant(-Infinity),
    );
    fc.assert(
      fc.property(
        anyNumber, anyNumber, anyNumber, anyNumber, anyNumber,
        (currentObjects, currentBytes, incomingBytes, maxObjects, maxBytes) => {
          const result: QuotaCheckResult = checkUploadQuota(
            state(currentObjects, currentBytes),
            incomingBytes,
            limits(maxObjects, maxBytes),
          );
          // Shape invariants
          if (typeof result.allowed !== "boolean") return false;
          if (!result.allowed) {
            // reason must be undefined or a valid tag
            if (result.reason !== undefined &&
                result.reason !== "object-cap" &&
                result.reason !== "byte-cap") return false;
          } else {
            // allowed=true must have no reason
            if (result.reason !== undefined) return false;
          }
          return true;
        },
      ),
    );
  });

  it("PROPERTY: negative incomingBytes always denied", () => {
    fc.assert(
      fc.property(
        safeNat, safeNat,
        fc.integer({ min: -1_000_000, max: -1 }),
        safePositive, safePositive,
        (currentObjects, currentBytes, incomingBytes, maxObjects, maxBytes) => {
          const result = checkUploadQuota(
            state(currentObjects, currentBytes),
            incomingBytes,
            limits(maxObjects, maxBytes),
          );
          return result.allowed === false;
        },
      ),
    );
  });
});
