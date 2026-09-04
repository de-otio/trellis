/**
 * Unit Tests: require.ts — role and capability gating
 */

import { describe, expect, it } from "vitest";
import {
  requireRole,
  requireCapability,
  requireScope,
  InsufficientScopeError,
  Capability,
  RoleGrants,
} from "../../../src/lib/auth/require.js";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { TenantRole, UserRole } from "@prisma/client";

function makeAuth(tenantRole: TenantRole, globalRole: UserRole = "B2B_PARTNER"): AuthContext {
  return {
    cognitoSub: "sub",
    userId: "uid",
    globalRole,
    activeTenantId: "tid",
    tenantSlug: "slug",
    tenantRole,
    handle: "user",
    membershipsLoader: async () => [],
  };
}

describe("requireRole", () => {
  it("passes when caller has exact required role", () => {
    expect(requireRole(makeAuth("ADMIN"), "ADMIN")).toBeNull();
  });

  it("passes when caller has higher role", () => {
    expect(requireRole(makeAuth("OWNER"), "ADMIN")).toBeNull();
    expect(requireRole(makeAuth("OWNER"), "MEMBER")).toBeNull();
    expect(requireRole(makeAuth("ADMIN"), "MEMBER")).toBeNull();
  });

  it("returns 403 when caller has lower role", () => {
    const r = requireRole(makeAuth("MEMBER"), "ADMIN");
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });

  it("returns 403 for GUEST requiring MEMBER", () => {
    const r = requireRole(makeAuth("GUEST"), "MEMBER");
    expect(r!.status).toBe(403);
  });

  it("bypasses for SUPER_ADMIN regardless of tenant role", () => {
    expect(requireRole(makeAuth("GUEST", "SUPER_ADMIN"), "OWNER")).toBeNull();
  });
});

describe("requireCapability", () => {
  it("passes when role has the capability", () => {
    expect(requireCapability(makeAuth("OWNER"), Capability.TenantUpdate)).toBeNull();
    expect(requireCapability(makeAuth("ADMIN"), Capability.MemberInvite)).toBeNull();
    expect(requireCapability(makeAuth("MEMBER"), Capability.PostCreate)).toBeNull();
  });

  it("returns 403 when role lacks the capability", () => {
    const r = requireCapability(makeAuth("MEMBER"), Capability.TenantUpdate);
    expect(r!.status).toBe(403);
  });

  it("returns 403 for GUEST on MEMBER-only capabilities", () => {
    expect(requireCapability(makeAuth("GUEST"), Capability.PostCreate)!.status).toBe(403);
  });

  it("bypasses for SUPER_ADMIN", () => {
    expect(requireCapability(makeAuth("GUEST", "SUPER_ADMIN"), Capability.TenantDelete)).toBeNull();
  });

  it("OWNER has TenantDelete and TenantSuspend; ADMIN does not", () => {
    expect(requireCapability(makeAuth("OWNER"), Capability.TenantDelete)).toBeNull();
    expect(requireCapability(makeAuth("ADMIN"), Capability.TenantDelete)!.status).toBe(403);
    expect(requireCapability(makeAuth("OWNER"), Capability.TenantSuspend)).toBeNull();
    expect(requireCapability(makeAuth("ADMIN"), Capability.TenantSuspend)!.status).toBe(403);
  });
});

describe("RoleGrants", () => {
  it("OWNER grants are a superset of ADMIN grants", () => {
    for (const cap of RoleGrants.ADMIN) {
      expect(RoleGrants.OWNER.has(cap)).toBe(true);
    }
  });

  it("ADMIN grants are a superset of MEMBER grants", () => {
    for (const cap of RoleGrants.MEMBER) {
      expect(RoleGrants.ADMIN.has(cap)).toBe(true);
    }
  });

  it("MEMBER grants are a superset of GUEST grants", () => {
    for (const cap of RoleGrants.GUEST) {
      expect(RoleGrants.MEMBER.has(cap)).toBe(true);
    }
  });
});

/**
 * requireScope — the delegated-authority gate (plan 034 lane A).
 *
 * These are the semantics an over-permissive implementation would quietly
 * get wrong, so each rule is asserted from both sides.
 */
