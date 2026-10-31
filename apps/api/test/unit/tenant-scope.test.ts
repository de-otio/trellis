/**
 * Unit tests for the tenant-scope module (WS2, doc/14-multi-tenancy).
 *
 * Covers the pure decision (`planTenantScope`), the mode resolver, the
 * unscoped escape hatch, and the model-classification coverage meta-test that
 * fails when a new Prisma model is added without a tenant-scoping decision.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
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
  it("scopes count/aggregate/groupBy/updateMany/updateManyAndReturn/deleteMany", () => {
    for (const operation of [
      "count",
      "aggregate",
      "groupBy",
      "updateMany",
      "updateManyAndReturn",
      "deleteMany",
    ]) {
      const plan = planTenantScope({ ...base, mode: "enforce", operation });
      expect(plan.action).toBe("rewrite");
      expect((plan as { args: { where: unknown } }).args.where).toEqual({
        AND: [{ authorId: "u1" }, { tenantId: "t-acme" }],
      });
    }
  });
  it("scopes updateMany where and passes tenant-neutral data through", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "updateMany",
      args: { where: { id: "p1" }, data: { body: "y" } },
    });
    expect(plan).toEqual({
      action: "rewrite",
      args: {
        where: { AND: [{ id: "p1" }, { tenantId: "t-acme" }] },
        data: { body: "y" },
      },
    });
  });
  it("rejects updateMany data that moves rows to another tenant", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "updateMany",
      args: { where: { id: "p1" }, data: { tenantId: "t-other" } },
    });
    expect(plan.action).toBe("throw");
  });
  it("stamps tenantId on createManyAndReturn", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "createManyAndReturn",
      args: { data: [{ body: "a" }] },
    });
    expect((plan as { args: { data: unknown } }).args.data).toEqual([
      { body: "a", tenantId: "t-acme" },
    ]);
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
  it("rejects an upsert whose update half moves the row to another tenant", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "upsert",
      args: { where: { id: "p1" }, create: { body: "x" }, update: { tenantId: "t-other" } },
    });
    expect(plan.action).toBe("throw");
  });
  it("rejects a create carrying another tenant's id instead of overwriting it", () => {
    const plan = planTenantScope({
      ...base,
      mode: "enforce",
      operation: "create",
      args: { data: { body: "hi", tenantId: "t-other" } },
    });
    expect(plan.action).toBe("throw");
  });
  it("passes through unique-selector ops (covered by RLS backstop)", () => {
    for (const operation of ["findUnique", "findUniqueOrThrow", "update", "delete"]) {
      expect(planTenantScope({ ...base, mode: "enforce", operation })).toEqual({
        action: "passthrough",
      });
    }
  });
  it("keeps a by-unique update's where as-is but rejects tenant reassignment in its data", () => {
    expect(
      planTenantScope({
        ...base,
        mode: "enforce",
        operation: "update",
        args: { where: { id: "p1" }, data: { body: "y", tenantId: "t-acme" } },
      }),
    ).toEqual({ action: "passthrough" });
    expect(
      planTenantScope({
        ...base,
        mode: "enforce",
        operation: "update",
        args: { where: { id: "p1" }, data: { tenant: { connect: { id: "t-other" } } } },
      }).action,
    ).toBe("throw");
  });
});

// ---------------------------------------------------------------------------
// Write payloads: enforce rejects tenant reassignment (matching the ext_* proxy)
// ---------------------------------------------------------------------------

/** Recursively freeze, so any in-place mutation by the planner throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

type Payload = Record<string, unknown>;

/**
 * Where a payload sits in each write operation's args. `rows` lists the
 * payloads the planner must stamp (creates) or pass through (updates).
 */
