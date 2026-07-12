import { describe, expect, it } from "vitest";
import {
  EXTENSION_MODEL_REGISTRY,
  type ExtensionModelRegistryEntry,
} from "../../src/lib/extension-model-registry.js";

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
