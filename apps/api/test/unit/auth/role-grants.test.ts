/**
 * Unit Tests: role-grants.ts — static capability grant sets per TenantRole.
 *
 * Contract locked by this suite:
 *   1. The strict subset chain GUEST ⊂ MEMBER ⊂ ADMIN ⊂ OWNER holds at every
 *      step (no capability regression when a role is promoted).
 *   2. OWNER exceeds ADMIN by exactly {tenant.delete, tenant.suspend} — no other
 *      capability silently added or removed.
 *   3. GUEST is read-only: it must contain only view-style capabilities and must
 *      not include any create/update/delete/configure/moderate/manage capability.
 *   4. High-consequence capabilities are gate-kept at the correct minimum role.
 *   5. Every capability string in every grant set is a member of ALL_CAPABILITIES
 *      (no stale or typo strings escape into a live grant).
 *   6. RoleGrants has exactly the four keys OWNER/ADMIN/MEMBER/GUEST.
 *
 * Authorization logic is a high-stakes correctness target: a wrong grant is
 * privilege escalation. The source docstring declares these invariants but does
 * not assert them at runtime, so this test file is the enforcement point.
 */

import { describe, expect, it } from "vitest";
import { RoleGrants } from "../../../src/lib/auth/role-grants.js";
import { Capability, ALL_CAPABILITIES } from "../../../src/lib/auth/capabilities.js";
import type { TenantRole } from "@prisma/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true iff `superset` contains every element of `subset`. */
function isSuperset(
  superset: ReadonlySet<string>,
  subset: ReadonlySet<string>,
): boolean {
  for (const cap of subset) {
    if (!superset.has(cap)) return false;
  }
  return true;
}

/** Returns the set of elements in `a` that are not in `b`. */
function setDifference(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): Set<string> {
  const diff = new Set<string>();
  for (const item of a) {
    if (!b.has(item)) diff.add(item);
  }
  return diff;
}

const allCapSet = new Set<string>(ALL_CAPABILITIES);

// ---------------------------------------------------------------------------
// 1. Hierarchy invariant: GUEST ⊆ MEMBER ⊆ ADMIN ⊆ OWNER
// ---------------------------------------------------------------------------

