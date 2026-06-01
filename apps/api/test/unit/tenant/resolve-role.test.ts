/**
 * Unit tests: resolveTenantRole (JIT IdP-group → TenantRole resolution).
 *
 * This is authorization logic on the federated sign-in path: get it wrong and
 * a misconfigured mapping silently escalates a federated user. The tests lock
 * the four documented branches (no groups / no match / lowest-priority-wins /
 * priority-tie→highest-rank) AND the OWNER-cap defense-in-depth backstop
 * (G2 M3): no group mapping or default-role may ever resolve to OWNER.
 *
 * `TenantRole` is a type-only import (erased at runtime), so these are pure
 * tests with no Prisma client dependency.
 */

import { describe, expect, it } from "vitest";
import type { TenantRole } from "@prisma/client";
import {
  resolveTenantRole,
  type RoleMappingInput,
} from "../../../src/lib/tenant/resolve-role.js";

const map = (
  idpGroupName: string,
  tenantRole: TenantRole,
  priority: number,
): RoleMappingInput => ({ idpGroupName, tenantRole, priority });

describe("resolveTenantRole — no-match fallbacks", () => {
  it("returns defaultRole when the user has no IdP groups", () => {
    expect(resolveTenantRole([], [map("eng", "ADMIN", 0)], "MEMBER")).toBe("MEMBER");
  });

  it("returns defaultRole when no group matches any mapping", () => {
    expect(
      resolveTenantRole(["sales"], [map("eng", "ADMIN", 0)], "GUEST"),
    ).toBe("GUEST");
  });

  it("returns null (deny provisioning) when no match and defaultRole is null", () => {
    expect(resolveTenantRole([], [], null)).toBeNull();
    expect(resolveTenantRole(["sales"], [map("eng", "ADMIN", 0)], null)).toBeNull();
  });
});

describe("resolveTenantRole — priority + rank selection", () => {
  it("lowest priority number wins (0 beats 100)", () => {
    const mappings = [map("eng", "MEMBER", 100), map("lead", "ADMIN", 0)];
    expect(resolveTenantRole(["eng", "lead"], mappings, "GUEST")).toBe("ADMIN");
  });

  it("on a priority tie, the highest role rank wins", () => {
    // Both priority 10; ADMIN(3) outranks MEMBER(2).
    const mappings = [map("a", "MEMBER", 10), map("b", "ADMIN", 10)];
    expect(resolveTenantRole(["a", "b"], mappings, "GUEST")).toBe("ADMIN");
  });

  it("priority dominates rank: a high-rank mapping at worse priority loses", () => {
    // ADMIN at priority 50 vs GUEST at priority 0 → priority wins → GUEST.
    const mappings = [map("a", "ADMIN", 50), map("b", "GUEST", 0)];
    expect(resolveTenantRole(["a", "b"], mappings, "MEMBER")).toBe("GUEST");
  });

  it("matches only the user's groups, ignoring unrelated mappings", () => {
    const mappings = [map("admins", "ADMIN", 0), map("guests", "GUEST", 0)];
    expect(resolveTenantRole(["guests"], mappings, "MEMBER")).toBe("GUEST");
  });

  it("does not mutate the caller's mappings array when sorting", () => {
    const mappings = [map("a", "MEMBER", 100), map("b", "ADMIN", 0)];
    const snapshot = [...mappings];
    resolveTenantRole(["a", "b"], mappings, "GUEST");
    expect(mappings).toEqual(snapshot);
  });
});

describe("resolveTenantRole — OWNER cap (defense-in-depth, G2 M3)", () => {
  it("downgrades an OWNER group mapping to ADMIN", () => {
    expect(
      resolveTenantRole(["founders"], [map("founders", "OWNER", 0)], "MEMBER"),
    ).toBe("ADMIN");
  });

  it("downgrades an OWNER defaultRole to ADMIN (no groups)", () => {
    expect(resolveTenantRole([], [], "OWNER")).toBe("ADMIN");
  });

  it("downgrades an OWNER defaultRole to ADMIN (no mapping matched)", () => {
    expect(
      resolveTenantRole(["sales"], [map("eng", "ADMIN", 0)], "OWNER"),
    ).toBe("ADMIN");
  });

  it("a winning OWNER mapping is capped even when it beats a real ADMIN", () => {
    // OWNER would win on rank at the same priority, but is capped to ADMIN.
    const mappings = [map("founders", "OWNER", 0), map("eng", "ADMIN", 0)];
    expect(resolveTenantRole(["founders", "eng"], mappings, "GUEST")).toBe("ADMIN");
  });
});
