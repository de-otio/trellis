/**
 * Invariant-locking suite for the Capability catalog.
 *
 * Why this matters: RoleGrants (auth/role-grants.ts) is keyed on the exact
 * string values exported here. A duplicate value, a stale key, or a typo
 * would silently misconfigure authorization — no TypeScript error, no runtime
 * crash, just a capability that silently grants or denies the wrong action.
 * These tests lock the catalog's structural invariants so any such change
 * requires a deliberate update here too.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  Capability,
} from "../../../src/lib/auth/capabilities.js";

// The one known catalog inconsistency: this entry uses a colon separator
// instead of the documented dot convention ("manage:agent_sessions" vs
// "resource.verb"). It predates this test file and should be migrated to
// "agent_session.manage" in a future catalog revision.
const COLON_OUTLIER = "manage:agent_sessions";

describe("Capability catalog — structural invariants", () => {
  describe("ALL_CAPABILITIES completeness", () => {
    it("has the same length as Object.values(Capability)", () => {
      expect(ALL_CAPABILITIES.length).toBe(Object.values(Capability).length);
    });

    it("contains exactly the same members as Object.values(Capability)", () => {
      const fromObject = new Set(Object.values(Capability));
      const fromExport = new Set(ALL_CAPABILITIES);
      expect(fromExport).toEqual(fromObject);
    });
  });

  describe("UNIQUENESS", () => {
    it("has no duplicate values (Set size === number of keys)", () => {
      const values = Object.values(Capability);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  });

  describe("NON-EMPTY", () => {
    it("every capability value is a non-empty string", () => {
      for (const value of ALL_CAPABILITIES) {
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    });
  });

  describe("NAMING convention", () => {
    it("every value matches <resource>.<verb> (dotted) OR is the known colon outlier", () => {
      const dotPattern = /^[a-z_]+\.[a-z_]+$/;
      for (const value of ALL_CAPABILITIES) {
        const isDotted = dotPattern.test(value);
        const isKnownOutlier = value === COLON_OUTLIER;
        expect(isDotted || isKnownOutlier).toBe(true);
      }
    });

    it("all dotted values are fully lowercase", () => {
      for (const value of ALL_CAPABILITIES) {
        if (value !== COLON_OUTLIER) {
          expect(value).toBe(value.toLowerCase());
        }
      }
    });
  });

  describe("ANCHORED spot-checks (renames caught here)", () => {
    it('Capability.TenantDelete === "tenant.delete"', () => {
      expect(Capability.TenantDelete).toBe("tenant.delete");
    });

    it('Capability.MemberInvite === "member.invite"', () => {
      expect(Capability.MemberInvite).toBe("member.invite");
    });

    it('Capability.RoleMappingEdit === "role_mapping.edit"', () => {
      expect(Capability.RoleMappingEdit).toBe("role_mapping.edit");
    });

    it('Capability.ManageAgentSessions === "manage:agent_sessions" (colon outlier)', () => {
      expect(Capability.ManageAgentSessions).toBe("manage:agent_sessions");
    });

    it('Capability.IdpConfigure === "idp.configure"', () => {
      expect(Capability.IdpConfigure).toBe("idp.configure");
    });

    it('Capability.AuditView === "audit.view"', () => {
      expect(Capability.AuditView).toBe("audit.view");
    });
  });
});
