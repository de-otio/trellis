import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("registerExtension capability logging", () => {
  it("logs entityRelationshipTypes when non-empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerExtension({
      id: "cat",
      terminology: { entity: "cat", entityPlural: "cats" },
      routes: [],
      metadataSchema: { safeParse: () => ({ success: true }) } as any,
      entityRelationshipTypes: ["SIBLING", "PLAYMATE"],
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("entityRelationshipTypes: SIBLING, PLAYMATE"),
    );
    logSpy.mockRestore();
  });

  it("logs discoveryFacets with field and type when non-empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerExtension({
      id: "bird",
      terminology: { entity: "bird", entityPlural: "birds" },
      routes: [],
      metadataSchema: { safeParse: () => ({ success: true }) } as any,
      discoveryFacets: [
        { field: "breed", type: "exact" as const },
        { field: "age", type: "range" as const },
      ],
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("discoveryFacets: breed(exact), age(range)"),
    );
    logSpy.mockRestore();
  });

  it("does not log when entityRelationshipTypes is empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerExtension({
      id: "fish",
      terminology: { entity: "fish", entityPlural: "fish" },
      routes: [],
      metadataSchema: { safeParse: () => ({ success: true }) } as any,
      entityRelationshipTypes: [],
    });
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("entityRelationshipTypes"),
    );
    logSpy.mockRestore();
  });

  it("does not log when discoveryFacets is empty", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    registerExtension({
      id: "rabbit",
      terminology: { entity: "rabbit", entityPlural: "rabbits" },
      routes: [],
      metadataSchema: { safeParse: () => ({ success: true }) } as any,
      discoveryFacets: [],
    });
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("discoveryFacets"),
    );
    logSpy.mockRestore();
  });
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