const WRITE_SHAPES: ReadonlyArray<{
  name: string;
  operation: string;
  args: (p: Payload) => Record<string, unknown>;
}> = [
  { name: "create", operation: "create", args: (p) => ({ data: p }) },
  {
    name: "createMany[array]",
    operation: "createMany",
    args: (p) => ({ data: [{ body: "a" }, p] }),
  },
  { name: "createMany[object]", operation: "createMany", args: (p) => ({ data: p }) },
  {
    name: "createManyAndReturn",
    operation: "createManyAndReturn",
    args: (p) => ({ data: [p] }),
  },
  { name: "update", operation: "update", args: (p) => ({ where: { id: "p1" }, data: p }) },
  {
    name: "updateMany",
    operation: "updateMany",
    args: (p) => ({ where: { id: "p1" }, data: p }),
  },
  {
    name: "updateManyAndReturn",
    operation: "updateManyAndReturn",
    args: (p) => ({ where: { id: "p1" }, data: p }),
  },
  {
    name: "upsert.update",
    operation: "upsert",
    args: (p) => ({ where: { id: "p1" }, create: { body: "x" }, update: p }),
  },
  {
    name: "upsert.create",
    operation: "upsert",
    args: (p) => ({ where: { id: "p1" }, create: p, update: { body: "y" } }),
  },
];

/** Payload shapes, parameterised by the active and a different tenant id. */
const PAYLOADS: ReadonlyArray<{
  name: string;
  reject: boolean;
  build: (active: string, other: string) => Payload;
}> = [
  { name: "no tenantId", reject: false, build: () => ({ body: "b" }) },
  { name: "same tenantId", reject: false, build: (a) => ({ body: "b", tenantId: a }) },
  { name: "same tenantId via set", reject: false, build: (a) => ({ tenantId: { set: a } }) },
  { name: "undefined tenantId", reject: false, build: () => ({ body: "b", tenantId: undefined }) },
  { name: "scalar update operator", reject: false, build: () => ({ likeCount: { increment: 1 } }) },
  {
    name: "Json column naming tenantId",
    reject: false,
    build: (_a, o) => ({ geoData: { tenantId: o } }),
  },
  {
    // Post.geoData is Json: operator-shaped content is data, not a nested write.
    name: "Json column shaped like a nested write",
    reject: false,
    build: (_a, o) => ({ geoData: { update: { tenant: o }, create: { tenantId: o } } }),
  },
  {
    name: "nested create, same tenant",
    reject: false,
    build: (a) => ({ comments: { create: { body: "c", tenantId: a } } }),
  },
  {
    name: "nested updateMany filtering on a tenant",
    reject: false,
    build: (_a, o) => ({
      comments: { updateMany: { where: { tenantId: o }, data: { body: "c" } } },
    }),
  },
  { name: "other tenantId", reject: true, build: (_a, o) => ({ body: "b", tenantId: o }) },
  { name: "other tenantId via set", reject: true, build: (_a, o) => ({ tenantId: { set: o } }) },
  { name: "null tenantId", reject: true, build: () => ({ tenantId: null }) },
  {
    name: "tenant connect (other)",
    reject: true,
    build: (_a, o) => ({ tenant: { connect: { id: o } } }),
  },
  {
    name: "tenant connect (same)",
    reject: true,
    build: (a) => ({ tenant: { connect: { id: a } } }),
  },
  {
    name: "tenant connectOrCreate",
    reject: true,
    build: (_a, o) => ({ tenant: { connectOrCreate: { where: { id: o }, create: { id: o } } } }),
  },
  {
    name: "nested create, other tenant",
    reject: true,
    build: (_a, o) => ({ comments: { create: { body: "c", tenantId: o } } }),
  },
  {
    name: "nested create array, other tenant",
    reject: true,
    build: (_a, o) => ({ comments: { create: [{ body: "c" }, { tenantId: o }] } }),
  },
  {
    name: "nested createMany, other tenant",
    reject: true,
    build: (_a, o) => ({ comments: { createMany: { data: [{ body: "c", tenantId: o }] } } }),
  },
  {
    name: "nested to-many update, other tenant",
    reject: true,
    build: (_a, o) => ({ comments: { update: { where: { id: "c1" }, data: { tenantId: o } } } }),
  },
  {
    name: "nested to-one update, other tenant",
    reject: true,
    build: (_a, o) => ({ primaryEntity: { update: { tenantId: o } } }),
  },
  {
    name: "nested to-one update as { where, data }, other tenant",
    reject: true,
    build: (_a, o) => ({
      primaryEntity: { update: { where: { id: "e1" }, data: { tenantId: o } } },
    }),
  },
  {
    // Post → PostComment → Post: the walk follows each relation's target model.
    name: "two-level nested create, other tenant",
    reject: true,
    build: (_a, o) => ({
      comments: { create: { body: "c", post: { create: { body: "p", tenantId: o } } } },
    }),
  },
  {
    name: "nested upsert, other tenant",
    reject: true,
    build: (_a, o) => ({
      comments: { upsert: { where: { id: "c1" }, create: { body: "c" }, update: { tenantId: o } } },
    }),
  },
  {
    name: "nested connectOrCreate, other tenant",
    reject: true,
    build: (_a, o) => ({
      comments: { connectOrCreate: { where: { id: "c1" }, create: { tenantId: o } } },
    }),
  },
  {
    // PostMedia is by-relation but carries its own tenantId column.
    name: "nested by-relation child, same tenant",
    reject: false,
    build: (a) => ({ media: { create: { mediaId: "m1", tenantId: a } } }),
  },
  {
    name: "nested by-relation child, other tenant",
    reject: true,
    build: (_a, o) => ({ media: { create: { mediaId: "m1", tenantId: o } } }),
  },
  {
    name: "nested tenant relation write",
    reject: true,
    build: (_a, o) => ({ comments: { create: { tenant: { connect: { id: o } } } } }),
  },
];

