/**
 * Invariant suite for the audit-action taxonomy.
 *
 * WHY: The string VALUES of these constants are persisted verbatim to the
 * foundation audit log and matched by dashboards and compliance queries.
 * A duplicate value makes two distinct actions indistinguishable in the log.
 * A typo or format inconsistency silently corrupts audit analytics and breaks
 * pre-built SIEM/compliance filters. The tenant/IdP subset was migrated from a
 * legacy catalog whose values are declared "preserved verbatim", so drift from
 * the expected strings is a real operational risk. These tests lock the
 * invariants without restating every constant value.
 */

import { describe, expect, it } from "vitest";
import * as Actions from "../../src/lib/audit-actions.js";
import { AuditEventType } from "../../src/lib/audit-actions.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** All exported string constant values from the module. */
const allExportedStrings = Object.entries(Actions)
  .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  .map(([, value]) => value);

/** Pattern matching the dotted-lowercase convention, e.g. "tenant.domain.added" */
const DOTTED_LOWER_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

// ─── Format ─────────────────────────────────────────────────────────────────

describe("format invariants", () => {
  it("every exported string constant matches the dotted-lowercase naming convention", () => {
    for (const value of allExportedStrings) {
      expect(
        DOTTED_LOWER_PATTERN.test(value),
        `"${value}" does not match dotted-lowercase pattern (^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$)`,
      ).toBe(true);
    }
  });
});

// ─── Uniqueness ─────────────────────────────────────────────────────────────

describe("uniqueness invariants", () => {
  it("no two exported string constants share the same value", () => {
    const unique = new Set(allExportedStrings);
    // Build duplicate list for a helpful error message.
    const seen = new Map<string, number>();
    for (const v of allExportedStrings) seen.set(v, (seen.get(v) ?? 0) + 1);
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([v]) => v);
    expect(
      duplicates,
      `Duplicate audit-action values detected: ${duplicates.join(", ")}`,
    ).toHaveLength(0);
    expect(unique.size).toBe(allExportedStrings.length);
  });
});

// ─── AuditEventType map integrity ───────────────────────────────────────────

describe("AuditEventType map integrity", () => {
  const exportedStringSet = new Set(allExportedStrings);
  const auditEventTypeValues = Object.values(AuditEventType);

  it("every value in AuditEventType is one of the exported string constants (no stray literals)", () => {
    for (const value of auditEventTypeValues) {
      expect(
        exportedStringSet.has(value),
        `AuditEventType contains "${value}" which is not exported as a top-level constant`,
      ).toBe(true);
    }
  });

  it("AuditEventType values are themselves unique", () => {
    const unique = new Set(auditEventTypeValues);
    const seen = new Map<string, number>();
    for (const v of auditEventTypeValues) seen.set(v, (seen.get(v) ?? 0) + 1);
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([v]) => v);
    expect(
      duplicates,
      `Duplicate values in AuditEventType: ${duplicates.join(", ")}`,
    ).toHaveLength(0);
    expect(unique.size).toBe(auditEventTypeValues.length);
  });
});

// ─── Spot-checks: contract values depended on by other modules ──────────────
//
// These anchor the four constants referenced in tenant-handler and audit-emit;
// if any of these strings are renamed the compilation may still pass (the type
// is an open string union), but existing audit-log rows / dashboard queries
// would silently stop matching.

describe("anchored spot-checks", () => {
  it("TENANT_DOMAIN_ADDED === 'tenant.domain.added'", () => {
    expect(Actions.TENANT_DOMAIN_ADDED).toBe("tenant.domain.added");
  });

  it("TENANT_DOMAIN_VERIFIED === 'tenant.domain.verified'", () => {
    expect(Actions.TENANT_DOMAIN_VERIFIED).toBe("tenant.domain.verified");
  });

  it("TENANT_MEMBER_REMOVED === 'tenant.member.removed'", () => {
    expect(Actions.TENANT_MEMBER_REMOVED).toBe("tenant.member.removed");
  });

  it("TENANT_OWNERSHIP_TRANSFERRED === 'tenant.ownership_transferred'", () => {
    expect(Actions.TENANT_OWNERSHIP_TRANSFERRED).toBe(
      "tenant.ownership_transferred",
    );
  });

  // NOTE — deliberate gap: there is TENANT_DOMAIN_ADDED and
  // TENANT_DOMAIN_VERIFIED but NO TENANT_DOMAIN_REMOVED. This is a known
  // deferred gap: domain delete is not yet audited. The absence is intentional
  // and recorded elsewhere; this test does NOT assert its presence.
});