describe("requireScope", () => {
  const granted = (...scopes: string[]) => ({ scopes: new Set(scopes) });

  describe("passes", () => {
    it('passes everything for a first-party session ("*")', () => {
      expect(() => requireScope({ scopes: "*" }, ["posts:write"])).not.toThrow();
      expect(() =>
        requireScope({ scopes: "*" }, ["posts:write", "entities:write"]),
      ).not.toThrow();
    });

    it("treats an absent scopes field as first-party — the documented default", () => {
      expect(() => requireScope({}, ["posts:write"])).not.toThrow();
    });

    it("passes an empty requirement for any principal, including the empty set", () => {
      expect(() => requireScope(granted(), [])).not.toThrow();
      expect(() => requireScope(granted("profile:read"), [])).not.toThrow();
      expect(() => requireScope({ scopes: "*" }, [])).not.toThrow();
    });

    it("passes when every needed scope is held", () => {
      expect(() => requireScope(granted("posts:write"), ["posts:write"])).not.toThrow();
      expect(() =>
        requireScope(granted("posts:write", "posts:read", "profile:read"), [
          "posts:read",
          "posts:write",
        ]),
      ).not.toThrow();
    });
  });

  describe("throws", () => {
    it("throws for the empty set against a real requirement", () => {
      expect(() => requireScope(granted(), ["posts:write"])).toThrow(
        InsufficientScopeError,
      );
    });

    it("throws when only some of the needed scopes are held", () => {
      expect(() =>
        requireScope(granted("posts:read"), ["posts:read", "posts:write"]),
      ).toThrow(InsufficientScopeError);
    });

    it("does not accept the capability separator in place of the scope one", () => {
      // `posts.write` is a capability string; it must never satisfy a scope.
      expect(() => requireScope(granted("posts.write"), ["posts:write"])).toThrow(
        InsufficientScopeError,
      );
    });

    it("does not treat a scope as a prefix of another", () => {
      expect(() => requireScope(granted("posts:writeall"), ["posts:write"])).toThrow(
        InsufficientScopeError,
      );
      expect(() => requireScope(granted("posts"), ["posts:write"])).toThrow(
        InsufficientScopeError,
      );
    });

    it("is NOT bypassed by SUPER_ADMIN — scopes are a different axis to roles", () => {
      const admin = { ...makeAuth("OWNER", "SUPER_ADMIN"), scopes: new Set<string>() };
      expect(() => requireScope(admin, ["posts:write"])).toThrow(
        InsufficientScopeError,
      );
    });
  });

  describe("the 403 it renders", () => {
    async function bodyOf(needed: string[], held: string[] = []) {
      try {
        requireScope({ scopes: new Set(held) }, needed);
      } catch (error) {
        const response = (error as InsufficientScopeError).toResponse();
        return { status: response.status, body: await response.json() };
      }
      throw new Error("requireScope did not throw");
    }

    it("is 403, not 401 — the caller is authenticated, just not permitted", async () => {
      expect((await bodyOf(["posts:write"])).status).toBe(403);
    });

    it("uses the standard envelope and names the missing scope literally", async () => {
      const { body } = await bodyOf(["walks:write"]);
      expect(body).toEqual({
        error: "INSUFFICIENT_SCOPE",
        message:
          "This operation requires the `walks:write` scope, which this credential was not granted.",
        remediation:
          "Request the `walks:write` scope and have the user re-authorize.",
      });
    });

    it("names every missing scope, not just the first", async () => {
      const { body } = await bodyOf(
        ["posts:read", "posts:write", "events:subscribe"],
        ["posts:read"],
      );
      expect(body.remediation).toBe(
        "Request the `posts:write` and `events:subscribe` scopes and have the user re-authorize.",
      );
    });

    it("reports only what is actually missing", () => {
      try {
        requireScope({ scopes: new Set(["posts:read"]) }, ["posts:read", "posts:write"]);
        throw new Error("requireScope did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientScopeError);
        expect((error as InsufficientScopeError).missing).toEqual(["posts:write"]);
      }
    });
  });
});
