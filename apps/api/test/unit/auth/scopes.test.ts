/**
 * Invariant-locking suite for the core scope catalog and `hasScope`.
 *
 * Why this matters: `hasScope` is the single place set-inclusion is decided
 * for third-party grants. Every scope gate is a thin wrapper over it, so a
 * wrong answer here is an authorization bug everywhere at once, in the
 * permissive direction — and it fails silently, because a request that should
 * have been refused simply succeeds.
 *
 * The catalog tests exist for a different reason: the scope ids are strings
 * that appear in route metadata, in an extension's declarations and
 * eventually in tokens people hold. Nothing type-checks a scope string
 * against the catalog, so the conventions have to be locked here.
 */

import { describe, expect, it } from "vitest";
import { CORE_SCOPES, hasScope, type ScopeSet } from "../../../src/lib/auth/scopes.js";
import { ALL_CAPABILITIES } from "../../../src/lib/auth/capabilities.js";

const granted = (...scopes: string[]): ScopeSet => new Set(scopes);

describe("hasScope", () => {
  describe('"*" — an unscoped first-party session', () => {
    it("satisfies a single required scope", () => {
      expect(hasScope("*", ["posts:write"])).toBe(true);
    });

    it("satisfies several required scopes at once", () => {
      expect(hasScope("*", ["posts:write", "entities:write", "events:subscribe"])).toBe(true);
    });

    it("satisfies a scope that is not in the core catalog", () => {
      // An extension's vocabulary is not known to core, and a first-party
      // session must keep passing when a vertical adds one.
      expect(hasScope("*", ["walks:write"])).toBe(true);
    });

    it("satisfies an empty requirement", () => {
      expect(hasScope("*", [])).toBe(true);
    });
  });

  describe("the empty set — authenticated, granted nothing", () => {
    it("fails a non-empty requirement", () => {
      expect(hasScope(granted(), ["posts:read"])).toBe(false);
    });

    it("passes an empty requirement", () => {
      // "authenticated, no particular scope" — the `scopes: []` route state.
      expect(hasScope(granted(), [])).toBe(true);
    });

    it("is not confused with the first-party wildcard", () => {
      const empty: ScopeSet = granted();
      expect(empty).not.toBe("*");
      expect(hasScope(empty, ["posts:read"])).toBe(false);
      expect(hasScope("*", ["posts:read"])).toBe(true);
    });
  });

  describe("membership", () => {
    it("passes on an exact single match", () => {
      expect(hasScope(granted("posts:write"), ["posts:write"])).toBe(true);
    });

    it("passes when the grant is a superset of the requirement", () => {
      expect(hasScope(granted("posts:read", "posts:write", "profile:read"), ["posts:write"])).toBe(
        true,
      );
    });

    it("passes when every required scope is present", () => {
      expect(hasScope(granted("posts:read", "posts:write"), ["posts:read", "posts:write"])).toBe(
        true,
      );
    });

    it("fails when only some required scopes are present", () => {
      // The dangerous direction: a partial grant must not satisfy a
      // conjunction. All-of, never any-of.
      expect(hasScope(granted("posts:read"), ["posts:read", "posts:write"])).toBe(false);
    });

    it("fails on an unrelated grant", () => {
      expect(hasScope(granted("profile:read"), ["posts:write"])).toBe(false);
    });
  });

  describe("string matching is exact — no separator, prefix or wildcard rules", () => {
    it("does not accept the capability separator in place of the scope one", () => {
      // `posts.write` is the shape of a capability (a different, role-derived
      // authorization axis). It must never satisfy the scope `posts:write`.
      expect(hasScope(granted("posts.write"), ["posts:write"])).toBe(false);
    });

    it("does not accept the scope separator in place of the capability one", () => {
      expect(hasScope(granted("posts:write"), ["posts.write"])).toBe(false);
    });

    it("does not treat a resource prefix as covering its verbs", () => {
      expect(hasScope(granted("posts"), ["posts:write"])).toBe(false);
      expect(hasScope(granted("posts:"), ["posts:write"])).toBe(false);
    });

    it("does not implement a per-scope wildcard", () => {
      // Only the whole-principal `"*"` is a wildcard; `"posts:*"` is just an
      // unrecognised string.
      expect(hasScope(granted("posts:*"), ["posts:write"])).toBe(false);
    });

    it('does not treat a granted literal "*" inside a set as the wildcard', () => {
      // The wildcard is the ScopeSet value `"*"`, not a member of a set.
      expect(hasScope(granted("*"), ["posts:write"])).toBe(false);
    });

    it("is case-sensitive", () => {
      expect(hasScope(granted("Posts:Write"), ["posts:write"])).toBe(false);
    });

    it("does not trim whitespace", () => {
      expect(hasScope(granted("posts:write "), ["posts:write"])).toBe(false);
    });

    it("does not read a write grant as implying the matching read", () => {
      // There is deliberately no hierarchy: write does not imply read. A gate
      // that wants both must ask for both.
      expect(hasScope(granted("posts:write"), ["posts:read"])).toBe(false);
    });
  });

  describe("it does not mutate or consume its arguments", () => {
    it("leaves the granted set unchanged", () => {
      const set = new Set(["posts:read"]);
      hasScope(set, ["posts:write"]);
      expect([...set]).toEqual(["posts:read"]);
    });

    it("returns the same answer when asked twice", () => {
      const needed = ["posts:read"];
      expect(hasScope(granted("posts:read"), needed)).toBe(true);
      expect(hasScope(granted("posts:read"), needed)).toBe(true);
    });
  });
});

