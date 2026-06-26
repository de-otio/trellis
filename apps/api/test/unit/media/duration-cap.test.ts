/**
 * Unit tests for exceedsDurationCap.
 *
 * Covers:
 *  - Fail-closed boundary: NaN, ±Infinity, negative probe => true
 *  - Boundary at cap: probed === cap => false
 *  - Over cap: probed > cap => true
 *  - Under cap: probed < cap => false
 *  - Monotonicity: for a fixed cap, exceeds(a) && a < b => exceeds(b)
 *  - Totality: function returns a boolean for every finite input pair
 *
 * No hard-coded operational thresholds. Cap always supplied as an argument.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { exceedsDurationCap } from "../../../src/lib/media/duration-cap.js";

// ---------------------------------------------------------------------------
// Explicit boundary / fail-closed cases
// ---------------------------------------------------------------------------

describe("exceedsDurationCap — fail-closed on un-verifiable probe", () => {
  it("returns true for NaN probe", () => {
    expect(exceedsDurationCap(NaN, 60)).toBe(true);
  });

  it("returns true for +Infinity probe", () => {
    expect(exceedsDurationCap(Infinity, 60)).toBe(true);
  });

  it("returns true for -Infinity probe", () => {
    expect(exceedsDurationCap(-Infinity, 60)).toBe(true);
  });

  it("returns true for negative probe", () => {
    expect(exceedsDurationCap(-1, 60)).toBe(true);
  });

  it("returns true for -0 probe (negative zero)", () => {
    // Object.is(-0, 0) is false; -0 < 0 is false but -0 is not a valid probe.
    // -0 >= 0 in JS, and -0 is finite, so it is treated as 0 (allowed at cap=0).
    // This documents the exact semantic: -0 is NOT negative (< 0 is false),
    // so it passes validation. exceedsDurationCap(-0, 0) === false.
    expect(exceedsDurationCap(-0, 0)).toBe(false);
  });
});

describe("exceedsDurationCap — boundary at cap", () => {
  it("returns false when probed equals cap (integer)", () => {
    expect(exceedsDurationCap(120, 120)).toBe(false);
  });

  it("returns false when probed equals cap (fractional)", () => {
    expect(exceedsDurationCap(59.999, 59.999)).toBe(false);
  });

  it("returns false when probed equals cap (zero)", () => {
    expect(exceedsDurationCap(0, 0)).toBe(false);
  });
});

describe("exceedsDurationCap — over cap", () => {
  it("returns true when probed is 1 second over cap", () => {
    expect(exceedsDurationCap(121, 120)).toBe(true);
  });

  it("returns true when probed is fractionally over cap", () => {
    // Use a value that has a clear floating-point representation.
    expect(exceedsDurationCap(60.1, 60)).toBe(true);
  });
});

describe("exceedsDurationCap — under cap", () => {
  it("returns false when probed is well under cap", () => {
    expect(exceedsDurationCap(30, 120)).toBe(false);
  });

  it("returns false for probed=0 with positive cap", () => {
    expect(exceedsDurationCap(0, 300)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("exceedsDurationCap — property: NaN/Infinity/negative always fails closed", () => {
  it("NaN probe is always true regardless of cap", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: false }), (cap) => {
        expect(exceedsDurationCap(NaN, cap)).toBe(true);
      }),
    );
  });

  it("+Infinity probe is always true regardless of cap", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true }), (cap) => {
        expect(exceedsDurationCap(Infinity, cap)).toBe(true);
      }),
    );
  });

  it("-Infinity probe is always true regardless of cap", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true }), (cap) => {
        expect(exceedsDurationCap(-Infinity, cap)).toBe(true);
      }),
    );
  });

  it("strictly negative finite probe is always true regardless of cap", () => {
    fc.assert(
      fc.property(
        // A finite negative float (exclude -0 since it is not < 0 in JS).
        fc.float({ min: -1e9, max: -Number.EPSILON, noNaN: true }),
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        (probe, cap) => {
          expect(exceedsDurationCap(probe, cap)).toBe(true);
        },
      ),
    );
  });
});

describe("exceedsDurationCap — property: boundary at cap is always allowed", () => {
  it("exceedsDurationCap(x, x) === false for all finite non-negative x", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        (x) => {
          // A value at exactly the cap must be allowed.
          expect(exceedsDurationCap(x, x)).toBe(false);
        },
      ),
    );
  });
});

describe("exceedsDurationCap — property: monotone in probe", () => {
  it("if exceedsDurationCap(a, cap) is false and b >= a then result is consistent", () => {
    fc.assert(
      fc.property(
        // cap: a reasonable positive cap
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        // a: a finite non-negative probe
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        // delta: non-negative increment
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        (cap, a, delta) => {
          const b = a + delta;
          if (!Number.isFinite(b)) return; // skip overflow
          const resultA = exceedsDurationCap(a, cap);
          const resultB = exceedsDurationCap(b, cap);
          // Monotonicity: if a is not exceeding, b (>= a) may or may not exceed.
          // If b IS exceeding, a might or might not. The key invariant:
          // if b does NOT exceed, then a (being <= b) must also not exceed.
          if (!resultB) {
            expect(resultA).toBe(false);
          }
        },
      ),
    );
  });

  it("if exceedsDurationCap(a, cap) is true and b <= a, result is consistent", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        (cap, b, delta) => {
          const a = b + delta;
          if (!Number.isFinite(a)) return;
          const resultA = exceedsDurationCap(a, cap);
          const resultB = exceedsDurationCap(b, cap);
          // If a exceeds cap, then a larger value must also exceed (not tested here),
          // but if a does NOT exceed, b (being <= a) must also not exceed.
          if (!resultA) {
            expect(resultB).toBe(false);
          }
        },
      ),
    );
  });
});

describe("exceedsDurationCap — property: totality (always boolean, never throws)", () => {
  it("returns a boolean for any float pair", () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: false }),
        fc.float({ noNaN: false }),
        (probe, cap) => {
          const result = exceedsDurationCap(probe, cap);
          expect(typeof result).toBe("boolean");
        },
      ),
    );
  });
});

describe("exceedsDurationCap — property: probed < cap always allowed", () => {
  it("for any valid probe strictly below cap, result is false", () => {
    fc.assert(
      fc.property(
        // cap: at least epsilon so there's room below
        fc.float({ min: Number.EPSILON, max: 1e9, noNaN: true }),
        // probe: strictly less than cap
        fc.float({ min: 0, noNaN: true }),
        (cap, probeFraction) => {
          // Build a probe that is strictly < cap by scaling.
          const probe = probeFraction % cap; // [0, cap)
          if (!Number.isFinite(probe) || probe < 0) return;
          expect(exceedsDurationCap(probe, cap)).toBe(false);
        },
      ),
    );
  });
});

describe("exceedsDurationCap — property: probed strictly over cap always rejected", () => {
  it("for any finite cap and probe that is cap + positive delta, result is true", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e6, noNaN: true }),
        fc.float({ min: Number.EPSILON, max: 1e6, noNaN: true }),
        (cap, delta) => {
          const probe = cap + delta;
          if (!Number.isFinite(probe)) return;
          // Guard against float64 absorption: if cap + delta === cap in float64,
          // there is no representable value strictly between them, so the
          // precondition "probe > cap" does not hold — skip rather than assert.
          if (probe <= cap) return;
          expect(exceedsDurationCap(probe, cap)).toBe(true);
        },
      ),
    );
  });
});