describe("RoleGrants hierarchy invariant (GUEST ⊆ MEMBER ⊆ ADMIN ⊆ OWNER)", () => {
  it("MEMBER is a superset of GUEST", () => {
    for (const cap of RoleGrants.GUEST) {
      expect(RoleGrants.MEMBER.has(cap), `MEMBER missing GUEST capability: ${cap}`).toBe(true);
    }
  });

  it("ADMIN is a superset of MEMBER", () => {
    for (const cap of RoleGrants.MEMBER) {
      expect(RoleGrants.ADMIN.has(cap), `ADMIN missing MEMBER capability: ${cap}`).toBe(true);
    }
  });

  it("OWNER is a superset of ADMIN", () => {
    for (const cap of RoleGrants.ADMIN) {
      expect(RoleGrants.OWNER.has(cap), `OWNER missing ADMIN capability: ${cap}`).toBe(true);
    }
  });

  it("chain is transitive: OWNER is a superset of MEMBER", () => {
    expect(isSuperset(RoleGrants.OWNER, RoleGrants.MEMBER)).toBe(true);
  });

  it("chain is transitive: OWNER is a superset of GUEST", () => {
    expect(isSuperset(RoleGrants.OWNER, RoleGrants.GUEST)).toBe(true);
  });

  it("chain is transitive: ADMIN is a superset of GUEST", () => {
    expect(isSuperset(RoleGrants.ADMIN, RoleGrants.GUEST)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. OWNER ⊋ ADMIN by EXACTLY {tenant.delete, tenant.suspend}
// ---------------------------------------------------------------------------

describe("OWNER vs ADMIN: exact difference", () => {
  it("OWNER has exactly two more capabilities than ADMIN: tenant.delete and tenant.suspend", () => {
    const ownerExtra = setDifference(RoleGrants.OWNER, RoleGrants.ADMIN);
    const expected = new Set([Capability.TenantDelete, Capability.TenantSuspend]);
    expect(ownerExtra).toEqual(expected);
  });

  it("ADMIN does not contain any capability that OWNER lacks (ADMIN ⊆ OWNER is strict)", () => {
    const adminExtra = setDifference(RoleGrants.ADMIN, RoleGrants.OWNER);
    expect(adminExtra.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. GUEST is read-only
// ---------------------------------------------------------------------------

describe("GUEST is read-only", () => {
  // The mutating verb tokens that must never appear in a GUEST grant.
  const mutatingVerbs = [
    "create", "update", "delete", "add", "remove", "configure",
    "invite", "moderate", "change_role", "suspend", "verify", "edit",
    "manage",
  ];

  it("GUEST contains no capability with a mutating verb", () => {
    for (const cap of RoleGrants.GUEST) {
      const verb = cap.split(".")[1] ?? cap.split(":")[1] ?? cap;
      const isMutating = mutatingVerbs.some((v) => verb.includes(v));
      expect(
        isMutating,
        `GUEST should not have mutating capability: ${cap}`,
      ).toBe(false);
    }
  });

  it("GUEST contains exactly the three public-read capabilities", () => {
    const expected = new Set([
      Capability.DomainView,
      Capability.EntityView,
      Capability.PostView,
    ]);
    expect(RoleGrants.GUEST).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 4. Spot-check: high-consequence capability gate assignments
// ---------------------------------------------------------------------------

describe("High-consequence capability gates", () => {
  // --- ADMIN+OWNER exclusive capabilities (MEMBER and below must not have them) ---
  const adminExclusiveCaps: Array<[string, string]> = [
    [Capability.MemberInvite, "member.invite"],
    [Capability.IdpConfigure, "idp.configure"],
    [Capability.RoleMappingEdit, "role_mapping.edit"],
    [Capability.AuditView, "audit.view"],
    [Capability.ManageAgentSessions, "manage:agent_sessions"],
  ];

  for (const [cap, label] of adminExclusiveCaps) {
    it(`ADMIN has ${label}`, () => {
      expect(RoleGrants.ADMIN.has(cap)).toBe(true);
    });
    it(`OWNER has ${label}`, () => {
      expect(RoleGrants.OWNER.has(cap)).toBe(true);
    });
    it(`MEMBER does NOT have ${label}`, () => {
      expect(RoleGrants.MEMBER.has(cap)).toBe(false);
    });
    it(`GUEST does NOT have ${label}`, () => {
      expect(RoleGrants.GUEST.has(cap)).toBe(false);
    });
  }

  // --- OWNER-only capabilities ---
  const ownerOnlyCaps: Array<[string, string]> = [
    [Capability.TenantDelete, "tenant.delete"],
    [Capability.TenantSuspend, "tenant.suspend"],
  ];

  for (const [cap, label] of ownerOnlyCaps) {
    it(`OWNER has ${label}`, () => {
      expect(RoleGrants.OWNER.has(cap)).toBe(true);
    });
    it(`ADMIN does NOT have ${label}`, () => {
      expect(RoleGrants.ADMIN.has(cap)).toBe(false);
    });
    it(`MEMBER does NOT have ${label}`, () => {
      expect(RoleGrants.MEMBER.has(cap)).toBe(false);
    });
    it(`GUEST does NOT have ${label}`, () => {
      expect(RoleGrants.GUEST.has(cap)).toBe(false);
    });
  }

  // --- MEMBER-specific checks ---
  it("MEMBER has post.create", () => {
    expect(RoleGrants.MEMBER.has(Capability.PostCreate)).toBe(true);
  });

  it("MEMBER does NOT have post.moderate", () => {
    expect(RoleGrants.MEMBER.has(Capability.PostModerate)).toBe(false);
  });

  it("GUEST does NOT have post.create", () => {
    expect(RoleGrants.GUEST.has(Capability.PostCreate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. No stale / typo capability strings
// ---------------------------------------------------------------------------

describe("All granted capabilities exist in ALL_CAPABILITIES", () => {
  const roles: TenantRole[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];

  for (const role of roles) {
    it(`every capability in ${role} grants is a member of ALL_CAPABILITIES`, () => {
      for (const cap of RoleGrants[role]) {
        expect(
          allCapSet.has(cap),
          `${role} has unknown capability not in ALL_CAPABILITIES: "${cap}"`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. RoleGrants has exactly the four canonical TenantRole keys
// ---------------------------------------------------------------------------

describe("RoleGrants shape", () => {
  it("has exactly the four keys OWNER, ADMIN, MEMBER, GUEST", () => {
    const keys = Object.keys(RoleGrants).sort();
    expect(keys).toEqual(["ADMIN", "GUEST", "MEMBER", "OWNER"]);
  });

  it("each value is a non-empty Set", () => {
    for (const role of ["OWNER", "ADMIN", "MEMBER", "GUEST"] as TenantRole[]) {
      expect(RoleGrants[role]).toBeInstanceOf(Set);
      expect(RoleGrants[role].size).toBeGreaterThan(0);
    }
  });

  it("grant set sizes grow strictly: GUEST < MEMBER < ADMIN < OWNER", () => {
    expect(RoleGrants.GUEST.size).toBeLessThan(RoleGrants.MEMBER.size);
    expect(RoleGrants.MEMBER.size).toBeLessThan(RoleGrants.ADMIN.size);
    expect(RoleGrants.ADMIN.size).toBeLessThan(RoleGrants.OWNER.size);
  });
});
