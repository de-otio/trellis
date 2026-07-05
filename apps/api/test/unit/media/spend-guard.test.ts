/**
 * Unit tests for the AR5 media AI-spend guard pure core + mock
 * (apps/api/src/lib/media/spend-guard.ts).
 *
 * The pure functions are exercised over boundaries and invalid inputs (they
 * must fail CLOSED: invalid estimates throw, corrupted counters read as over
 * the cap), plus a fast-check property for the estimate's linearity.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  estimateJobCostUsd,
  isOverDailyCap,
  MockSpendGuardPort,
} from "../../../src/lib/media/spend-guard.js";

describe("estimateJobCostUsd", () => {
  it("computes duration/60 × rate", () => {
    expect(estimateJobCostUsd(180, 0.2)).toBeCloseTo(0.6, 10);
    expect(estimateJobCostUsd(0, 0.2)).toBe(0);
    expect(estimateJobCostUsd(30, 0)).toBe(0);
  });

  it("throws on non-finite or negative duration (fail closed, no silent under-estimate)", () => {
    expect(() => estimateJobCostUsd(Number.NaN, 0.1)).toThrow(TypeError);
    expect(() => estimateJobCostUsd(Number.POSITIVE_INFINITY, 0.1)).toThrow(TypeError);
    expect(() => estimateJobCostUsd(-1, 0.1)).toThrow(TypeError);
  });

  it("throws on non-finite or negative rate", () => {
    expect(() => estimateJobCostUsd(60, Number.NaN)).toThrow(TypeError);
    expect(() => estimateJobCostUsd(60, -0.01)).toThrow(TypeError);
  });

  it("property: non-negative and monotone in duration for valid inputs", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 86_400, noNaN: true }),
        fc.double({ min: 0, max: 86_400, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (d1, d2, rate) => {
          const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const a = estimateJobCostUsd(lo, rate);
          const b = estimateJobCostUsd(hi, rate);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(b).toBeGreaterThanOrEqual(a);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("isOverDailyCap", () => {
  it("is under strictly below the cap, over at and above it (ceiling semantics)", () => {
    expect(isOverDailyCap(4.99, 5)).toBe(false);
    expect(isOverDailyCap(5, 5)).toBe(true);
    expect(isOverDailyCap(5.01, 5)).toBe(true);
  });

  it("a cap of 0 (or negative) blocks everything — operator emergency stop", () => {
    expect(isOverDailyCap(0, 0)).toBe(true);
    expect(isOverDailyCap(0, -1)).toBe(true);
  });

  it("a non-finite counter value reads as OVER the cap (fail closed)", () => {
    expect(isOverDailyCap(Number.NaN, 5)).toBe(true);
    expect(isOverDailyCap(Number.POSITIVE_INFINITY, 5)).toBe(true);
    expect(isOverDailyCap(Number.NEGATIVE_INFINITY, 5)).toBe(true);
  });
});

describe("MockSpendGuardPort", () => {
  it("accumulates recorded spend and reports the programmed value", async () => {
    const mock = new MockSpendGuardPort({ spendUsd: 1 });
    expect(await mock.getTodaySpendUsd()).toBe(1);
    await mock.recordSpendUsd(0.5);
    expect(mock.recorded).toEqual([0.5]);
    expect(await mock.getTodaySpendUsd()).toBe(1.5);
  });

  it("programmed failures throw from the corresponding method", async () => {
    const mock = new MockSpendGuardPort();
    mock.failReads(new Error("read down"));
    await expect(mock.getTodaySpendUsd()).rejects.toThrow("read down");
    mock.failRecords(new Error("write down"));
    await expect(mock.recordSpendUsd(1)).rejects.toThrow("write down");
  });

  it("counts cap-exceeded reports", async () => {
    const mock = new MockSpendGuardPort();
    await mock.reportCapExceeded();
    await mock.reportCapExceeded();
    expect(mock.capExceededReports).toBe(2);
  });
});
