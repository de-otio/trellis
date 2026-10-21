import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  validateRecoverySweepConfig,
  type MediaRecoverySweepConfig,
} from "../../../src/lib/workers/media-recovery-sweep.js";

// Obviously-mock values. None of these is, or resembles, operative config.
const QUEUE = { completionVisibilitySeconds: 10, completionMaxReceive: 3 };
const HORIZON = 30;

const FC = { seed: 0x5eed, numRuns: 500 } as const;

function cfg(
  over: Partial<MediaRecoverySweepConfig> = {},
): MediaRecoverySweepConfig {
  return {
    settleWindowSeconds: HORIZON,
    maxMediaAgeSeconds: HORIZON + 1,
    batchSize: 5,
    ...over,
  };
}

describe("validateRecoverySweepConfig", () => {
  const cases: ReadonlyArray<{
    name: string;
    config: MediaRecoverySweepConfig;
    queue?: typeof QUEUE;
    errors: readonly RegExp[];
  }> = [
    { name: "settle window exactly at the horizon", config: cfg(), errors: [] },
    {
      name: "settle window above the horizon",
      config: cfg({ settleWindowSeconds: 40, maxMediaAgeSeconds: 50 }),
      errors: [],
    },
    {
      name: "settle window one below the horizon",
      config: cfg({ settleWindowSeconds: HORIZON - 1 }),
      errors: [/settleWindowSeconds must be at least/],
    },
    {
      name: "max age equal to the settle window",
      config: cfg({ maxMediaAgeSeconds: HORIZON }),
      errors: [/maxMediaAgeSeconds must be greater/],
    },
    {
      name: "max age below the settle window",
      config: cfg({ maxMediaAgeSeconds: 1 }),
      errors: [/maxMediaAgeSeconds must be greater/],
    },
    {
      name: "both timing rules broken",
      config: cfg({ settleWindowSeconds: 1, maxMediaAgeSeconds: 1 }),
      errors: [
        /settleWindowSeconds must be at least/,
        /maxMediaAgeSeconds must be greater/,
      ],
    },
    {
      name: "zero-length horizon",
      config: cfg({ settleWindowSeconds: 0, maxMediaAgeSeconds: 1 }),
      queue: { completionVisibilitySeconds: 0, completionMaxReceive: 3 },
      errors: [],
    },
    {
      name: "batch size zero",
      config: cfg({ batchSize: 0 }),
      errors: [/batchSize must be a positive integer/],
    },
    {
      name: "fractional batch size",
      config: cfg({ batchSize: 1.5 }),
      errors: [/batchSize must be a positive integer/],
    },
    {
      name: "NaN settle window",
      config: cfg({ settleWindowSeconds: Number.NaN }),
      errors: [/settleWindowSeconds must be a finite/],
    },
    {
      name: "infinite max age",
      config: cfg({ maxMediaAgeSeconds: Number.POSITIVE_INFINITY }),
      errors: [/maxMediaAgeSeconds must be a finite/],
    },
    {
      name: "negative queue visibility",
      config: cfg(),
      queue: { completionVisibilitySeconds: -1, completionMaxReceive: 3 },
      errors: [/completionVisibilitySeconds must be a finite/],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const errors = validateRecoverySweepConfig(c.config, c.queue ?? QUEUE);
      expect(errors).toHaveLength(c.errors.length);
      c.errors.forEach((re, i) => expect(errors[i]).toMatch(re));
    });
  }

  describe("boundary properties", () => {
    const seconds = fc.integer({ min: 0, max: 10_000 });
    const receives = fc.integer({ min: 0, max: 100 });

    it("accepts settle = visibility × maxReceive and max age = settle + 1", () => {
      fc.assert(
        fc.property(seconds, receives, (v, r) => {
          const settle = v * r;
          expect(
            validateRecoverySweepConfig(
              cfg({ settleWindowSeconds: settle, maxMediaAgeSeconds: settle + 1 }),
              { completionVisibilitySeconds: v, completionMaxReceive: r },
            ),
          ).toEqual([]);
        }),
        FC,
      );
    });

    it("rejects a settle window one below the redelivery horizon", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 100 }),
          (v, r) => {
            const settle = v * r - 1;
            expect(
              validateRecoverySweepConfig(
                cfg({
                  settleWindowSeconds: settle,
                  maxMediaAgeSeconds: settle + 1,
                }),
                { completionVisibilitySeconds: v, completionMaxReceive: r },
              ),
            ).toEqual([
              "settleWindowSeconds must be at least completionVisibilitySeconds × completionMaxReceive",
            ]);
          },
        ),
        FC,
      );
    });

    it("rejects max age equal to the settle window", () => {
      fc.assert(
        fc.property(seconds, receives, (v, r) => {
          const settle = v * r;
          expect(
            validateRecoverySweepConfig(
              cfg({ settleWindowSeconds: settle, maxMediaAgeSeconds: settle }),
              { completionVisibilitySeconds: v, completionMaxReceive: r },
            ),
          ).toEqual([
            "maxMediaAgeSeconds must be greater than settleWindowSeconds",
          ]);
        }),
        FC,
      );
    });

    it("is pure: the same input yields the same output and is not mutated", () => {
      fc.assert(
        fc.property(seconds, seconds, seconds, receives, (s, m, v, r) => {
          const c = cfg({ settleWindowSeconds: s, maxMediaAgeSeconds: m });
          const q = { completionVisibilitySeconds: v, completionMaxReceive: r };
          const snapshot = JSON.stringify([c, q]);
          const a = validateRecoverySweepConfig(c, q);
          expect(validateRecoverySweepConfig(c, q)).toEqual(a);
          expect(JSON.stringify([c, q])).toBe(snapshot);
        }),
        FC,
      );
    });
  });
});
