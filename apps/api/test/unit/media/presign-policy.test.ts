/**
 * Unit + property tests for the presigned-upload planner (T14).
 *
 * The planner is the pure gate in front of every presigned grant. Its safety
 * properties (AR-SEC surface):
 *  - every plan carries content-length-range [1, maxBytes] (the byte rail),
 *  - the key is EXACTLY pending/{tenantId}/{sessionId} (prefix-confined,
 *    validated by the cas-keys anchored allowlists, never cas/),
 *  - only allowlisted video/audio types plan (images/other types refuse),
 *  - expiry is clamped to [60, 3600] seconds,
 *  - every refusal is typed and fail-closed (no partial grants).
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  planPresignedUpload,
  presignByteCap,
  normalizeMimeType,
  MIN_PRESIGN_EXPIRY_SECONDS,
  MAX_PRESIGN_EXPIRY_SECONDS,
  type PresignPlanInput,
} from "../../../src/lib/media/presign-policy.js";

const TENANT = "ctenant0000000000000000aa";
const SESSION = "csession000000000000000aa";

const BASE: PresignPlanInput = {
  tenantId: TENANT,
  sessionId: SESSION,
  declaredMimeType: "video/mp4",
  declaredBytes: 5_000_000,
  maxBytes: 200_000_000,
  allowlist: ["video/mp4", "video/webm", "video/quicktime"],
  expirySeconds: 900,
};

const FC = { seed: 0x714, numRuns: 500 } as const;

describe("planPresignedUpload — grants", () => {
  it("plans an exact pending/ key, exact Content-Type, and the byte rail", () => {
    const plan = planPresignedUpload(BASE);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.key).toBe(`pending/${TENANT}/${SESSION}`);
    expect(plan.contentType).toBe("video/mp4");
    expect(plan.contentLengthRange).toEqual({ min: 1, max: 200_000_000 });
    expect(plan.expirySeconds).toBe(900);
  });

  it("normalizes the declared MIME (parameters stripped, lowercased)", () => {
    const plan = planPresignedUpload({
      ...BASE,
      declaredMimeType: "Video/MP4; codecs=avc1",
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.contentType).toBe("video/mp4");
  });

  it("property: every grant's key is under pending/ and NEVER under cas/", () => {
    const cuidArb = fc
      .string({
        unit: fc.constantFrom(..."0123456789abcdefghijklmnopqrstuvwxyz".split("")),
        minLength: 24,
        maxLength: 24,
      })
      .map((s) => `c${s}`);
    fc.assert(
      fc.property(cuidArb, cuidArb, (tenantId, sessionId) => {
        const plan = planPresignedUpload({ ...BASE, tenantId, sessionId });
        expect(plan.ok).toBe(true);
        if (plan.ok) {
          expect(plan.key.startsWith("pending/")).toBe(true);
          expect(plan.key.startsWith("cas/")).toBe(false);
          expect(plan.key).toBe(`pending/${tenantId}/${sessionId}`);
        }
      }),
      FC,
    );
  });

  it("property: the byte rail max always equals the configured cap (never the declared size)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (declaredBytes, maxBytes) => {
          const plan = planPresignedUpload({ ...BASE, declaredBytes, maxBytes });
          if (plan.ok) {
            expect(plan.contentLengthRange.min).toBe(1);
            expect(plan.contentLengthRange.max).toBe(maxBytes);
            expect(declaredBytes).toBeLessThanOrEqual(maxBytes);
          } else {
            // The only refusal for valid positive ints is over-cap.
            expect(plan.reason).toBe("declared-bytes-over-cap");
            expect(declaredBytes).toBeGreaterThan(maxBytes);
          }
        },
      ),
      FC,
    );
  });

  it("property: expiry is always clamped to [MIN, MAX] regardless of input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -100000, max: 100000 }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ),
        (expirySeconds) => {
          const plan = planPresignedUpload({ ...BASE, expirySeconds });
          expect(plan.ok).toBe(true);
          if (plan.ok) {
            expect(plan.expirySeconds).toBeGreaterThanOrEqual(
              MIN_PRESIGN_EXPIRY_SECONDS,
            );
            expect(plan.expirySeconds).toBeLessThanOrEqual(
              MAX_PRESIGN_EXPIRY_SECONDS,
            );
          }
        },
      ),
      FC,
    );
  });
});

describe("planPresignedUpload — refusals (fail-closed)", () => {
  it("refuses images (sync path only) even when allowlisted", () => {
    const plan = planPresignedUpload({
      ...BASE,
      declaredMimeType: "image/jpeg",
      allowlist: ["image/jpeg"],
    });
    expect(plan).toEqual({ ok: false, reason: "unsupported-type" });
  });

  it("refuses a video type that is not in the operator allowlist", () => {
    const plan = planPresignedUpload({
      ...BASE,
      declaredMimeType: "video/x-matroska",
    });
    expect(plan).toEqual({ ok: false, reason: "unsupported-type" });
  });

  it("refuses unknown/empty/garbage MIME types", () => {
    for (const mime of ["", "application/pdf", "video/", "not-a-mime", "text/html"]) {
      const plan = planPresignedUpload({ ...BASE, declaredMimeType: mime });
      expect(plan.ok).toBe(false);
    }
  });

  it("refuses non-positive / non-integer / non-finite declared sizes", () => {
    for (const declaredBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planPresignedUpload({ ...BASE, declaredBytes });
      expect(plan).toEqual({ ok: false, reason: "invalid-declared-bytes" });
    }
  });

  it("refuses a declared size over the cap", () => {
    const plan = planPresignedUpload({
      ...BASE,
      declaredBytes: BASE.maxBytes + 1,
    });
    expect(plan).toEqual({ ok: false, reason: "declared-bytes-over-cap" });
  });

  it("refuses a misconfigured cap (fail-closed on operator error)", () => {
    for (const maxBytes of [0, -5, Number.NaN, 1.2]) {
      const plan = planPresignedUpload({ ...BASE, maxBytes });
      expect(plan).toEqual({ ok: false, reason: "invalid-cap" });
    }
  });

  it("refuses malformed tenant/session ids (anchored allowlists — no traversal)", () => {
    for (const bad of ["../../etc", "tenant", "c" + "A".repeat(24), ""]) {
      expect(planPresignedUpload({ ...BASE, tenantId: bad })).toEqual({
        ok: false,
        reason: "invalid-key-inputs",
      });
      expect(planPresignedUpload({ ...BASE, sessionId: bad })).toEqual({
        ok: false,
        reason: "invalid-key-inputs",
      });
    }
  });
});

describe("normalizeMimeType", () => {
  it("strips parameters, trims, lowercases; empty for junk", () => {
    expect(normalizeMimeType("Video/MP4; codecs=avc1")).toBe("video/mp4");
    expect(normalizeMimeType("  video/webm  ")).toBe("video/webm");
    expect(normalizeMimeType("")).toBe("");
    expect(normalizeMimeType(null as unknown as string)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// presignByteCap (AR-SEC F2)
// ---------------------------------------------------------------------------

describe("presignByteCap (AR-SEC F2 — combined track budgets)", () => {
  const budgets = { video: 200_000_000, audio: 100_000_000 };

  it("video = the COMBINED video+audio track budgets (a muxed file carries both)", () => {
    expect(presignByteCap("video", budgets)).toBe(300_000_000);
  });

  it("audio = the single audio-track budget", () => {
    expect(presignByteCap("audio", budgets)).toBe(100_000_000);
  });

  it("stays SSM-driven: scales with the injected budgets, no floor/ceiling literal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 40 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        (video, audio) => {
          expect(presignByteCap("video", { video, audio })).toBe(video + audio);
          expect(presignByteCap("audio", { video, audio })).toBe(audio);
        },
      ),
    );
  });
});
