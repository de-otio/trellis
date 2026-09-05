/**
 * Unit Tests: owner-scoped media disposition (spec 07 §4.1 / §9).
 *
 * Anti-oracle: non-owner AND not-found return an IDENTICAL 404. The response is
 * coarse: only { status, appealable } — never category/label/confidence/class.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

const mockDb = { mediaFile: { findUnique: vi.fn() } };
vi.mock("../../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

import {
  ModerationDispositionHandler,
  computeDisposition,
} from "../../../src/lib/compliance/moderation-disposition.js";

const env = { DEFAULT_REGION: "EU" } as unknown as Env;
const requestContext = { region: "EU" } as any;
const OWNER = "owner-1";
const session = { userId: OWNER, email: "o@example.com" } as any;

describe("computeDisposition (pure)", () => {
  it("APPROVED + visible → approved, not appealable", () => {
    expect(
      computeDisposition({ lifecycle: "APPROVED", hidden: false, deletedAt: null, blockClass: null }),
    ).toEqual({ status: "approved", appealable: false });
  });
  it("APPROVED but hidden → blocked", () => {
    expect(
      computeDisposition({ lifecycle: "APPROVED", hidden: true, deletedAt: null, blockClass: "lawful-flagged" }),
    ).toEqual({ status: "blocked", appealable: true });
  });
  it("pre-verdict states → pending", () => {
    expect(
      computeDisposition({ lifecycle: "UPLOADED", hidden: false, deletedAt: null, blockClass: null }),
    ).toEqual({ status: "pending", appealable: false });
  });
  it("blocked lawful → appealable true", () => {
    expect(
      computeDisposition({ lifecycle: "QUARANTINED", hidden: false, deletedAt: null, blockClass: "lawful-flagged" }),
    ).toEqual({ status: "blocked", appealable: true });
  });
  it("blocked illegal → appealable FALSE (carve-out)", () => {
    expect(
      computeDisposition({ lifecycle: "REJECTED", hidden: false, deletedAt: null, blockClass: "illegal-suspected" }),
    ).toEqual({ status: "blocked", appealable: false });
  });

  /**
   * A3 (quality sweep 2026-09-05). `isAppealable(null)` is deliberately `true`
   * — media illegal-class detection is a known gap, so a blocked-but-
   * unclassified item gets the lawful appeal path. That default is right for an
   * item nobody classified, and wrong for the window in which the carve-out has
   * hidden, preserved and HELD an item but not yet written its class. The hold
   * is what tells the two apart: ordinary moderation never places one.
   */
  describe("evidence hold is the backstop for a null block class", () => {
    it("blocked + evidence hold + NULL class → appealable FALSE", () => {
      expect(
        computeDisposition({
          lifecycle: "REJECTED", hidden: true, deletedAt: null,
          blockClass: null, evidenceHold: true,
        }),
      ).toEqual({ status: "blocked", appealable: false });
    });

    it("blocked + no hold + NULL class → appealable TRUE (the default is preserved)", () => {
      expect(
        computeDisposition({
          lifecycle: "REJECTED", hidden: true, deletedAt: null,
          blockClass: null, evidenceHold: false,
        }),
      ).toEqual({ status: "blocked", appealable: true });
    });

    it("an absent evidenceHold reads as no hold — ordinary items are unaffected", () => {
      expect(
        computeDisposition({
          lifecycle: "QUARANTINED", hidden: false, deletedAt: null, blockClass: "lawful-flagged",
        }),
      ).toEqual({ status: "blocked", appealable: true });
    });

    it("a hold does not turn an approved or pending item into a blocked one", () => {
      expect(
        computeDisposition({
          lifecycle: "APPROVED", hidden: false, deletedAt: null,
          blockClass: null, evidenceHold: true,
        }),
      ).toEqual({ status: "approved", appealable: false });
      expect(
        computeDisposition({
          lifecycle: "UPLOADED", hidden: false, deletedAt: null,
          blockClass: null, evidenceHold: true,
        }),
      ).toEqual({ status: "pending", appealable: false });
    });
  });
});

describe("ModerationDispositionHandler.handleGet", () => {
  let handler: ModerationDispositionHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ModerationDispositionHandler();
  });

  it("owner gets a coarse verdict with ONLY status + appealable", async () => {
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      lifecycle: "QUARANTINED",
      hidden: false,
      deletedAt: null,
      blockClass: "lawful-flagged",
    });
    const res = await handler.handleGet("m1", session, env, requestContext);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "blocked", appealable: true });
    // No leakage of any classifier detail.
    for (const k of ["category", "label", "labels", "confidence", "blockClass", "provider", "decision"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("illegal-class owner item → appealable:false", async () => {
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: OWNER,
      lifecycle: "REJECTED",
      hidden: true,
      deletedAt: null,
      blockClass: "illegal-suspected",
    });
    const res = await handler.handleGet("m1", session, env, requestContext);
    const body = await res.json();
    expect(body).toEqual({ status: "blocked", appealable: false });
  });

  it("NON-owner → 404 identical to not-found (anti-oracle)", async () => {
    mockDb.mediaFile.findUnique.mockResolvedValue({
      uploadedBy: "someone-else",
      lifecycle: "QUARANTINED",
      hidden: false,
      deletedAt: null,
      blockClass: "illegal-suspected",
    });
    const nonOwner = await handler.handleGet("m1", session, env, requestContext);

    mockDb.mediaFile.findUnique.mockResolvedValue(null);
    const notFound = await handler.handleGet("m1", session, env, requestContext);

    expect(nonOwner.status).toBe(404);
    expect(notFound.status).toBe(404);
    expect(await nonOwner.json()).toEqual(await notFound.json());
  });
});