/** Two distinct non-empty tenant ids: [active, other]. */
const tenantPair = fc.tuple(fc.uuid(), fc.uuid()).filter(([a, o]) => a !== o);

const writeCase = fc.record({
  shape: fc.constantFrom(...WRITE_SHAPES),
  payload: fc.constantFrom(...PAYLOADS),
  tenants: tenantPair,
});

describe("planTenantScope — enforce rejects tenant reassignment on writes", () => {
  it("throws exactly when a write payload reassigns the tenant", () => {
    fc.assert(
      fc.property(writeCase, ({ shape, payload, tenants: [active, other] }) => {
        const args = deepFreeze(shape.args(payload.build(active, other)));
        const plan = planTenantScope({
          mode: "enforce",
          model: "Post",
          operation: shape.operation,
          args,
          tenantId: active,
          unscoped: false,
        });
        if (payload.reject) {
          expect(plan.action).toBe("throw");
          // The message names the op, never the foreign tenant id.
          expect((plan as { message: string }).message).toContain(`Post.${shape.operation}`);
          expect((plan as { message: string }).message).not.toContain(other);
        } else {
          expect(plan.action).toBe(shape.operation === "update" ? "passthrough" : "rewrite");
        }
      }),
    );
  });

  it("stamps the active tenant on every created row and never changes update data", () => {
    fc.assert(
      fc.property(writeCase, ({ shape, payload, tenants: [active, other] }) => {
        fc.pre(!payload.reject && shape.operation !== "update");
        const raw = shape.args(payload.build(active, other));
        const expected = structuredClone(raw);
        const plan = planTenantScope({
          mode: "enforce",
          model: "Post",
          operation: shape.operation,
          args: deepFreeze(raw),
          tenantId: active,
          unscoped: false,
        });
        const out = (plan as { args: Record<string, unknown> }).args;
        const stamp = (row: unknown) => ({ ...(row as object), tenantId: active });
        switch (shape.operation) {
          case "create":
            expect(out.data).toEqual(stamp(expected.data));
            break;
          case "createMany":
          case "createManyAndReturn":
            expect(out.data).toEqual(
              Array.isArray(expected.data) ? expected.data.map(stamp) : stamp(expected.data),
            );
            break;
          case "upsert":
            expect(out.create).toEqual(stamp(expected.create));
            expect(out.update).toEqual(expected.update);
            expect(out.where).toEqual({ AND: [expected.where, { tenantId: active }] });
            break;
          default: // updateMany / updateManyAndReturn
            expect(out.data).toEqual(expected.data);
            expect(out.where).toEqual({ AND: [expected.where, { tenantId: active }] });
        }
      }),
    );
  });

  it("shadow never throws and flags exactly the payloads enforce would reject", () => {
    fc.assert(
      fc.property(writeCase, ({ shape, payload, tenants: [active, other] }) => {
        const args = deepFreeze(shape.args(payload.build(active, other)));
        const plan = planTenantScope({
          mode: "shadow",
          model: "Post",
          operation: shape.operation,
          args,
          tenantId: active,
          unscoped: false,
        });
        expect(plan.action).toBe("observe");
        expect(typeof (plan as { wouldReject?: string }).wouldReject === "string").toBe(
          payload.reject,
        );
      }),
    );
  });

  it("off mode, runUnscoped and unscoped models are untouched by the write guard", () => {
    fc.assert(
      fc.property(writeCase, ({ shape, payload, tenants: [active, other] }) => {
        const args = deepFreeze(shape.args(payload.build(active, other)));
        const common = { operation: shape.operation, args, tenantId: active };
        expect(planTenantScope({ ...common, mode: "off", model: "Post", unscoped: false })).toEqual(
          { action: "passthrough" },
        );
        expect(
          planTenantScope({ ...common, mode: "enforce", model: "Post", unscoped: true }),
        ).toEqual({ action: "passthrough" });
        expect(
          planTenantScope({ ...common, mode: "enforce", model: "TenantMember", unscoped: false }),
        ).toEqual({ action: "passthrough" });
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Nested links: enforce narrows connect/set/disconnect/connectOrCreate.where
// into scoped models to the active tenant
// ---------------------------------------------------------------------------

/**
 * Link payloads on a Post row. `build` returns the payload and the payload
 * enforce must produce from it (`t` is the active tenant).
 */
const LINK_PAYLOADS: ReadonlyArray<{
  name: string;
  build: (t: string) => { raw: Payload; narrowed: Payload };
}> = [
  {
    name: "to-many connect",
    build: (t) => ({
      raw: { comments: { connect: { id: "c1" } } },
      narrowed: { comments: { connect: { id: "c1", tenantId: t } } },
    }),
  },
  {
    name: "to-many connect array",
    build: (t) => ({
      raw: { comments: { connect: [{ id: "c1" }, { id: "c2" }] } },
      narrowed: {
        comments: {
          connect: [
            { id: "c1", tenantId: t },
            { id: "c2", tenantId: t },
          ],
        },
      },
    }),
  },
  {
    name: "to-one connect",
    build: (t) => ({
      raw: { primaryEntity: { connect: { id: "e1" } } },
      narrowed: { primaryEntity: { connect: { id: "e1", tenantId: t } } },
    }),
  },
  {
    name: "set",
    build: (t) => ({
      raw: { comments: { set: [{ id: "c1" }] } },
      narrowed: { comments: { set: [{ id: "c1", tenantId: t }] } },
    }),
  },
  {
    name: "disconnect by selector, and to-one disconnect: true",
    build: (t) => ({
      raw: { comments: { disconnect: { id: "c1" } }, group: { disconnect: true } },
      narrowed: {
        comments: { disconnect: { id: "c1", tenantId: t } },
        group: { disconnect: true },
      },
    }),
  },
  {
    name: "connectOrCreate",
    build: (t) => ({
      raw: { comments: { connectOrCreate: { where: { id: "c1" }, create: { body: "c" } } } },
      narrowed: {
        comments: {
          connectOrCreate: { where: { id: "c1", tenantId: t }, create: { body: "c" } },
        },
      },
    }),
  },
  {
    name: "another tenant's id in the selector is overridden, not trusted",
    build: (t) => ({
      raw: { comments: { connect: { id: "c1", tenantId: "someone-else" } } },
      narrowed: { comments: { connect: { id: "c1", tenantId: t } } },
    }),
  },
  {
    name: "connect nested inside a nested create",
    build: (t) => ({
      raw: { comments: { create: { body: "c", post: { connect: { id: "p2" } } } } },
      narrowed: {
        comments: { create: { body: "c", post: { connect: { id: "p2", tenantId: t } } } },
      },
    }),
  },
  {
    name: "connect nested inside a to-many update",
    build: (t) => ({
      raw: {
        comments: { update: { where: { id: "c1" }, data: { post: { connect: { id: "p2" } } } } },
      },
      narrowed: {
        comments: {
          update: { where: { id: "c1" }, data: { post: { connect: { id: "p2", tenantId: t } } } },
        },
      },
    }),
  },
  {
    name: "connect into a by-relation child that carries tenantId",
    build: (t) => ({
      raw: { media: { connect: { id: "pm1" } } },
      narrowed: { media: { connect: { id: "pm1", tenantId: t } } },
    }),
  },
  {
    name: "compound unique selector",
    build: (t) => ({
      raw: { comments: { connect: { postId_order: { postId: "p1", order: 1 } } } },
      narrowed: {
        comments: { connect: { postId_order: { postId: "p1", order: 1 }, tenantId: t } },
      },
    }),
  },
  {
    name: "to-one disconnect: true alone is not a link",
    build: () => ({
      raw: { group: { disconnect: true } },
      narrowed: { group: { disconnect: true } },
    }),
  },
  {
    name: "connect into an unscoped model is left alone",
    build: () => ({
      raw: { author: { connect: { id: "u1" } } },
      narrowed: { author: { connect: { id: "u1" } } },
    }),
  },
];

/** The write payload of `args` for an operation. */
function payloadsOf(operation: string, args: Record<string, unknown>): unknown[] {
  return operation === "upsert" ? [args.create, args.update] : [args.data];
}

const linkCase = fc.record({
  shape: fc.constantFrom(...WRITE_SHAPES),
  link: fc.constantFrom(...LINK_PAYLOADS),
  active: fc.uuid(),
});

describe("planTenantScope — enforce narrows nested links to the active tenant", () => {
  it("adds the active tenant to every link into a scoped model and changes nothing else", () => {
    fc.assert(
      fc.property(linkCase, ({ shape, link, active }) => {
        const { raw, narrowed } = link.build(active);
        const plan = planTenantScope({
          mode: "enforce",
          model: "Post",
          operation: shape.operation,
          args: deepFreeze(shape.args(raw)),
          tenantId: active,
          unscoped: false,
        });
        // Planning from the narrowed payload must give the same result: the
        // narrowing is the only change, and it is idempotent.
        const fromNarrowed = planTenantScope({
          mode: "enforce",
          model: "Post",
          operation: shape.operation,
          args: deepFreeze(shape.args(narrowed)),
          tenantId: active,
          unscoped: false,
        });
        expect(fromNarrowed).toEqual(plan);
        const unchanged = JSON.stringify(raw) === JSON.stringify(narrowed);
        if (shape.operation === "update") {
          // A by-unique update is rewritten only when a link was narrowed.
          expect(plan).toEqual(
            unchanged
              ? { action: "passthrough" }
              : { action: "rewrite", args: shape.args(narrowed) },
          );
          return;
        }
        expect(plan.action).toBe("rewrite");
        const out = (plan as { args: Record<string, unknown> }).args;
        const expected = payloadsOf(shape.operation, shape.args(narrowed));
        const stamp = (row: unknown) => ({ ...(row as object), tenantId: active });
        payloadsOf(shape.operation, out).forEach((p, i) => {
          const creates =
            shape.operation === "create" ||
            shape.operation.startsWith("createMany") ||
            (shape.operation === "upsert" && i === 0);
          const want = expected[i];
          expect(p).toEqual(creates ? (Array.isArray(want) ? want.map(stamp) : stamp(want)) : want);
        });
      }),
    );
  });

  it("shadow does not rewrite links", () => {
    fc.assert(
      fc.property(linkCase, ({ shape, link, active }) => {
        const plan = planTenantScope({
          mode: "shadow",
          model: "Post",
          operation: shape.operation,
          args: deepFreeze(shape.args(link.build(active).raw)),
          tenantId: active,
          unscoped: false,
        });
        expect(plan.action).toBe("observe");
        expect((plan as { wouldReject?: string }).wouldReject).toBeUndefined();
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unscoped roots: nested writes into scoped models are held to the active tenant
// ---------------------------------------------------------------------------

/** User-rooted writes whose payload nests a Post row under `posts`. */
const USER_ROOTS: ReadonlyArray<{
  name: string;
  operation: string;
  args: (posts: Payload) => Record<string, unknown>;
}> = [
  { name: "create", operation: "create", args: (posts) => ({ data: { email: "e", posts } }) },
  {
    name: "update",
    operation: "update",
    args: (posts) => ({ where: { id: "u1" }, data: { posts } }),
  },
  {
    name: "upsert.create",
    operation: "upsert",
    args: (posts) => ({ where: { id: "u1" }, create: { email: "e", posts }, update: {} }),
  },
  {
    name: "upsert.update",
    operation: "upsert",
    args: (posts) => ({ where: { id: "u1" }, create: { email: "e" }, update: { posts } }),
  },
];

/** The nested-write operators that carry a Post row under `User.posts`. */
const NESTS: ReadonlyArray<{ name: string; links: boolean; wrap: (row: Payload) => Payload }> = [
  { name: "create", links: true, wrap: (row) => ({ create: row }) },
  { name: "create[]", links: true, wrap: (row) => ({ create: [{ body: "a" }, row] }) },
  {
    name: "update { where, data }",
    links: true,
    wrap: (row) => ({ update: { where: { id: "p1" }, data: row } }),
  },
  {
    name: "upsert (both halves)",
    links: true,
    wrap: (row) => ({ upsert: { where: { id: "p1" }, create: row, update: row } }),
  },
  // createMany/updateMany rows cannot nest relation writes, so only the
  // reassignment check applies to them.
  { name: "createMany", links: false, wrap: (row) => ({ createMany: { data: [row] } }) },
];

const userRootCase = fc.record({
  root: fc.constantFrom(...USER_ROOTS),
  nest: fc.constantFrom(...NESTS),
  payload: fc.constantFrom(...PAYLOADS),
  tenants: tenantPair,
});

describe("planTenantScope — writes rooted at an unscoped model", () => {
  it("enforce throws exactly when a nested scoped row reassigns the tenant", () => {
    fc.assert(
      fc.property(userRootCase, ({ root, nest, payload, tenants: [active, other] }) => {
        const args = deepFreeze(root.args(nest.wrap(payload.build(active, other))));
        const plan = planTenantScope({
          mode: "enforce",
          model: "User",
          operation: root.operation,
          args,
          tenantId: active,
          unscoped: false,
        });
        if (payload.reject) {
          expect(plan.action).toBe("throw");
          expect((plan as { message: string }).message).toContain(`User.${root.operation}`);
          expect((plan as { message: string }).message).not.toContain(other);
        } else {
          // Nothing to narrow in PAYLOADS, so the op is untouched.
          expect(plan).toEqual({ action: "passthrough" });
        }
      }),
    );
  });

  it("shadow flags exactly the writes enforce would reject and otherwise stays silent", () => {
    fc.assert(
      fc.property(userRootCase, ({ root, nest, payload, tenants: [active, other] }) => {
        const plan = planTenantScope({
          mode: "shadow",
          model: "User",
          operation: root.operation,
          args: deepFreeze(root.args(nest.wrap(payload.build(active, other)))),
          tenantId: active,
          unscoped: false,
        });
        if (payload.reject) {
          expect(plan).toMatchObject({ action: "observe", wouldScope: false });
          expect(typeof (plan as { wouldReject?: string }).wouldReject).toBe("string");
        } else {
          expect(plan).toEqual({ action: "passthrough" });
        }
      }),
    );
  });

  it("no tenant context, runUnscoped and off pass through untouched", () => {
    fc.assert(
      fc.property(userRootCase, ({ root, nest, payload, tenants: [active, other] }) => {
        const args = deepFreeze(root.args(nest.wrap(payload.build(active, other))));
        const common = { model: "User", operation: root.operation, args };
        for (const input of [
          { ...common, mode: "enforce" as const, tenantId: undefined, unscoped: false },
          { ...common, mode: "enforce" as const, tenantId: active, unscoped: true },
          { ...common, mode: "off" as const, tenantId: active, unscoped: false },
        ]) {
          expect(planTenantScope(input)).toEqual({ action: "passthrough" });
        }
      }),
    );
  });

  it("narrows links under every nesting operator and both upsert halves", () => {
    fc.assert(
      fc.property(
        fc.record({
          root: fc.constantFrom(...USER_ROOTS),
          nest: fc.constantFrom(...NESTS.filter((n) => n.links)),
          link: fc.constantFrom(...LINK_PAYLOADS),
          active: fc.uuid(),
        }),
        ({ root, nest, link, active }) => {
          const { raw, narrowed } = link.build(active);
          const plan = planTenantScope({
            mode: "enforce",
            model: "User",
            operation: root.operation,
            args: deepFreeze(root.args(nest.wrap(raw))),
            tenantId: active,
            unscoped: false,
          });
          const unchanged = JSON.stringify(raw) === JSON.stringify(narrowed);
          expect(plan).toEqual(
            unchanged
              ? { action: "passthrough" }
              : { action: "rewrite", args: root.args(nest.wrap(narrowed)) },
          );
        },
      ),
    );
  });

  it("fails closed for a model missing from the schema: links under it are narrowed", () => {
    const plan = planTenantScope({
      ...base,
      model: "NotInSchema",
      mode: "enforce",
      operation: "update",
      args: deepFreeze({ where: { id: "x" }, data: { anything: { connect: { id: "y" } } } }),
    });
    expect(plan).toEqual({
      action: "rewrite",
      args: {
        where: { id: "x" },
        data: { anything: { connect: { id: "y", tenantId: "t-acme" } } },
      },
    });
  });

  it("narrows a nested link into a scoped model", () => {
    const plan = planTenantScope({
      ...base,
      model: "User",
      mode: "enforce",
      operation: "update",
      args: deepFreeze({ where: { id: "u1" }, data: { posts: { connect: { id: "p1" } } } }),
    });
    expect(plan).toEqual({
      action: "rewrite",
      args: { where: { id: "u1" }, data: { posts: { connect: { id: "p1", tenantId: "t-acme" } } } },
    });
  });

  it("does not hold the unscoped row's own tenantId or tenant relation to the active tenant", () => {
    // Joining another tenant is a TenantMember write with that tenant's id.
    for (const data of [
      { tenantId: "t-other", userId: "u1" },
      { tenant: { connect: { id: "t-other" } }, user: { connect: { id: "u1" } } },
    ]) {
      expect(
        planTenantScope({
          ...base,
          model: "TenantMember",
          mode: "enforce",
          operation: "create",
          args: deepFreeze({ data }),
        }),
      ).toEqual({ action: "passthrough" });
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
