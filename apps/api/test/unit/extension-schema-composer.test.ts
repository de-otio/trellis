/**
 * PURE unit tests for the O-1 L2 fragment composer (mock-free, coverage-gated).
 * Covers parse / validate / inject / idempotency / registry-generation, plus a
 * fast-check property that the ext-model naming guard is sound. No fs mocking —
 * fixtures are read as ordinary deterministic input; the composer itself is a
 * pure string→string function.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ComposeError,
  CORE_ERASURE_TARGETS,
  composeSchema,
  delegateKey,
  deriveBackRelations,
  extModelPattern,
  generateRegistry,
  injectBackRelations,
  parseFragment,
  validateModel,
  type FragmentInput,
  type ParsedModel,
} from "../../src/lib/extension-schema-composer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../fixtures/extension-schema");
const readFix = (name: string): string =>
  readFileSync(path.join(FIX, name), "utf8");

const VALID_FRAGMENT = readFix("widget.valid.prisma");
const CORE_STUB = readFix("core-stub.prisma");
const ALLOW = new Set(["User", "Entity", "Tenant"]);

function widgetFragments(source = VALID_FRAGMENT): FragmentInput[] {
  return [{ extensionId: "widget", source }];
}

describe("parseFragment", () => {
  it("parses models, fields, relations, @@map and erasure docs", () => {
    const models = parseFragment("widget", VALID_FRAGMENT);
    expect(models.map((m) => m.name)).toEqual([
      "ext_widget__records",
      "ext_widget__reminders",
    ]);

    const records = models[0];
    expect(records.mapTarget).toBe("ext_widget__records");
    expect(records.erasure).toEqual({ kind: "subject", field: "createdBy" });
    // Relations are NOT recorded as scalar fields.
    expect(records.fields.map((f) => f.name)).toEqual([
      "id",
      "tenantId",
      "entityId",
      "createdBy",
      "kind",
      "data",
      "createdAt",
    ]);
    expect(records.fields.find((f) => f.name === "tenantId")?.mapColumn).toBe(
      "tenant_id",
    );
    expect(records.relations).toEqual([
      {
        field: "tenant",
        target: "Tenant",
        fields: ["tenantId"],
        onDelete: "Cascade",
      },
      {
        field: "entity",
        target: "Entity",
        fields: ["entityId"],
        onDelete: "Cascade",
      },
    ]);

    expect(models[1].erasure).toEqual({ kind: "cascade-only" });
  });

  it("recognises none-personal erasure directive", () => {
    const src = `/// erasure: none-personal
model ext_widget__log {
  id       String @id @default(cuid())
  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("ext_widget__log")
}`;
    const [m] = parseFragment("widget", src);
    expect(m.erasure).toEqual({ kind: "none-personal" });
  });

  it("returns null erasure when no directive is present", () => {
    const src = `model ext_widget__x {
  id       String @id
  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("ext_widget__x")
}`;
    const [m] = parseFragment("widget", src);
    expect(m.erasure).toBeNull();
  });

  it("ignores // line comments and blank lines", () => {
    const src = `// a leading comment
\n
model ext_widget__x { // trailing
  id       String @id // pk
  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("ext_widget__x")
}`;
    const [m] = parseFragment("widget", src);
    expect(m.name).toBe("ext_widget__x");
    expect(m.fields.map((f) => f.name)).toEqual(["id", "tenantId"]);
  });

  it("throws on a non-model top-level block", () => {
    expect(() =>
      parseFragment("widget", `enum Foo {\n  A\n}`),
    ).toThrow(ComposeError);
  });

  it("throws on unbalanced braces", () => {
    expect(() =>
      parseFragment("widget", `model ext_widget__x {\n  id String @id`),
    ).toThrow(/unbalanced braces/);
  });

  it("throws on an unparseable field line", () => {
    expect(() =>
      parseFragment(
        "widget",
        `model ext_widget__x {\n  @invalid-token-here!!\n}`,
      ),
    ).toThrow(ComposeError);
  });

  it("resets dangling docs on stray non-block content", () => {
    // A doc comment followed by stray content, then a real model with its own
    // doc — the stray content must not attach the earlier doc to the model.
    const src = `/// erasure: none-personal
someStrayLine
/// erasure: subject=createdBy
model ext_widget__x {
  id        String @id
  tenantId  String @map("tenant_id")
  createdBy String @map("created_by")
  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("ext_widget__x")
}`;
    const [m] = parseFragment("widget", src);
    expect(m.erasure).toEqual({ kind: "subject", field: "createdBy" });
  });
});

describe("extModelPattern", () => {
  it("matches only ext_<id>__<snake> names", () => {
    const re = extModelPattern("widget");
    expect(re.test("ext_widget__records")).toBe(true);
    expect(re.test("ext_widget__a_b_1")).toBe(true);
    expect(re.test("ext_other__records")).toBe(false);
    expect(re.test("Records")).toBe(false);
    expect(re.test("ext_widget__")).toBe(false);
    expect(re.test("ext_widget__Records")).toBe(false); // uppercase suffix
  });
});

describe("validateModel", () => {
  const model = (): ParsedModel => parseFragment("widget", VALID_FRAGMENT)[0];

  it("accepts a valid model", () => {
    expect(() => validateModel(model(), ALLOW)).not.toThrow();
  });

  it("rejects a model name not matching ext_<id>__", () => {
    const m = { ...model(), name: "Records" };
    expect(() => validateModel(m, ALLOW)).toThrow(/must match ext_widget__/);
  });

  it("rejects a missing @@map", () => {
    const m = { ...model(), mapTarget: null };
    expect(() => validateModel(m, ALLOW)).toThrow(/missing @@map/);
  });

  it("rejects an @@map target that does not match ext_<id>__", () => {
    const m = { ...model(), mapTarget: "records" };
    expect(() => validateModel(m, ALLOW)).toThrow(/@@map target/);
  });

  it("rejects an FK target outside the allowlist", () => {
    const m = model();
    expect(() =>
      validateModel(m, new Set(["Tenant"])),
    ).toThrow(/not in the FK allowlist/);
  });

  it("rejects a model with no tenant relation", () => {
    const m: ParsedModel = {
      ...model(),
      relations: model().relations.filter((r) => r.target !== "Tenant"),
    };
    expect(() => validateModel(m, ALLOW)).toThrow(/mandatory tenant relation/);
  });

  it("rejects a tenant relation that is not onDelete: Cascade", () => {
    const m: ParsedModel = {
      ...model(),
      relations: model().relations.map((r) =>
        r.target === "Tenant" ? { ...r, onDelete: "SetNull" } : r,
      ),
    };
    expect(() => validateModel(m, ALLOW)).toThrow(/must be onDelete: Cascade/);
  });

  it("rejects a tenant relation that names zero FK fields", () => {
    const m: ParsedModel = {
      ...model(),
      relations: model().relations.map((r) =>
        r.target === "Tenant" ? { ...r, fields: [] } : r,
      ),
    };
    expect(() => validateModel(m, ALLOW)).toThrow(/exactly one scalar FK field/);
  });

  it("rejects a model with no erasure declaration", () => {
    const m = { ...model(), erasure: null };
    expect(() => validateModel(m, ALLOW)).toThrow(/cannot forget GDPR/);
  });

  it("rejects a subject field that is not a declared scalar", () => {
    const m: ParsedModel = {
      ...model(),
      erasure: { kind: "subject", field: "ghostField" },
    };
    expect(() => validateModel(m, ALLOW)).toThrow(/not a declared scalar field/);
  });

  it("rejects cascade-only when a core FK is not Cascade", () => {
    const base = parseFragment("widget", VALID_FRAGMENT)[1]; // cascade-only model
    const m: ParsedModel = {
      ...base,
      relations: base.relations.map((r) =>
        r.target === "Entity" ? { ...r, onDelete: "Restrict" } : r,
      ),
    };
    expect(() => validateModel(m, ALLOW)).toThrow(/is not onDelete: Cascade/);
  });

  it("exposes the three core erasure targets", () => {
    expect([...CORE_ERASURE_TARGETS].sort()).toEqual([
      "Entity",
      "Tenant",
      "User",
    ]);
  });
});

describe("deriveBackRelations + injectBackRelations", () => {
  it("derives one back-relation per (core model, ext model) FK", () => {
    const models = parseFragment("widget", VALID_FRAGMENT);
    const backs = deriveBackRelations(models);
    // 2 models × {Tenant, Entity} = 4 back-relations.
    expect(backs).toHaveLength(4);
    expect(backs).toContainEqual({
      coreModel: "Entity",
      fieldLine: "  ext_widget__records ext_widget__records[]",
    });
    expect(backs).toContainEqual({
      coreModel: "Tenant",
      fieldLine: "  ext_widget__reminders ext_widget__reminders[]",
    });
  });

  it("injects the reverse field into the named core model", () => {
    const backs = [
      { coreModel: "Entity", fieldLine: "  ext_widget__records ext_widget__records[]" },
    ];
    const out = injectBackRelations(CORE_STUB, backs);
    expect(out).toMatch(
      /model Entity \{\n {2}ext_widget__records ext_widget__records\[\]/,
    );
    // Tenant + User untouched.
    expect(out).toMatch(/model Tenant \{\n {2}id String/);
  });

  it("throws when the target core model is absent", () => {
    expect(() =>
      injectBackRelations(CORE_STUB, [
        { coreModel: "Nonexistent", fieldLine: "  x X[]" },
      ]),
    ).toThrow(/not found in the core schema/);
  });
});

describe("generateRegistry + delegateKey", () => {
  it("registers every model; only subject-erasure carries erasureSubjectField; entity FK → fkFields", () => {
    const models = parseFragment("widget", VALID_FRAGMENT);
    const reg = generateRegistry(models);
    // Both widget models declare `entity Entity @relation(fields:[entityId])`,
    // so each carries an fkFields entry for the FK-tenant check (security F3/B4).
    // The tenant relation is the tenantField (not an fkField).
    const entityFk = [
      { field: "entityId", targetModel: "entity", targetTenantField: "tenantId" },
    ];
    expect(reg).toEqual([
      {
        model: "ext_widget__records",
        tenantField: "tenantId",
        erasureSubjectField: "createdBy",
        fkFields: entityFk,
      },
      {
        model: "ext_widget__reminders",
        tenantField: "tenantId",
        erasureSubjectField: null,
        fkFields: entityFk,
      },
    ]);
  });

  it("delegateKey lowercases the first char (identity for ext_ names)", () => {
    expect(delegateKey("ext_widget__records")).toBe("ext_widget__records");
    expect(delegateKey("Entity")).toBe("entity");
  });

  it("falls back to tenantId when a model somehow lacks a tenant relation", () => {
    const m: ParsedModel = {
      name: "ext_widget__x",
      mapTarget: "ext_widget__x",
      fields: [],
      relations: [],
      erasure: { kind: "none-personal" },
      extensionId: "widget",
    };
    expect(generateRegistry([m])[0].tenantField).toBe("tenantId");
  });
});

describe("composeSchema", () => {
  it("composes a valid fragment: injected back-relations + appended fragment + registry", () => {
    const result = composeSchema({
      coreSchema: CORE_STUB,
      fragments: widgetFragments(),
      fkAllowlist: ALLOW,
    });

    // Back-relations injected into core.
    expect(result.schema).toContain("ext_widget__records ext_widget__records[]");
    expect(result.schema).toContain("ext_widget__reminders ext_widget__reminders[]");
    // Fragment models appended under the composed section.
    expect(result.schema).toContain("// ---- composed extension fragments (O-1) ----");
    expect(result.schema).toContain("model ext_widget__records {");
    // Registry generated.
    expect(result.registry.map((e) => e.model)).toEqual([
      "ext_widget__records",
      "ext_widget__reminders",
    ]);
    expect(result.models).toHaveLength(2);
  });

  it("is deterministic — same inputs yield a byte-identical schema (idempotency)", () => {
    const input = {
      coreSchema: CORE_STUB,
      fragments: widgetFragments(),
      fkAllowlist: ALLOW,
    };
    const a = composeSchema(input);
    const b = composeSchema(input);
    expect(a.schema).toBe(b.schema);
    expect(a.registry).toEqual(b.registry);
  });

  it("returns the core schema unchanged when there are no fragments", () => {
    const result = composeSchema({
      coreSchema: CORE_STUB,
      fragments: [],
      fkAllowlist: ALLOW,
    });
    expect(result.schema).toBe(CORE_STUB);
    expect(result.registry).toEqual([]);
  });

  it("rejects a duplicate model name across fragments", () => {
    expect(() =>
      composeSchema({
        coreSchema: CORE_STUB,
        fragments: [
          { extensionId: "widget", source: VALID_FRAGMENT },
          { extensionId: "widget", source: VALID_FRAGMENT },
        ],
        fkAllowlist: ALLOW,
      }),
    ).toThrow(/duplicate model name/);
  });

  it("rejects a fragment that redefines a core model", () => {
    const src = `/// erasure: none-personal
model Tenant {
  id       String @id
  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@map("ext_widget__tenant")
}`;
    expect(() =>
      composeSchema({
        coreSchema: CORE_STUB,
        fragments: [{ extensionId: "widget", source: src }],
        fkAllowlist: ALLOW,
      }),
    ).toThrow(/may not redefine core/);
  });

  it("propagates a validation failure from a bad fragment", () => {
    const src = `/// erasure: none-personal
model ext_widget__bad {
  id       String @id
  tenantId String @map("tenant_id")
  tenant   Tenant @relation(fields: [tenantId], references: [id])
  @@map("ext_widget__bad")
}`;
    expect(() =>
      composeSchema({
        coreSchema: CORE_STUB,
        fragments: [{ extensionId: "widget", source: src }],
        fkAllowlist: ALLOW,
      }),
    ).toThrow(/must be onDelete: Cascade/);
  });
});

describe("property: ext-model naming guard is sound (fast-check)", () => {
  const extId = fc
    .stringMatching(/^[a-z][a-z0-9]{1,10}$/)
    .filter((s) => s.length >= 2);
  const suffix = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

  it("a well-formed ext_<id>__<snake> name always matches its pattern", () => {
    fc.assert(
      fc.property(extId, suffix, (id, snake) => {
        const name = `ext_${id}__${snake}`;
        return extModelPattern(id).test(name);
      }),
    );
  });

  it("a name built for a DIFFERENT extension never matches", () => {
    fc.assert(
      fc.property(extId, extId, suffix, (a, b, snake) => {
        fc.pre(a !== b);
        const name = `ext_${b}__${snake}`;
        return !extModelPattern(a).test(name);
      }),
    );
  });

  it("generateRegistry never emits an empty model or tenantField (Phase 0 contract)", () => {
    const models = parseFragment("widget", VALID_FRAGMENT);
    for (const entry of generateRegistry(models)) {
      expect(entry.model.length).toBeGreaterThan(0);
      expect(entry.tenantField.length).toBeGreaterThan(0);
      expect(
        entry.erasureSubjectField === null ||
          typeof entry.erasureSubjectField === "string",
      ).toBe(true);
    }
  });
});
