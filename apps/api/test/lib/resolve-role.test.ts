import { describe, expect, it } from "vitest";
import { resolveTenantRole, type RoleMappingInput } from "../../src/lib/tenant/resolve-role.js";

describe("resolveTenantRole", () => {
  const mappings: RoleMappingInput[] = [
    { idpGroupName: "trellis-employees", tenantRole: "MEMBER", priority: 100 },
    { idpGroupName: "trellis-admins", tenantRole: "ADMIN", priority: 10 },
  ];

  it("returns the matching role when one mapping matches", () => {
    expect(resolveTenantRole(["trellis-admins"], mappings, "MEMBER")).toBe("ADMIN");
  });

  it("priority-orders multiple matches (lowest priority wins)", () => {
    expect(
      resolveTenantRole(["trellis-employees", "trellis-admins"], mappings, "MEMBER"),
    ).toBe("ADMIN");
  });

  it("breaks priority ties by role rank (highest non-OWNER wins)", () => {
    // OWNER is intentionally capped to ADMIN by resolveTenantRole — see
    // "caps OWNER mapping to ADMIN" below. Tie-breaking uses the original
    // ROLE_RANK ordering (OWNER > ADMIN > MEMBER > GUEST) so a mapping
    // configured as OWNER still wins ties before being capped.
    const tie: RoleMappingInput[] = [
      { idpGroupName: "g-a", tenantRole: "MEMBER", priority: 50 },
      { idpGroupName: "g-b", tenantRole: "ADMIN", priority: 50 },
      { idpGroupName: "g-c", tenantRole: "GUEST", priority: 50 },
    ];
    expect(resolveTenantRole(["g-a", "g-b", "g-c"], tie, "GUEST")).toBe("ADMIN");
  });

  it("caps an OWNER mapping at ADMIN (single-OWNER invariant — G2 M3)", () => {
    const ownerMapping: RoleMappingInput[] = [
      { idpGroupName: "trellis-owners", tenantRole: "OWNER", priority: 1 },
    ];
    expect(
      resolveTenantRole(["trellis-owners"], ownerMapping, "MEMBER"),
    ).toBe("ADMIN");
  });

  it("caps an OWNER defaultRole at ADMIN", () => {
    expect(resolveTenantRole([], [], "OWNER")).toBe("ADMIN");
  });

  it("caps OWNER won by tie-break at ADMIN", () => {
    const tie: RoleMappingInput[] = [
      { idpGroupName: "g-a", tenantRole: "OWNER", priority: 50 },
      { idpGroupName: "g-b", tenantRole: "MEMBER", priority: 50 },
    ];
    expect(resolveTenantRole(["g-a", "g-b"], tie, null)).toBe("ADMIN");
  });

  it("returns defaultRole when no mappings match", () => {
    expect(resolveTenantRole(["unrelated-group"], mappings, "MEMBER")).toBe("MEMBER");
  });

  it("returns null when no match and defaultRole is null", () => {
    expect(resolveTenantRole(["unrelated-group"], mappings, null)).toBeNull();
  });

  it("returns defaultRole when idpGroups is empty", () => {
    expect(resolveTenantRole([], mappings, "GUEST")).toBe("GUEST");
  });

  it("returns null when idpGroups is empty and defaultRole is null", () => {
    expect(resolveTenantRole([], mappings, null)).toBeNull();
  });

  it("returns null when idpGroups is empty and mappings is empty", () => {
    expect(resolveTenantRole([], [], null)).toBeNull();
  });

  it("returns defaultRole when mappings is empty but idpGroups is not", () => {
    expect(resolveTenantRole(["any"], [], "MEMBER")).toBe("MEMBER");
  });

  it("ignores groups that have no corresponding mapping", () => {
    expect(
      resolveTenantRole(["unrelated", "trellis-admins", "unrelated2"], mappings, null),
    ).toBe("ADMIN");
  });
});
