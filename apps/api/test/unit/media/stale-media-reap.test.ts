/**
 * stale-media-reap tests — the shared reap scope both stale-media reapers
 * (lambda/hourly-cron.ts and lib/scheduled/media-stale-cleanup.ts) bind to
 * (AR4). Behavioral survives/reaped scenarios live in those reapers' own
 * suites; this file pins the helper's contract: the window resolution, the
 * cutoff arithmetic, and the exact where shape.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_MEDIA_REAP_WINDOW_MS,
  REAPABLE_LIFECYCLES,
  staleMediaReapCutoff,
  staleMediaReapWhere,
  staleMediaReapWindowMs,
} from "../../../src/lib/media/stale-media-reap.js";

describe("staleMediaReapWindowMs", () => {
  it("defaults to 24h — a window ≫ the moderation SLA (the pre-AR4 1h window reaped queue-delayed uploads)", () => {
    expect(staleMediaReapWindowMs({})).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_STALE_MEDIA_REAP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("honors a positive MEDIA_STALE_REAP_WINDOW_MS override", () => {
    expect(
      staleMediaReapWindowMs({ MEDIA_STALE_REAP_WINDOW_MS: "7200000" }),
    ).toBe(7200000);
  });

  it("falls back to the default for absent/empty/invalid/non-positive overrides (never a zero or negative window)", () => {
    for (const raw of [undefined, "", "not-a-number", "0", "-1", "NaN", "Infinity"]) {
      expect(
        staleMediaReapWindowMs({ MEDIA_STALE_REAP_WINDOW_MS: raw }),
      ).toBe(DEFAULT_STALE_MEDIA_REAP_WINDOW_MS);
    }
  });
});

describe("staleMediaReapCutoff", () => {
  it("is `now - window` (pinned clock)", () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    expect(staleMediaReapCutoff(now, 3600000).toISOString()).toBe(
      "2026-07-04T11:00:00.000Z",
    );
  });
});

describe("staleMediaReapWhere", () => {
  it("scopes to non-verdict lifecycles, the age cutoff, AND zero moderation jobs", () => {
    const cutoff = new Date("2026-07-03T12:00:00.000Z");

    expect(staleMediaReapWhere(cutoff)).toEqual({
      lifecycle: { in: ["AWAITING_UPLOAD", "UPLOADED", "UPLOAD_FAILED"] },
      createdAt: { lt: cutoff },
      // Prisma relation filter: `none: {}` = the row has NO MediaModerationJob
      // at all. Deliberately stricter than "no OPEN job": a resolved job with a
      // still-UPLOADED lifecycle means the completion worker did not finish —
      // deleting would destroy a possibly-approved object + its moderation
      // audit records.
      moderationJobs: { none: {} },
    });
    expect(REAPABLE_LIFECYCLES).toEqual([
      "AWAITING_UPLOAD",
      "UPLOADED",
      "UPLOAD_FAILED",
    ]);
  });

  it("verdict states are NEVER reap candidates", () => {
    for (const verdict of ["APPROVED", "REVIEW", "QUARANTINED", "REJECTED"]) {
      expect(REAPABLE_LIFECYCLES).not.toContain(verdict);
    }
  });

  it("returns a fresh, caller-mutable object per call (safe to spread into a deleteMany where)", () => {
    const cutoff = new Date();
    const a = staleMediaReapWhere(cutoff);
    const b = staleMediaReapWhere(cutoff);
    expect(a).not.toBe(b);
    a.lifecycle.in.push("APPROVED");
    expect(b.lifecycle.in).toEqual([
      "AWAITING_UPLOAD",
      "UPLOADED",
      "UPLOAD_FAILED",
    ]);
  });
});
