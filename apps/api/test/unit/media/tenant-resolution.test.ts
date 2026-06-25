/**
 * Unit + Property Tests: media/tenant-resolution.ts (T9)
 *
 * The pure decision that picks the tenant id scoping a media object:
 * - ambient tenant always wins when present (any scope mode)
 * - scope "off" + no ambient → fall back to the uploader's personalTenantId
 * - shadow/enforce + no ambient → fail closed (no personal fallback)
 *
 * Fast-check is seeded for determinism (CLAUDE.md: pin nondeterminism).
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { resolveMediaTenantId } from "../../../src/lib/media/tenant-resolution.js";
import type { TenantScopeMode } from "../../../src/lib/tenant-scope.js";

const FC_SEED = 0x7e9a_71d;

const MODES: TenantScopeMode[] = ["off", "shadow", "enforce"];

describe("resolveMediaTenantId", () => {
  it("uses the ambient tenant when present (scope off)", () => {
    const r = resolveMediaTenantId("ambient-t", "personal-t", "off");
    expect(r).toEqual({ ok: true, tenantId: "ambient-t", source: "ambient" });
  });

  it("uses the ambient tenant when present (enforce)", () => {
    const r = resolveMediaTenantId("ambient-t", "personal-t", "enforce");
    expect(r).toEqual({ ok: true, tenantId: "ambient-t", source: "ambient" });
  });

  it("falls back to personalTenantId when scope is off and no ambient tenant", () => {
    const r = resolveMediaTenantId(undefined, "personal-t", "off");
    expect(r).toEqual({
      ok: true,
      tenantId: "personal-t",
      source: "personal-fallback",
    });
  });

  it("treats an empty-string ambient tenant as NO ambient (falls through, scope off)", () => {
    // An empty-string ambient must never count as a successful ambient
    // resolution — "" is not a real tenant id, and accepting it would scope a
    // CAS key under `cas//{hash}` (an empty tenant segment), collapsing tenant
    // isolation. With scope off it must fall through to the personal tenant.
    const r = resolveMediaTenantId("", "personal-t", "off");
    expect(r).toEqual({
      ok: true,
      tenantId: "personal-t",
      source: "personal-fallback",
    });
  });

  it("treats an empty-string ambient tenant as NO ambient (fails closed, enforce)", () => {
    // Same falsy "" — under enforce there is no personal fallback, so it must
    // fail closed rather than resolve to the empty ambient string.
    const r = resolveMediaTenantId("", "personal-t", "enforce");
    expect(r).toEqual({ ok: false, reason: "no-tenant" });
  });

  it("empty-string ambient + no personal + scope off → fails closed (never tenantId='')", () => {
    const r = resolveMediaTenantId("", undefined, "off");
    expect(r).toEqual({ ok: false, reason: "no-tenant" });
  });

  it("does NOT fall back in shadow mode (fails closed)", () => {
    const r = resolveMediaTenantId(null, "personal-t", "shadow");
    expect(r).toEqual({ ok: false, reason: "no-tenant" });
  });

  it("does NOT fall back in enforce mode (fails closed)", () => {
    const r = resolveMediaTenantId(null, "personal-t", "enforce");
    expect(r).toEqual({ ok: false, reason: "no-tenant" });
  });

  it("fails closed when neither ambient nor personal tenant is available", () => {
    for (const mode of MODES) {
      const r = resolveMediaTenantId(undefined, undefined, mode);
      expect(r).toEqual({ ok: false, reason: "no-tenant" });
    }
  });

  it("property: ambient tenant always wins regardless of mode or fallback", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.option(fc.string(), { nil: undefined }),
        fc.constantFrom(...MODES),
        (ambient, personal, mode) => {
          const r = resolveMediaTenantId(ambient, personal, mode);
          expect(r).toEqual({ ok: true, tenantId: ambient, source: "ambient" });
        },
      ),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: no ambient + non-off mode never resolves to a tenant", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.constantFrom<TenantScopeMode>("shadow", "enforce"),
        (personal, mode) => {
          const r = resolveMediaTenantId(undefined, personal, mode);
          expect(r.ok).toBe(false);
        },
      ),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: no ambient + off resolves iff a personal tenant is present", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (personal) => {
          const r = resolveMediaTenantId(undefined, personal, "off");
          if (personal) {
            expect(r).toEqual({
              ok: true,
              tenantId: personal,
              source: "personal-fallback",
            });
          } else {
            expect(r.ok).toBe(false);
          }
        },
      ),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});
