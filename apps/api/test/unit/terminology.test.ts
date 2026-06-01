import { beforeEach, describe, expect, it, vi } from "vitest";

// Must use vi.hoisted so the variable is available in the vi.mock factory
const { getExtensionMock } = vi.hoisted(() => ({
  getExtensionMock: vi.fn(),
}));

vi.mock("../../src/extensions", () => ({
  getExtension: getExtensionMock,
}));

import { getTerminology, getTerminologySync } from "../../src/lib/terminology.js";
import type { Terminology } from "../../src/lib/terminology.js";

const DEFAULT_TERMINOLOGY: Terminology = {
  entity: "entity",
  entityPlural: "entities",
  post: "post",
  profile: "profile",
  owner: "owner",
};

describe("getTerminology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("no entityType argument", () => {
    it("returns all five default fields exactly", () => {
      const result = getTerminology();
      expect(result).toEqual(DEFAULT_TERMINOLOGY);
    });

    it("does not call getExtension when no entityType is supplied", () => {
      getTerminology();
      expect(getExtensionMock).not.toHaveBeenCalled();
    });
  });

  describe("entityType given but extension is not registered", () => {
    it("returns defaults unchanged when getExtension returns undefined", () => {
      getExtensionMock.mockReturnValue(undefined);
      const result = getTerminology("gadget");
      expect(result).toEqual(DEFAULT_TERMINOLOGY);
    });

    it("calls getExtension with the supplied entityType", () => {
      getExtensionMock.mockReturnValue(undefined);
      getTerminology("gadget");
      expect(getExtensionMock).toHaveBeenCalledOnce();
      expect(getExtensionMock).toHaveBeenCalledWith("gadget");
    });
  });

  describe("entityType given and extension is registered", () => {
    it("overrides entity and entityPlural from the extension terminology", () => {
      getExtensionMock.mockReturnValue({
        id: "widget",
        terminology: { entity: "widget", entityPlural: "widgets" },
      });
      const result = getTerminology("widget");
      expect(result.entity).toBe("widget");
      expect(result.entityPlural).toBe("widgets");
    });

    it("keeps the default post/profile/owner fields unchanged", () => {
      getExtensionMock.mockReturnValue({
        id: "widget",
        terminology: { entity: "widget", entityPlural: "widgets" },
      });
      const result = getTerminology("widget");
      expect(result.post).toBe("post");
      expect(result.profile).toBe("profile");
      expect(result.owner).toBe("owner");
    });

    it("ignores any extra terminology fields the extension might provide (e.g. post)", () => {
      // An extension that also sets `post` must NOT change the result's post field —
      // the source only spreads entity + entityPlural explicitly.
      getExtensionMock.mockReturnValue({
        id: "gadget",
        terminology: { entity: "gadget", entityPlural: "gadgets", post: "update" },
      });
      const result = getTerminology("gadget");
      expect(result.post).toBe("post");
    });
  });

  describe("immutability — returned object is a fresh spread", () => {
    it("mutating a result from an extension call does not affect the next default call", () => {
      getExtensionMock.mockReturnValue({
        id: "widget",
        terminology: { entity: "widget", entityPlural: "widgets" },
      });
      const result = getTerminology("widget");
      // Mutate the returned object
      (result as any).post = "MUTATED";

      // Subsequent call without entityType must still return defaults
      const fresh = getTerminology();
      expect(fresh.post).toBe("post");
    });

    it("two extension calls return distinct object references", () => {
      getExtensionMock.mockReturnValue({
        id: "widget",
        terminology: { entity: "widget", entityPlural: "widgets" },
      });
      const a = getTerminology("widget");
      const b = getTerminology("widget");
      // Each call with a matching extension spreads a new object
      expect(Object.is(a, b)).toBe(false);
    });

    // Regression guard: the fallback path (no entityType / unregistered
    // extension) must return a FRESH copy, never the shared DEFAULT_TERMINOLOGY
    // constant — otherwise a caller mutating its result corrupts every later
    // call. (Fixed in terminology.ts: the fallback now spreads.)
    it("no-arg calls return distinct objects, not the shared default constant", () => {
      const a = getTerminology();
      const b = getTerminology();
      expect(Object.is(a, b)).toBe(false);
      expect(a).toEqual(b);
    });

    it("mutating a no-arg result does not corrupt a subsequent default call", () => {
      getExtensionMock.mockReturnValue(undefined);
      const first = getTerminology("gadget");
      (first as any).owner = "MUTATED";
      const second = getTerminology();
      expect(second.owner).toBe("owner");
    });
  });
});

describe("getTerminologySync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the same defaults as getTerminology when called without entityType", () => {
    const sync = getTerminologySync();
    const async_ = getTerminology();
    expect(sync).toEqual(async_);
  });

  it("delegates to getTerminology — returns extension entity/entityPlural when registered", () => {
    getExtensionMock.mockReturnValue({
      id: "widget",
      terminology: { entity: "widget", entityPlural: "widgets" },
    });
    const result = getTerminologySync("widget");
    expect(result.entity).toBe("widget");
    expect(result.entityPlural).toBe("widgets");
    expect(result.post).toBe("post");
  });

  it("delegates to getTerminology — returns defaults for unknown entityType", () => {
    getExtensionMock.mockReturnValue(undefined);
    const result = getTerminologySync("unknown");
    expect(result).toEqual(DEFAULT_TERMINOLOGY);
  });
});
