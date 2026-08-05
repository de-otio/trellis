/**
 * Unit Tests: the ActivityPub federation gate (V10)
 *
 * `mayFederatePost` is the single predicate behind all three delivery sites —
 * createPost, editPost and deliverSystemPostActivity. Those sites used to carry
 * their own conditions and disagreed: editPost checked `radius === "SHOUT"`,
 * the other two did not, so an ordinary WHISPER post was federated.
 *
 * These tests exist because federated delivery is IRREVOCABLE per post. A gate
 * that is wrong in the permissive direction cannot be repaired by a later fix —
 * the copies are already on remote servers. So the predicate is tested directly
 * and exhaustively over the radius domain, rather than only through the three
 * call sites (whose delivery blocks are fire-and-forget IIFEs).
 */

import { describe, expect, it } from "vitest";
import { mayFederatePost } from "../../src/lib/post-handler.js";

describe("mayFederatePost", () => {
  describe("radius", () => {
    it("permits SHOUT, the only fully-public radius", () => {
      expect(mayFederatePost({ radius: "SHOUT" })).toBe(true);
    });

    // The three that must never leave the server. NORMAL and WHISPER were
    // always intended to stay local; LOUD was addressed to the public
    // collection by a fail-open default in determineAudience.
    it.each(["NORMAL", "WHISPER", "LOUD"])(
      "refuses %s",
      (radius) => {
        expect(mayFederatePost({ radius })).toBe(false);
      },
    );

    it("refuses an unrecognised radius rather than assuming it is public", () => {
      expect(mayFederatePost({ radius: "NOT_A_RADIUS" })).toBe(false);
    });

    it("refuses a missing or null radius", () => {
      expect(mayFederatePost({})).toBe(false);
      expect(mayFederatePost({ radius: null })).toBe(false);
      expect(mayFederatePost({ radius: "" })).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("refuses a deleted post even when it is public", () => {
      expect(
        mayFederatePost({ radius: "SHOUT", deletedAt: new Date("2026-01-01") }),
      ).toBe(false);
    });

    it("refuses an author-hidden post even when it is public", () => {
      expect(mayFederatePost({ radius: "SHOUT", hiddenByAuthor: true })).toBe(
        false,
      );
    });

    it("permits a public post that is neither deleted nor hidden", () => {
      expect(
        mayFederatePost({
          radius: "SHOUT",
          deletedAt: null,
          hiddenByAuthor: false,
        }),
      ).toBe(true);
    });
  });

  // The property that matters more than any individual case: the gate is
  // closed by default. Anything the predicate does not explicitly recognise as
  // publishable must come back false, because the cost of a false positive is
  // an unrecallable disclosure and the cost of a false negative is a missing
  // post someone will report.
  describe("fails closed", () => {
    it("returns false for a nullish post", () => {
      // The create and system-delivery sites both pass the result of a
      // findUnique that can legitimately be null.
      expect(mayFederatePost(null)).toBe(false);
      expect(mayFederatePost(undefined)).toBe(false);
    });

    it("returns true for exactly one radius value and no other", () => {
      const domain = [
        "SHOUT",
        "LOUD",
        "NORMAL",
        "WHISPER",
        "shout",
        "PUBLIC",
        "public",
        "ALL",
        undefined,
        null,
        "",
      ];

      const permitted = domain.filter((radius) =>
        mayFederatePost({ radius: radius as string | null | undefined }),
      );

      expect(permitted).toEqual(["SHOUT"]);
    });
  });
});
