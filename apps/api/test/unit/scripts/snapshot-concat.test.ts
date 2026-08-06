import { describe, expect, it } from "vitest";
import {
  buildSnapshotContent,
  diffSnapshots,
  extractImportSpecifiers,
  filterDeclarationFiles,
  resolveRelPathCandidates,
  traceReachableDeclarations,
} from "../../../scripts/lib/snapshot-concat.mjs";

describe("buildSnapshotContent", () => {
  it("sorts entries by relPath regardless of input order", () => {
    const out = buildSnapshotContent([
      { relPath: "b.d.ts", content: "export type B = 1;" },
      { relPath: "a.d.ts", content: "export type A = 1;" },
    ]);
    const aIndex = out.indexOf("a.d.ts");
    const bIndex = out.indexOf("b.d.ts");
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(aIndex).toBeLessThan(bIndex);
  });

  it("is deterministic for the same input in any order", () => {
    const entries1 = [
      { relPath: "z.d.ts", content: "export type Z = 1;" },
      { relPath: "a.d.ts", content: "export type A = 1;" },
    ];
    const entries2 = [entries1[1], entries1[0]];
    expect(buildSnapshotContent(entries1)).toBe(buildSnapshotContent(entries2));
  });

  it("normalizes windows-style path separators for cross-platform determinism", () => {
    const out = buildSnapshotContent([
      { relPath: "lib\\push\\index.d.ts", content: "export type X = 1;" },
    ]);
    expect(out).toContain("lib/push/index.d.ts");
    expect(out).not.toContain("\\");
  });

  it("ends with exactly one trailing newline and no leading blank line", () => {
    const out = buildSnapshotContent([{ relPath: "a.d.ts", content: "export {};" }]);
    expect(out.startsWith("// ===== a.d.ts =====")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("returns just a trailing newline for an empty entry list", () => {
    expect(buildSnapshotContent([])).toBe("\n");
  });
});

describe("filterDeclarationFiles", () => {
  it("keeps only .d.ts files, excluding .d.ts.map and other output", () => {
    const files = [
      "index.d.ts",
      "index.d.ts.map",
      "index.js",
      "tsconfig.tsbuildinfo",
      "lib/push/index.d.ts",
    ];
    expect(filterDeclarationFiles(files)).toEqual([
      "index.d.ts",
      "lib/push/index.d.ts",
    ]);
  });
});

describe("diffSnapshots", () => {
  it("returns null for identical content", () => {
    expect(diffSnapshots("a\nb\n", "a\nb\n")).toBeNull();
  });

  it("returns a line-level diff for changed content", () => {
    const diff = diffSnapshots("a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("- b");
    expect(diff).toContain("+ B");
  });

  it("handles length differences (line added)", () => {
    const diff = diffSnapshots("a\n", "a\nb\n");
    expect(diff).toContain("+ b");
  });
});

describe("extractImportSpecifiers", () => {
  it("extracts specifiers from from-clauses", () => {
    const content = `
      export type { Foo } from "./extension";
      export * from "./route-types.js";
    `;
    expect(extractImportSpecifiers(content)).toEqual([
      "./extension",
      "./route-types.js",
    ]);
  });

  it("extracts specifiers from inline import() type expressions", () => {
    const content = `export declare function f(): import("./push/index.js").PushTransport;`;
    expect(extractImportSpecifiers(content)).toEqual(["./push/index.js"]);
  });

  it("returns an empty array when there are no imports", () => {
    expect(extractImportSpecifiers("export type X = string;")).toEqual([]);
  });
});

describe("resolveRelPathCandidates", () => {
  it("resolves a NodeNext-style .js specifier directly to .d.ts", () => {
    expect(resolveRelPathCandidates("index.d.ts", "./push/index.js")).toEqual([
      "push/index.d.ts",
    ]);
  });

  it("returns candidates (file then directory-index) for an extension-less specifier", () => {
    expect(resolveRelPathCandidates("index.d.ts", "./extension")).toEqual([
      "extension.d.ts",
      "extension/index.d.ts",
    ]);
  });

  it("resolves relative to the current file's own directory, not the root", () => {
    expect(
      resolveRelPathCandidates("lib/push/index.d.ts", "./types.js"),
    ).toEqual(["lib/push/types.d.ts"]);
  });

  it("returns an empty array for bare/package specifiers", () => {
    expect(
      resolveRelPathCandidates("index.d.ts", "@de-otio/trellis-extension-api"),
    ).toEqual([]);
  });
});

describe("traceReachableDeclarations", () => {
  it("follows a chain of relative imports and stops at bare specifiers", () => {
    const files = {
      "index.d.ts": `export * from "./extension";\nexport * from "./route-types.js";`,
      "extension.d.ts": `export type Foo = import("./dto.js").Bar;`,
      "route-types.d.ts": `export type Baz = string;`,
      "dto.d.ts": `import type { X } from "some-package";\nexport type Bar = X;`,
    };
    const reachable = traceReachableDeclarations("index.d.ts", files).sort();
    expect(reachable).toEqual(
      ["dto.d.ts", "extension.d.ts", "index.d.ts", "route-types.d.ts"].sort(),
    );
  });

  it("does not include files unreachable from the entry", () => {
    const files = {
      "index.d.ts": `export * from "./extension";`,
      "extension.d.ts": `export type Foo = string;`,
      "internal-only.d.ts": `export type Unused = number;`,
    };
    const reachable = traceReachableDeclarations("index.d.ts", files);
    expect(reachable).not.toContain("internal-only.d.ts");
  });

  it("throws when the entry itself is missing", () => {
    expect(() => traceReachableDeclarations("missing.d.ts", {})).toThrow(
      /not found/,
    );
  });

  it("handles a cycle without infinite looping", () => {
    const files = {
      "index.d.ts": `export * from "./a.js";`,
      "a.d.ts": `export * from "./b.js";`,
      "b.d.ts": `export * from "./a.js";`,
    };
    const reachable = traceReachableDeclarations("index.d.ts", files).sort();
    expect(reachable).toEqual(["a.d.ts", "b.d.ts", "index.d.ts"].sort());
  });
});
