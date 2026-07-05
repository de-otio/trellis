import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_RATE_WINDOW_MS,
  REVIEW_RATE_COUNTED_LIFECYCLES,
  isOverReviewRateCap,
  reviewRateWhere,
  reviewRateWindowMs,
  reviewRateWindowStart,
} from "../../../src/lib/media/review-rate-cap.js";

describe("isOverReviewRateCap", () => {
  it("allows below the cap", () => {
    expect(isOverReviewRateCap(0, 20)).toBe(false);
    expect(isOverReviewRateCap(19, 20)).toBe(false);
  });

  it("denies AT the cap (the cap-th flagged object closes the gate)", () => {
    expect(isOverReviewRateCap(20, 20)).toBe(true);
  });

  it("denies above the cap", () => {
    expect(isOverReviewRateCap(21, 20)).toBe(true);
  });

  it("fail-closed on non-finite count or cap", () => {
    expect(isOverReviewRateCap(Number.NaN, 20)).toBe(true);
    expect(isOverReviewRateCap(0, Number.NaN)).toBe(true);
    expect(isOverReviewRateCap(0, undefined as unknown as number)).toBe(true);
    expect(isOverReviewRateCap(Number.POSITIVE_INFINITY, 20)).toBe(true);
  });

  it("fail-closed on a nonsensical negative count", () => {
    expect(isOverReviewRateCap(-1, 20)).toBe(true);
  });
});

describe("reviewRateWindowMs", () => {
  it("defaults to 24 h when the env var is absent", () => {
    expect(reviewRateWindowMs({})).toBe(DEFAULT_REVIEW_RATE_WINDOW_MS);
    expect(DEFAULT_REVIEW_RATE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("honors a positive integer override", () => {
    expect(reviewRateWindowMs({ MEDIA_REVIEW_RATE_WINDOW_MS: "3600000" })).toBe(
      3_600_000,
    );
  });

  it("falls back on empty / invalid / non-positive values", () => {
    expect(reviewRateWindowMs({ MEDIA_REVIEW_RATE_WINDOW_MS: "" })).toBe(
      DEFAULT_REVIEW_RATE_WINDOW_MS,
    );
    expect(reviewRateWindowMs({ MEDIA_REVIEW_RATE_WINDOW_MS: "banana" })).toBe(
      DEFAULT_REVIEW_RATE_WINDOW_MS,
    );
    expect(reviewRateWindowMs({ MEDIA_REVIEW_RATE_WINDOW_MS: "0" })).toBe(
      DEFAULT_REVIEW_RATE_WINDOW_MS,
    );
    expect(reviewRateWindowMs({ MEDIA_REVIEW_RATE_WINDOW_MS: "-5" })).toBe(
      DEFAULT_REVIEW_RATE_WINDOW_MS,
    );
  });
});

describe("reviewRateWindowStart", () => {
  it("is exactly now - window (deterministic with a pinned clock)", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");
    const start = reviewRateWindowStart(now, 60_000);
    expect(start.toISOString()).toBe("2026-07-05T11:59:00.000Z");
  });
});

describe("reviewRateWhere", () => {
  it("counts REVIEW and QUARANTINED, scoped to the tenant + window", () => {
    const start = new Date("2026-07-04T12:00:00.000Z");
    expect(reviewRateWhere("tenant-1", start)).toEqual({
      tenantId: "tenant-1",
      lifecycle: { in: ["REVIEW", "QUARANTINED"] },
      updatedAt: { gte: start },
    });
  });

  it("deliberately has NO deletedAt filter (delete-to-reset must not work)", () => {
    const where = reviewRateWhere("tenant-1", new Date());
    expect("deletedAt" in where).toBe(false);
  });

  it("counted lifecycles are exactly REVIEW + QUARANTINED (APPROVED/REJECTED never count)", () => {
    expect([...REVIEW_RATE_COUNTED_LIFECYCLES].sort()).toEqual([
      "QUARANTINED",
      "REVIEW",
    ]);
  });
});
