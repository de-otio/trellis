/**
 * Role × Capability matrix tests.
 *
 * Asserts every cell in the design-doc table at
 * doc/02-technical/identity-federation/05-roles-and-permissions.md against
 * `RoleGrants`. If the matrix shifts, this test is the canary.
 */

import { describe, expect, it } from "vitest";
import type { TenantRole } from "@prisma/client";
import { Capability, ALL_CAPABILITIES, type CapabilityValue } from "../../src/lib/auth/capabilities.js";
import { RoleGrants } from "../../src/lib/auth/role-grants.js";

type RoleCell = Record<TenantRole, boolean>;

const MATRIX: Record<CapabilityValue, RoleCell> = {
  [Capability.TenantUpdate]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.TenantDelete]:    { OWNER: true,  ADMIN: false, MEMBER: false, GUEST: false },
  [Capability.TenantSuspend]:   { OWNER: true,  ADMIN: false, MEMBER: false, GUEST: false },

  [Capability.MemberInvite]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.MemberRemove]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.MemberChangeRole]:{ OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.MemberSuspend]:   { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.MemberView]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },

  [Capability.IdpConfigure]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.IdpView]:         { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.RoleMappingEdit]: { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },

  [Capability.DomainAdd]:       { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.DomainVerify]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.DomainRemove]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.DomainView]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: true  },

  [Capability.EntityCreate]:    { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EntityUpdate]:    { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EntityDelete]:    { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EntityView]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: true  },

  [Capability.PostCreate]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.PostUpdate]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.PostDelete]:      { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.PostModerate]:    { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },
  [Capability.PostView]:        { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: true  },

  [Capability.EventCreate]:     { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EventUpdate]:     { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EventDelete]:     { OWNER: true,  ADMIN: true,  MEMBER: true,  GUEST: false },
  [Capability.EventModerate]:   { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },

  [Capability.AuditView]:       { OWNER: true,  ADMIN: true,  MEMBER: false, GUEST: false },

  [Capability.ClassificationEdit]: { OWNER: true, ADMIN: true, MEMBER: false, GUEST: false },
  [Capability.DirectoryEdit]:      { OWNER: true, ADMIN: true, MEMBER: false, GUEST: false },

  [Capability.ManageAgentSessions]: { OWNER: true, ADMIN: true, MEMBER: false, GUEST: false },
};

describe("RoleGrants matrix — every (role × capability) cell", () => {
  const roles: TenantRole[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];

  for (const cap of ALL_CAPABILITIES) {
    for (const role of roles) {
      const expected = MATRIX[cap][role];
      it(`${role} ${expected ? "has" : "lacks"} ${cap}`, () => {
        expect(RoleGrants[role].has(cap)).toBe(expected);
      });
    }
  }
});

describe("RoleGrants — superset hierarchy", () => {
  it("OWNER ⊇ ADMIN", () => {
    for (const cap of RoleGrants.ADMIN) expect(RoleGrants.OWNER.has(cap)).toBe(true);
  });
  it("ADMIN ⊇ MEMBER", () => {
    for (const cap of RoleGrants.MEMBER) expect(RoleGrants.ADMIN.has(cap)).toBe(true);
  });
  it("MEMBER ⊇ GUEST", () => {
    for (const cap of RoleGrants.GUEST) expect(RoleGrants.MEMBER.has(cap)).toBe(true);
  });

  it("OWNER has exactly two more capabilities than ADMIN (TenantDelete, TenantSuspend)", () => {
    const ownerOnly = [...RoleGrants.OWNER].filter((c) => !RoleGrants.ADMIN.has(c));
    expect(new Set(ownerOnly)).toEqual(new Set([Capability.TenantDelete, Capability.TenantSuspend]));
  });
});

describe("Capability catalog completeness", () => {
  it("MATRIX covers every defined capability", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it("ALL_CAPABILITIES has 32 entries (snapshot of MVP catalog + events primitive)", () => {
    expect(ALL_CAPABILITIES.length).toBe(32);
  });
});
