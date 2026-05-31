/**
 * Unit tests — requireCapability + requireRole.
 *
 * Covers:
 *  - SUPER_ADMIN bypass on every capability.
 *  - Role-rank gates via requireRole.
 *  - Resource-scoping for own-only capabilities (PostUpdate, PostDelete,
 *    EntityUpdate, EntityDelete) — owner OK, non-owner blocked unless caller
 *    holds the cross-user `post.moderate` capability.
 *  - 422-style messages and 403 status codes.
 *  - Single-OWNER invariant: `resolveTenantRole` does not produce OWNER from
 *    any combination of mappings or default-role values.
 */

import { describe, expect, it } from "vitest";
import type { TenantRole, UserRole } from "@prisma/client";
import {
  requireCapability,
  requireRole,
  Capability,
} from "../../src/lib/auth/require.js";
import type { AuthContext } from "../../src/lib/auth/auth-context.js";
import { resolveTenantRole } from "../../src/lib/tenant/resolve-role.js";

function makeAuth(
  tenantRole: TenantRole,
  globalRole: UserRole = "B2B_PARTNER",
  userId = "user-1",
): AuthContext {
  return {
    cognitoSub: `sub-${userId}`,
    userId,
    globalRole,
    activeTenantId: "tenant-1",
    tenantSlug: "tenant",
    tenantRole,
    handle: "user",
    membershipsLoader: async () => [],
  };
}

describe("requireRole", () => {
  it("passes when caller has exact role", () => {
    expect(requireRole(makeAuth("ADMIN"), "ADMIN")).toBeNull();
  });

  it("passes when caller outranks the floor", () => {
    expect(requireRole(makeAuth("OWNER"), "ADMIN")).toBeNull();
    expect(requireRole(makeAuth("ADMIN"), "MEMBER")).toBeNull();
    expect(requireRole(makeAuth("MEMBER"), "GUEST")).toBeNull();
  });

  it("returns 403 below the floor", async () => {
    const r = requireRole(makeAuth("MEMBER"), "ADMIN");
    expect(r?.status).toBe(403);
    const body = await r!.json();
    expect((body as { error: string }).error).toBe("FORBIDDEN");
  });

  it("SUPER_ADMIN bypasses regardless of tenant role", () => {
    expect(requireRole(makeAuth("GUEST", "SUPER_ADMIN"), "OWNER")).toBeNull();
  });
});

describe("requireCapability — base matrix", () => {
  it("OWNER passes TenantDelete", () => {
    expect(requireCapability(makeAuth("OWNER"), Capability.TenantDelete)).toBeNull();
  });

  it("ADMIN fails TenantDelete (OWNER-only)", async () => {
    const r = requireCapability(makeAuth("ADMIN"), Capability.TenantDelete);
    expect(r?.status).toBe(403);
    const body = await r!.json() as { message: string };
    expect(body.message).toContain("tenant.delete");
  });

  it("MEMBER fails TenantUpdate", () => {
    expect(requireCapability(makeAuth("MEMBER"), Capability.TenantUpdate)?.status).toBe(403);
  });

  it("GUEST fails PostCreate", () => {
    expect(requireCapability(makeAuth("GUEST"), Capability.PostCreate)?.status).toBe(403);
  });

  it("MEMBER passes PostCreate, EntityCreate, MemberView", () => {
    expect(requireCapability(makeAuth("MEMBER"), Capability.PostCreate)).toBeNull();
    expect(requireCapability(makeAuth("MEMBER"), Capability.EntityCreate)).toBeNull();
    expect(requireCapability(makeAuth("MEMBER"), Capability.MemberView)).toBeNull();
  });

  it("GUEST can view public surfaces (Domain, Entity, Post)", () => {
    expect(requireCapability(makeAuth("GUEST"), Capability.DomainView)).toBeNull();
    expect(requireCapability(makeAuth("GUEST"), Capability.EntityView)).toBeNull();
    expect(requireCapability(makeAuth("GUEST"), Capability.PostView)).toBeNull();
  });
});

describe("requireCapability — SUPER_ADMIN bypass", () => {
  it("bypasses TenantDelete from GUEST role", () => {
    expect(
      requireCapability(makeAuth("GUEST", "SUPER_ADMIN"), Capability.TenantDelete),
    ).toBeNull();
  });

  it("bypasses every capability for any tenantRole", () => {
    const auth = makeAuth("GUEST", "SUPER_ADMIN");
    for (const cap of Object.values(Capability)) {
      expect(requireCapability(auth, cap)).toBeNull();
    }
  });

  it("bypasses own-only checks even when not the owner", () => {
    const auth = makeAuth("GUEST", "SUPER_ADMIN", "alice");
    const r = requireCapability(auth, Capability.PostUpdate, {
      resource: { authorId: "bob" },
    });
    expect(r).toBeNull();
  });
});

