import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_MODEL_REGISTRY,
  getExtensionModelRegistry,
  setExtensionModelRegistry,
  freezeExtensionModelRegistry,
  __resetExtensionModelRegistryForTest,
  type ExtensionModelRegistryEntry,
} from "../../src/lib/extension-model-registry.js";
import {
  buildScopedModelMetas,
  registryToMetas,
} from "../../src/lib/extension-scoped-db.js";

describe("EXTENSION_MODEL_REGISTRY (Phase 0 contract stub)", () => {
  it("is an array", () => {
    expect(Array.isArray(EXTENSION_MODEL_REGISTRY)).toBe(true);
  });

  it("is empty today — no extension owns tables yet", () => {
    expect(EXTENSION_MODEL_REGISTRY).toHaveLength(0);
  });

  it("every entry (when populated by L2) carries the isolation + erasure contract", () => {
    // Guards the shape the three consumers (L1/L2/L4) agreed on: a non-empty
    // model name, a tenant field, and an erasureSubjectField that is a string
    // or explicitly null. Vacuously true today; fails if L2 emits a bad entry.
    for (const entry of EXTENSION_MODEL_REGISTRY as ExtensionModelRegistryEntry[]) {
      expect(typeof entry.model).toBe("string");
      expect(entry.model.length).toBeGreaterThan(0);
      expect(typeof entry.tenantField).toBe("string");
      expect(entry.tenantField.length).toBeGreaterThan(0);
      expect(
        entry.erasureSubjectField === null ||
          typeof entry.erasureSubjectField === "string",
      ).toBe(true);
    }
  });
});

describe("boot-time injection seam (plan 011 Phase B / security F5)", () => {
  const DOG_PRIVATE: ExtensionModelRegistryEntry = {
    model: "ext_dog__private",
    tenantField: "tenantId",
    erasureSubjectField: "createdByUserId",
    fkFields: [
      { field: "entityId", targetModel: "entity", targetTenantField: "tenantId" },
    ],
  };

  afterEach(() => {
    __resetExtensionModelRegistryForTest();
  });

  it("defaults to the empty compiled-in registry", () => {
    expect(getExtensionModelRegistry()).toEqual([]);
  });

  it("returns the injected registry after setExtensionModelRegistry", () => {
    setExtensionModelRegistry([DOG_PRIVATE]);
    expect(getExtensionModelRegistry()).toEqual([DOG_PRIVATE]);
  });

  it("throws if set after freeze (no mutation once serving)", () => {
    freezeExtensionModelRegistry();
    expect(() => setExtensionModelRegistry([DOG_PRIVATE])).toThrow(/frozen/);
  });

  it("makes the injected model reachable on the scoped surface", () => {
    setExtensionModelRegistry([DOG_PRIVATE]);
    const metas = buildScopedModelMetas();
    // The owned model is present (a real delegate, not blocked)...
    expect(metas.has("ext_dog__private")).toBe(true);
    expect(metas.get("ext_dog__private")?.tenantField).toBe("tenantId");
    // ...with its FK-tenant check populated (security F3/B4)...
    expect(metas.get("ext_dog__private")?.fkFields).toEqual([
      { field: "entityId", targetModel: "entity", targetTenantField: "tenantId" },
    ]);
    // ...and the core delegates are still present.
    expect(metas.has("entity")).toBe(true);
  });

  it("is absent from the scoped surface when nothing is injected", () => {
    const metas = buildScopedModelMetas();
    expect(metas.has("ext_dog__private")).toBe(false);
  });

  it("caches the assembled metas per registry identity, invalidating on change", () => {
    setExtensionModelRegistry([DOG_PRIVATE]);
    const first = buildScopedModelMetas();
    expect(buildScopedModelMetas()).toBe(first); // same reference (cached)
    __resetExtensionModelRegistryForTest();
    setExtensionModelRegistry([DOG_PRIVATE]); // new array reference
    expect(buildScopedModelMetas()).not.toBe(first); // cache invalidated
  });

  it("registryToMetas maps fkFields through (empty when omitted)", () => {
    expect(registryToMetas([DOG_PRIVATE])[0].fkFields).toEqual(DOG_PRIVATE.fkFields);
    expect(
      registryToMetas([{ ...DOG_PRIVATE, fkFields: undefined }])[0].fkFields,
    ).toEqual([]);
  });

  it("rejects an owned model whose FK targets an unknown model", () => {
    setExtensionModelRegistry([
      {
        ...DOG_PRIVATE,
        fkFields: [
          { field: "xId", targetModel: "nonexistent", targetTenantField: "tenantId" },
        ],
      },
    ]);
    expect(() => buildScopedModelMetas()).toThrow(/unknown target/);
  });
});
