/**
 * Unit Tests: require.ts — role and capability gating
 */

import { describe, expect, it } from "vitest";
import { requireRole, requireCapability, Capability, RoleGrants } from "../../../src/lib/auth/require.js";
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