describe("requireCapability — own-only resource scoping", () => {
  it("MEMBER may update their own post", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.PostUpdate, { resource: { authorId: "alice" } }),
    ).toBeNull();
  });

  it("MEMBER cannot update someone else's post (no PostModerate)", async () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    const r = requireCapability(auth, Capability.PostUpdate, {
      resource: { authorId: "bob" },
    });
    expect(r?.status).toBe(403);
    const body = await r!.json() as { message: string };
    expect(body.message).toContain("ownership");
    expect(body.message).toContain("post.moderate");
  });

  it("ADMIN may update someone else's post (holds PostModerate)", () => {
    const auth = makeAuth("ADMIN", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.PostUpdate, { resource: { authorId: "bob" } }),
    ).toBeNull();
  });

  it("ADMIN may delete someone else's post (PostModerate)", () => {
    const auth = makeAuth("ADMIN", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.PostDelete, { resource: { authorId: "bob" } }),
    ).toBeNull();
  });

  it("MEMBER may update an entity they own (ownerUserId match)", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.EntityUpdate, { resource: { ownerUserId: "alice" } }),
    ).toBeNull();
  });

  it("MEMBER cannot update an entity owned by someone else", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    const r = requireCapability(auth, Capability.EntityUpdate, {
      resource: { ownerUserId: "bob" },
    });
    expect(r?.status).toBe(403);
  });

  it("MEMBER cannot delete an entity they don't own", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    const r = requireCapability(auth, Capability.EntityDelete, {
      resource: { ownerUserId: "bob" },
    });
    expect(r?.status).toBe(403);
  });

  it("ADMIN may update entities they don't own", () => {
    const auth = makeAuth("ADMIN", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.EntityUpdate, {
        resource: { ownerUserId: "bob" },
      }),
    ).toBeNull();
  });

  it("OWNER may update entities they don't own", () => {
    const auth = makeAuth("OWNER", "B2B_PARTNER", "alice");
    expect(
      requireCapability(auth, Capability.EntityUpdate, {
        resource: { ownerUserId: "bob" },
      }),
    ).toBeNull();
  });

  it("treats resource with null ownership as no-match (blocked for non-mods)", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    const r = requireCapability(auth, Capability.PostUpdate, {
      resource: { authorId: null, ownerUserId: null },
    });
    expect(r?.status).toBe(403);
  });

  it("when no resource is supplied, lenient pass (caller is responsible for fetching)", () => {
    const auth = makeAuth("MEMBER", "B2B_PARTNER", "alice");
    expect(requireCapability(auth, Capability.PostUpdate)).toBeNull();
  });
});

describe("requireCapability — role lacks capability outright", () => {
  it("GUEST cannot use any tenant-management capability", () => {
    expect(requireCapability(makeAuth("GUEST"), Capability.TenantUpdate)?.status).toBe(403);
    expect(requireCapability(makeAuth("GUEST"), Capability.MemberInvite)?.status).toBe(403);
    expect(requireCapability(makeAuth("GUEST"), Capability.IdpConfigure)?.status).toBe(403);
  });

  it("MEMBER cannot view audit log (ADMIN+)", () => {
    expect(requireCapability(makeAuth("MEMBER"), Capability.AuditView)?.status).toBe(403);
  });

  it("MEMBER cannot moderate posts", () => {
    expect(requireCapability(makeAuth("MEMBER"), Capability.PostModerate)?.status).toBe(403);
  });

  it("returns FORBIDDEN error code in body", async () => {
    const r = requireCapability(makeAuth("MEMBER"), Capability.TenantUpdate);
    const body = await r!.json() as { error: string; message: string };
    expect(body.error).toBe("FORBIDDEN");
    expect(body.message).toMatch(/tenant\.update/);
  });
});

describe("Single-OWNER invariant — resolveTenantRole defense in depth", () => {
  it("never produces OWNER from a default role", () => {
    expect(resolveTenantRole([], [], "OWNER")).toBe("ADMIN");
  });

  it("never produces OWNER from a misconfigured group mapping", () => {
    const result = resolveTenantRole(
      ["admins-group"],
      [{ idpGroupName: "admins-group", tenantRole: "OWNER", priority: 0 }],
      null,
    );
    expect(result).toBe("ADMIN");
  });

  it("returns null when no match and default is null", () => {
    expect(resolveTenantRole(["unknown"], [], null)).toBeNull();
  });

  it("preserves non-OWNER roles", () => {
    expect(
      resolveTenantRole(
        ["g1"],
        [{ idpGroupName: "g1", tenantRole: "ADMIN", priority: 10 }],
        null,
      ),
    ).toBe("ADMIN");
  });
});