describe("CORE_SCOPES catalog", () => {
  const ids = Object.keys(CORE_SCOPES);

  it("contains exactly the seven core scopes", () => {
    // Locked, not derived: adding a scope is a contract change that should
    // require editing this list deliberately.
    expect(ids.sort()).toEqual(
      [
        "entities:read",
        "entities:write",
        "events:subscribe",
        "posts:read",
        "posts:write",
        "profile:read",
        "tenant:read",
      ].sort(),
    );
  });

  it("uses the <resource>:<verb> convention for every id", () => {
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every scope consent copy a person could read", () => {
    for (const [id, copy] of Object.entries(CORE_SCOPES)) {
      expect(copy, id).toMatch(/^[A-Z]/);
      expect(copy.length, id).toBeGreaterThan(10);
      // The copy describes what the client may do, not what it is called.
      expect(copy, id).not.toContain(id);
    }
  });

  it("has no duplicate consent copy", () => {
    // Two scopes described identically are indistinguishable on a consent
    // screen, which makes the grant meaningless.
    const copies = Object.values(CORE_SCOPES);
    expect(new Set(copies).size).toBe(copies.length);
  });

  it("every catalog scope satisfies itself and nothing else", () => {
    for (const id of ids) {
      expect(hasScope(new Set([id]), [id])).toBe(true);
      for (const other of ids.filter((o) => o !== id)) {
        expect(hasScope(new Set([id]), [other]), `${id} must not satisfy ${other}`).toBe(false);
      }
    }
  });
});

describe("scopes and capabilities stay separate vocabularies", () => {
  it("shares no string with the capability catalog", () => {
    // The two axes are checked by different gates. A value that appears in
    // both would let a reader assume one implies the other, which it does not.
    const capabilities = new Set<string>(ALL_CAPABILITIES);
    const overlap = Object.keys(CORE_SCOPES).filter((id) => capabilities.has(id));
    expect(overlap).toEqual([]);
  });

  it("no capability, colon-separated outlier included, satisfies a core scope", () => {
    // `ALL_CAPABILITIES` contains at least one colon-separated legacy value,
    // so "the separators differ" is not by itself sufficient protection —
    // exact matching is what actually holds the line.
    for (const capability of ALL_CAPABILITIES) {
      expect(
        hasScope(new Set<string>([capability]), Object.keys(CORE_SCOPES)),
        `${capability} must not satisfy the core catalog`,
      ).toBe(false);
    }
  });
});
