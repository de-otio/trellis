/**
 * Unit tests for the tenant-scope module (WS2, doc/14-multi-tenancy).
 *
 * Covers the pure decision (`planTenantScope`), the mode resolver, the
 * unscoped escape hatch, and the model-classification coverage meta-test that
 * fails when a new Prisma model is added without a tenant-scoping decision.
 */

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  delegateKeyToModelName,
  extensionScopedModelNames,
  planTenantScope,
  resolveTenantScopeMode,
  runUnscoped,
  TENANT_SCOPED_MODELS,
  UNSCOPED_MODELS,
} from "../../src/lib/tenant-scope.js";
import { EXTENSION_MODEL_REGISTRY } from "../../src/lib/extension-model-registry.js";

const base = {
  model: "Post",
  operation: "findMany",
  args: { where: { authorId: "u1" } } as Record<string, unknown>,
  tenantId: "t-acme",
  unscoped: false,
} as const;

describe("resolveTenantScopeMode", () => {
  it("defaults to off and only accepts shadow|enforce", () => {
    expect(resolveTenantScopeMode(undefined)).toBe("off");
    expect(resolveTenantScopeMode("nonsense")).toBe("off");
    expect(resolveTenantScopeMode("")).toBe("off");
    expect(resolveTenantScopeMode("shadow")).toBe("shadow");
    expect(resolveTenantScopeMode("enforce")).toBe("enforce");
  });
});

describe("planTenantScope — passthrough cases", () => {
  it("off mode never scopes", () => {
    expect(planTenantScope({ ...base, mode: "off" })).toEqual({ action: "passthrough" });
  });
  it("unscoped() bypasses scoping even in enforce", () => {
    expect(planTenantScope({ ...base, mode: "enforce", unscoped: true })).toEqual({
      action: "passthrough",
    });
  });
  it("non-tenant-scoped models pass through", () => {
    expect(planTenantScope({ ...base, model: "User", mode: "enforce" })).toEqual({
      action: "passthrough",
    });
    expect(planTenantScope({ ...base, model: "TenantMember", mode: "enforce" })).toEqual({
      action: "passthrough",
    });
  });
});

describe("planTenantScope — no tenant context", () => {
  it("enforce throws", () => {
    const plan = planTenantScope({ ...base, mode: "enforce", tenantId: undefined });
    expect(plan.action).toBe("throw");
  });
  it("shadow observes (does not throw)", () => {
    expect(planTenantScope({ ...base, mode: "shadow", tenantId: undefined })).toEqual({
      action: "observe-no-context",
    });
  });
});

describe("planTenantScope — shadow observes without mutating", () => {
  it("flags a scoped read missing a tenantId filter", () => {
    expect(planTenantScope({ ...base, mode: "shadow" })).toEqual({
      action: "observe",
      wouldScope: true,
    });
  });
  it("does not flag a query already scoped to tenantId", () => {
    expect(
      planTenantScope({
        ...base,
        mode: "shadow",
        args: { where: { tenantId: "t-acme", authorId: "u1" } },
      }),
    ).toEqual({ action: "observe", wouldScope: false });
  });
});

