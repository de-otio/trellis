import { beforeAll, describe, expect, it } from "vitest";
import { registerExtension, getExtension, getExtensions } from "../../src/extensions.js";

const testExtension = {
  id: "test",
  terminology: { entity: "test", entityPlural: "tests" },
  routes: [],
  metadataSchema: { safeParse: () => ({ success: true }) },
};

beforeAll(() => {
  if (!getExtension("test")) {
    registerExtension(testExtension);
  }
});

describe("extension registry", () => {
  it("has at least one extension loaded", () => {
    expect(getExtensions().length).toBeGreaterThan(0);
  });

  it("contains the test extension", () => {
    const ext = getExtensions().find((e) => e.id === "test");
    expect(ext).toBeDefined();
    expect(ext!.terminology.entity).toBe("test");
    expect(ext!.terminology.entityPlural).toBe("tests");
  });

  describe("getExtension", () => {
    it("returns the test extension for entityType 'test'", () => {
      const ext = getExtension("test");
      expect(ext).toBeDefined();
      expect(ext!.id).toBe("test");
    });

    it("returns undefined for unknown entity type", () => {
      expect(getExtension("unknown")).toBeUndefined();
      expect(getExtension("")).toBeUndefined();
      expect(getExtension("plant")).toBeUndefined();
    });
  });
});
