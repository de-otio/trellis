import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CORE_SCOPED_DELEGATE_META,
  PROVENANCE_PROTECTED_FIELDS,
  planScopedOp,
  type ScopedModelMeta,
} from "../../src/lib/extension-scoped-db.js";

/**
 * The AI Act Art. 50 extension-review criterion, enforced in the DATA LAYER.
 *
 * Before this, the criterion ("an extension must not write provenance fields
 * directly, suppress an existing value, or downgrade one") was honour-system:
 * `post` and `postMedia` are on the scoped extension surface with create, update,
 * updateMany and upsert all permitted, and monotonicity lives in the core
 * handlers, which the scoped surface bypasses entirely. An extension is precisely
 * where a vertical adds a generation feature, so this was the likeliest place for
 * a real violation.
 */

const meta = (model: string): ScopedModelMeta => {
  const found = CORE_SCOPED_DELEGATE_META.find((m) => m.model === model);
  if (!found) throw new Error(`no meta for ${model}`);
  return found;
};

const PROTECTED_MODELS = ["post", "postMedia"] as const;
const WRITE_OPS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
] as const;

/** Build the args shape each write op expects, carrying `data` as its payload. */
function argsFor(operation: string, data: Record<string, unknown>) {
  switch (operation) {
    case "createMany":
      return { data: [data] };
    case "update":
    case "updateMany":
      return { where: { id: "p1" }, data };
    case "upsert":
      return { where: { id: "p1" }, create: data, update: data };
    default:
      return { data };
  }
}

describe("provenance columns are unwritable from the scoped extension surface", () => {
  it("every write op on every protected model rejects every protected field", () => {
    // The full cross product, because a guard added to four of five branches is
    // the realistic failure — `upsert` in particular carries TWO payloads
    // (create and update) and is the one most likely to be missed.
    for (const model of PROTECTED_MODELS) {
      for (const operation of WRITE_OPS) {
        for (const field of PROVENANCE_PROTECTED_FIELDS) {
          const plan = planScopedOp({
            meta: meta(model),
            operation,
            args: argsFor(operation, { text: "hi", [field]: "AI_GENERATED" }),
            tenantId: "t1",
          });
          expect(plan.kind, `${operation} ${model}.${field}`).toBe("reject");
          if (plan.kind === "reject") {
            expect(plan.message).toContain(field);
            // The message must say WHY, so an extension author does not simply
            // rename the field and try again.
            expect(plan.message).toMatch(/Art\. 50|provenance/i);
          }
        }
      }
    }
  });

  it("rejects an upsert that hides the write in ONLY the update branch", () => {
    // The asymmetric case: a create payload that looks innocent, with the
    // downgrade tucked into the branch that runs on the second call.
    const plan = planScopedOp({
      meta: meta("post"),
      operation: "upsert",
      args: {
        where: { id: "p1" },
        create: { text: "hi" },
        update: { textSourceType: "HUMAN_CREATED" },
      },
      tenantId: "t1",
    });
    expect(plan.kind).toBe("reject");
  });

  it("rejects a createMany where only ONE row in the batch carries the field", () => {
    const plan = planScopedOp({
      meta: meta("post"),
      operation: "createMany",
      args: {
        data: [{ text: "a" }, { text: "b", textBasis: "PLATFORM_GENERATED" }],
      },
      tenantId: "t1",
    });
    expect(plan.kind).toBe("reject");
  });

  it("rejects on PRESENCE, not on value — an explicit undefined is still refused", () => {
    // Prisma treats `undefined` as "omit", so this write would be harmless. It is
    // refused anyway: the point is to make the INTENT fail loudly, so an
    // extension that computes the value conditionally cannot pass review and then
    // attempt the write at runtime.
    const plan = planScopedOp({
      meta: meta("post"),
      operation: "update",
      args: { where: { id: "p1" }, data: { textSourceType: undefined } },
      tenantId: "t1",
    });
    expect(plan.kind).toBe("reject");
  });

  it("refuses to LOWER a declaration — the laundering path specifically", () => {
    // The concrete attack: an extension quietly rewrites AI_GENERATED to
    // HUMAN_CREATED after the core handler recorded it. Monotonicity does not
    // protect this path, because monotonicity lives in the handler.
    for (const lowered of ["HUMAN_CREATED", "UNKNOWN"]) {
      const plan = planScopedOp({
        meta: meta("postMedia"),
        operation: "update",
        args: {
          where: { id: "pm1" },
          data: { declaredSourceType: lowered },
        },
        tenantId: "t1",
      });
      expect(plan.kind).toBe("reject");
    }
  });

  it("does NOT break ordinary writes to unprotected columns", () => {
    // The guard must be narrow. If this fails, extensions are broken.
    const plan = planScopedOp({
      meta: meta("post"),
      operation: "create",
      args: { data: { text: "an ordinary post", radius: "NORMAL" } },
      tenantId: "t1",
    });
    expect(plan.kind).toBe("call");
  });

  it("leaves READS of provenance untouched — an extension may see the label", () => {
    // Reading is not writing. An extension that renders a feed needs the label,
    // and hiding a disclosure from it would defeat the purpose of having one.
    for (const operation of ["findMany", "findFirst", "findUnique", "count"]) {
      const plan = planScopedOp({
        meta: meta("post"),
        operation,
        args: { where: { textSourceType: "AI_GENERATED" } },
        tenantId: "t1",
      });
      expect(plan.kind, operation).not.toBe("reject");
    }
  });

  it("property: no protected field ever survives into a write payload", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROTECTED_MODELS),
        fc.constantFrom(...WRITE_OPS),
        fc.constantFrom(...PROVENANCE_PROTECTED_FIELDS),
        fc.jsonValue(),
        (model, operation, field, value) => {
          const plan = planScopedOp({
            meta: meta(model),
            operation,
            args: argsFor(operation, { [field]: value }),
            tenantId: "t1",
          });
          // Whatever the value — string, null, object, nested — the op is refused,
          // so no shape of it can reach the database.
          expect(plan.kind).toBe("reject");
        },
      ),
    );
  });
});

describe("the protected-field declaration itself", () => {
  it("post and postMedia declare the provenance set", () => {
    for (const model of PROTECTED_MODELS) {
      expect(meta(model).protectedFields).toEqual(PROVENANCE_PROTECTED_FIELDS);
    }
  });

  it("every core delegate declares protectedFields explicitly", () => {
    // `protectedFields` is a REQUIRED interface field so that a newly exposed core
    // model cannot be added without stating its protected set. This asserts the
    // runtime consequence: no delegate has it undefined, which would make
    // guardProtectedFields iterate nothing and fail open.
    for (const m of CORE_SCOPED_DELEGATE_META) {
      expect(Array.isArray(m.protectedFields), m.model).toBe(true);
    }
  });

  it("covers both text and media provenance columns, and the intrinsic reading", () => {
    // A partial list is the quiet failure mode: protecting `textSourceType` but
    // not `textBasis` would still let an extension forge PLATFORM_GENERATED.
    for (const field of [
      "textSourceType",
      "textBasis",
      "declaredSourceType",
      "declaredBasis",
      "embeddedSourceType",
      "provenanceExamined",
    ]) {
      expect(PROVENANCE_PROTECTED_FIELDS).toContain(field);
    }
  });
});