describe("planTenantScope — enforce rewrites", () => {
  it("AND-merges tenantId into where for findMany", () => {
    const plan = planTenantScope({ ...base, mode: "enforce" });
    expect(plan).toEqual({
      action: "rewrite",
      args: { where: { AND: [{ authorId: "u1" }, { tenantId: "t-acme" }] } },
    });
  });
  it("scopes count/aggregate/groupBy/updateMany/deleteMany", () => {
    for (const operation of ["count", "aggregate", "groupBy", "updateMany", "deleteMany"]) {
      const plan = planTenantScope({ ...base, mode: "enforce", operation });
      expect(plan.action).toBe("rewrite");
      expect((plan as { args: { where: unknown } }).args.where).toEqual({
        AND: [{ authorId: "u1" }, { tenantId: "t-acme" }],
      });
    }
  });
  it("stamps tenantId on create", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "create",
      args: { data: { body: "hi" } },
    });
    expect(plan).toEqual({
      action: "rewrite",
      args: { data: { body: "hi", tenantId: "t-acme" } },
    });
  });
  it("stamps tenantId on every row of createMany", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "createMany",
      args: { data: [{ body: "a" }, { body: "b" }] },
    });
    expect((plan as { args: { data: unknown } }).args.data).toEqual([
      { body: "a", tenantId: "t-acme" },
      { body: "b", tenantId: "t-acme" },
    ]);
  });
  it("scopes upsert where + stamps create", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "upsert",
      args: { where: { id: "p1" }, create: { body: "x" }, update: { body: "y" } },
    });
    expect(plan).toEqual({
      action: "rewrite",
      args: {
        where: { AND: [{ id: "p1" }, { tenantId: "t-acme" }] },
        create: { body: "x", tenantId: "t-acme" },
        update: { body: "y" },
      },
    });
  });
  it("passes through unique-selector ops (covered by RLS backstop)", () => {
    for (const operation of ["findUnique", "findUniqueOrThrow", "update", "delete"]) {
      expect(planTenantScope({ ...base, mode: "enforce", operation })).toEqual({
        action: "passthrough",
      });
    }
  });
});

describe("runUnscoped", () => {
  it("runs the callback and returns its value", () => {
    expect(runUnscoped("test", () => 42)).toBe(42);
  });
});

describe("model classification coverage (no silent holes)", () => {
  const allModels = Prisma.dmmf.datamodel.models.map((m) => m.name);

  it("classifies every Prisma model as scoped or explicitly unscoped", () => {
    const unclassified = allModels.filter(
      (name) => !TENANT_SCOPED_MODELS.has(name) && !UNSCOPED_MODELS.has(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("has no stale classification entries (every entry is a real model)", () => {
    const real = new Set(allModels);
    const stale = [...TENANT_SCOPED_MODELS, ...UNSCOPED_MODELS.keys()].filter(
      (name) => !real.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("scoped and unscoped sets are disjoint", () => {
    const overlap = [...TENANT_SCOPED_MODELS].filter((m) => UNSCOPED_MODELS.has(m));
    expect(overlap).toEqual([]);
  });
});

describe("extension-owned (ext_*) model registration (O-1 §12.3 H1)", () => {
  it("maps a camelCase delegate key to its PascalCase model name", () => {
    expect(delegateKeyToModelName("dogReminder")).toBe("DogReminder");
    expect(delegateKeyToModelName("entity")).toBe("Entity");
    expect(delegateKeyToModelName("")).toBe("");
  });

  it("derives PascalCase model names from a (sample) registry", () => {
    const names = extensionScopedModelNames([
      { model: "dogReminder", tenantField: "tenantId", erasureSubjectField: "userId" },
      { model: "dogRecord", tenantField: "tenantId", erasureSubjectField: null },
    ]);
    expect(names).toEqual(["DogReminder", "DogRecord"]);
  });

  it("registers every real ext_* model as scoped, never unscoped", () => {
    // Empty today (dogs owns no tables); teeth arrive when L2 populates the
    // registry — but the invariant is asserted now so a future entry that lands
    // unclassified fails CI here rather than silently leaking.
    for (const entry of EXTENSION_MODEL_REGISTRY) {
      const name = delegateKeyToModelName(entry.model);
      expect(TENANT_SCOPED_MODELS.has(name)).toBe(true);
      expect(UNSCOPED_MODELS.has(name)).toBe(false);
    }
  });

  it("includes the registry's derived names in TENANT_SCOPED_MODELS", () => {
    for (const name of extensionScopedModelNames()) {
      expect(TENANT_SCOPED_MODELS.has(name)).toBe(true);
    }
  });
});
