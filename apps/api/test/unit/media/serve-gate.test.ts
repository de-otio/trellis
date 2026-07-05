/**
 * Unit + property tests for the pure serve-gate core (T5).
 *
 * `canServe` / `isServable` are the fail-closed decision: ONLY `APPROVED` and
 * not-hidden and not-deleted serves bytes — for every viewer, with no owner
 * exception. These properties are the load-bearing safety invariant; a
 * regression that lets any non-APPROVED state through must turn one red.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canServe,
  canonicalContentType,
  isServable,
} from "../../../src/lib/media/serve-gate.js";
import {
  ALL_MEDIA_LIFECYCLES,
  type MediaLifecycle,
} from "../../../src/lib/media/media-lifecycle.js";

// Seed fast-check for determinism (pinned, no clock/RNG drift).
const FC = { seed: 0x5e_11_ca_7e, numRuns: 500 } as const;

const statusArb = fc.constantFrom<MediaLifecycle>(
  ...ALL_MEDIA_LIFECYCLES,
);

describe("canServe (T5 gate predicate)", () => {
  it("APPROVED is the ONLY status that serves", () => {
    for (const status of ALL_MEDIA_LIFECYCLES) {
      expect(canServe(status)).toBe(status === "APPROVED");
    }
  });

  it("property: no non-APPROVED status ever serves", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        if (status !== "APPROVED") {
          expect(canServe(status)).toBe(false);
        }
      }),
      FC,
    );
  });
});

describe("isServable (full record gate)", () => {
  it("serves only APPROVED + not-hidden + not-deleted", () => {
    expect(
      isServable({ lifecycle: "APPROVED", hidden: false, deletedAt: null }),
    ).toBe(true);
  });

  it("hidden denies even when APPROVED", () => {
    expect(
      isServable({ lifecycle: "APPROVED", hidden: true, deletedAt: null }),
    ).toBe(false);
  });

  it("deletedAt denies even when APPROVED", () => {
    expect(
      isServable({
        lifecycle: "APPROVED",
        hidden: false,
        deletedAt: new Date(0),
      }),
    ).toBe(false);
  });

  it("property: any non-APPROVED status denies regardless of flags", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.boolean(),
        fc.option(fc.date(), { nil: null }),
        (lifecycle, hidden, deletedAt) => {
          if (lifecycle !== "APPROVED") {
            expect(isServable({ lifecycle, hidden, deletedAt })).toBe(
              false,
            );
          }
        },
      ),
      FC,
    );
  });

  it("property: APPROVED serves IFF not hidden and not deleted", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.date(), { nil: null }),
        (hidden, deletedAt) => {
          const result = isServable({
            lifecycle: "APPROVED",
            hidden,
            deletedAt,
          });
          expect(result).toBe(!hidden && deletedAt === null);
        },
      ),
      FC,
    );
  });
});

describe("canonicalContentType", () => {
  it("maps each canonical format to its image MIME", () => {
    expect(canonicalContentType("jpeg")).toBe("image/jpeg");
    expect(canonicalContentType("png")).toBe("image/png");
    expect(canonicalContentType("webp")).toBe("image/webp");
  });
});
