/**
 * Property and unit tests for moderation-resolved-payload.
 *
 * Critical obligations under test:
 * 1. "ready" if and only if status === "APPROVED".
 * 2. Every non-APPROVED status produces "not-ready".
 * 3. The returned object has exactly the keys {mediaId, status} — no extras.
 * 4. PENDING / REVIEW / QUARANTINED / REJECTED are indistinguishable in the
 *    output (the anti-oracle property).
 * 5. mediaId is faithfully echoed.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  moderationResolvedPayload,
  type ModerationResolvedPayload,
} from "../../../src/lib/media/moderation-resolved-payload.js";
import {
  ALL_MODERATION_STATUSES,
  type ModerationStatus,
} from "../../../src/lib/media/moderation-status.js";

// ---------------------------------------------------------------------------
// Exhaustive unit tests over every known ModerationStatus
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — exhaustive status coverage", () => {
  it("returns ready for APPROVED", () => {
    const p = moderationResolvedPayload("m1", "APPROVED");
    expect(p.status).toBe("ready");
  });

  const nonApproved: ModerationStatus[] = ALL_MODERATION_STATUSES.filter(
    (s) => s !== "APPROVED",
  );

  it.each(nonApproved)(
    "returns not-ready for %s",
    (status: ModerationStatus) => {
      const p = moderationResolvedPayload("m1", status);
      expect(p.status).toBe("not-ready");
    },
  );
});

// ---------------------------------------------------------------------------
// mediaId is faithfully echoed
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — mediaId passthrough", () => {
  it("echoes an arbitrary mediaId unchanged", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const p = moderationResolvedPayload(id, "APPROVED");
        return p.mediaId === id;
      }),
    );
  });

  it("echoes mediaId unchanged regardless of status", () => {
    const statusArb = fc.constantFrom(...ALL_MODERATION_STATUSES);
    fc.assert(
      fc.property(fc.string(), statusArb, (id, status) => {
        const p = moderationResolvedPayload(id, status);
        return p.mediaId === id;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Anti-oracle: payload carries exactly {mediaId, status}
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — anti-oracle: exact key set", () => {
  it("has exactly two keys for APPROVED", () => {
    const p = moderationResolvedPayload("x", "APPROVED");
    expect(Object.keys(p).sort()).toEqual(["mediaId", "status"]);
  });

  it("has exactly two keys for every status (property)", () => {
    const statusArb = fc.constantFrom(...ALL_MODERATION_STATUSES);
    fc.assert(
      fc.property(fc.string(), statusArb, (id, status) => {
        const p = moderationResolvedPayload(id, status);
        const keys = Object.keys(p).sort();
        return keys.length === 2 && keys[0] === "mediaId" && keys[1] === "status";
      }),
    );
  });

  it("carries no decision field", () => {
    const p = moderationResolvedPayload("x", "APPROVED") as Record<string, unknown>;
    expect(p["decision"]).toBeUndefined();
  });

  it("carries no labels field", () => {
    const p = moderationResolvedPayload("x", "QUARANTINED") as Record<string, unknown>;
    expect(p["labels"]).toBeUndefined();
  });

  it("carries no confidence field", () => {
    const p = moderationResolvedPayload("x", "REVIEW") as Record<string, unknown>;
    expect(p["confidence"]).toBeUndefined();
  });

  it("carries no reason field", () => {
    const p = moderationResolvedPayload("x", "REJECTED") as Record<string, unknown>;
    expect(p["reason"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anti-oracle: non-APPROVED statuses are indistinguishable
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — anti-oracle: non-APPROVED collapse", () => {
  it("PENDING and REVIEW produce identical payloads for the same mediaId", () => {
    const a = moderationResolvedPayload("abc", "PENDING");
    const b = moderationResolvedPayload("abc", "REVIEW");
    expect(a).toEqual(b);
  });

  it("REVIEW and QUARANTINED produce identical payloads for the same mediaId", () => {
    const a = moderationResolvedPayload("abc", "REVIEW");
    const b = moderationResolvedPayload("abc", "QUARANTINED");
    expect(a).toEqual(b);
  });

  it("QUARANTINED and REJECTED produce identical payloads for the same mediaId", () => {
    const a = moderationResolvedPayload("abc", "QUARANTINED");
    const b = moderationResolvedPayload("abc", "REJECTED");
    expect(a).toEqual(b);
  });

  it("all non-APPROVED statuses produce the same payload (property)", () => {
    const nonApproved = ALL_MODERATION_STATUSES.filter((s) => s !== "APPROVED");
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom(...nonApproved),
        fc.constantFrom(...nonApproved),
        (id, s1, s2) => {
          const p1 = moderationResolvedPayload(id, s1);
          const p2 = moderationResolvedPayload(id, s2);
          // Both must equal { mediaId: id, status: "not-ready" }
          return (
            p1.status === "not-ready" &&
            p2.status === "not-ready" &&
            p1.mediaId === id &&
            p2.mediaId === id
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Binary partition: APPROVED => ready, everything else => not-ready
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — binary partition property", () => {
  it("status is ready iff input status is APPROVED (property over all statuses)", () => {
    const statusArb = fc.constantFrom(...ALL_MODERATION_STATUSES);
    fc.assert(
      fc.property(fc.string(), statusArb, (id, status) => {
        const p = moderationResolvedPayload(id, status);
        const expectedReady = status === "APPROVED";
        return (
          (expectedReady && p.status === "ready") ||
          (!expectedReady && p.status === "not-ready")
        );
      }),
    );
  });

  it("status is never a value outside {ready, not-ready} (property)", () => {
    const statusArb = fc.constantFrom(...ALL_MODERATION_STATUSES);
    fc.assert(
      fc.property(fc.string(), statusArb, (id, status) => {
        const p = moderationResolvedPayload(id, status);
        return p.status === "ready" || p.status === "not-ready";
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural type sanity (compile-time enforced, but belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("moderationResolvedPayload — return type shape", () => {
  it("satisfies the ModerationResolvedPayload interface for APPROVED", () => {
    const p: ModerationResolvedPayload = moderationResolvedPayload("id-1", "APPROVED");
    expect(p.mediaId).toBe("id-1");
    expect(p.status).toBe("ready");
  });

  it("satisfies the ModerationResolvedPayload interface for REJECTED", () => {
    const p: ModerationResolvedPayload = moderationResolvedPayload("id-2", "REJECTED");
    expect(p.mediaId).toBe("id-2");
    expect(p.status).toBe("not-ready");
  });
});
