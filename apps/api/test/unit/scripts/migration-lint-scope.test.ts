import { describe, expect, it } from "vitest";
import {
  EXEMPT_MIGRATIONS,
  filterLintablePaths,
  isLintableMigrationPath,
  resolveMergeBase,
  splitNulDelimited,
} from "../../../scripts/migration-lint-scope.mjs";

describe("isLintableMigrationPath", () => {
  it("accepts a .sql file inside a new (non-exempt) migration directory", () => {
    expect(isLintableMigrationPath("prisma/migrations/20260901000000_add_widget/migration.sql")).toBe(true);
  });

  it("accepts a path containing a space", () => {
    expect(
      isLintableMigrationPath("prisma/migrations/20260901000000_add widget table/migration.sql"),
    ).toBe(true);
  });

  it("rejects migration_lock.toml even inside prisma/migrations/", () => {
    expect(isLintableMigrationPath("prisma/migrations/migration_lock.toml")).toBe(false);
  });

  it("rejects a non-.sql file inside a migration directory", () => {
    expect(isLintableMigrationPath("prisma/migrations/20260901000000_add_widget/README.md")).toBe(false);
  });

  it("rejects files outside prisma/migrations/", () => {
    expect(isLintableMigrationPath("apps/api/src/lib/routes/index.ts")).toBe(false);
    expect(isLintableMigrationPath("prisma/schema.prisma")).toBe(false);
  });

  it("rejects every one of the pre-existing (exempt) migrations", () => {
    for (const dir of EXEMPT_MIGRATIONS) {
      expect(isLintableMigrationPath(`prisma/migrations/${dir}/migration.sql`)).toBe(false);
    }
  });

  it("rejects empty and non-string input without throwing", () => {
    expect(isLintableMigrationPath("")).toBe(false);
    // @ts-expect-error deliberate non-string input for the boundary check
    expect(isLintableMigrationPath(undefined)).toBe(false);
  });

  it("rejects a bare 'prisma/migrations/' with nothing after it", () => {
    expect(isLintableMigrationPath("prisma/migrations/")).toBe(false);
  });
});

describe("filterLintablePaths", () => {
  it("keeps only in-scope migration SQL, preserving order, dropping the rest", () => {
    const input = [
      "prisma/migrations/20260901000000_add_widget/migration.sql",
      "prisma/migrations/migration_lock.toml",
      "prisma/migrations/20260705050826_init/migration.sql", // exempt
      "apps/api/src/lib/routes/index.ts",
      "prisma/migrations/20260901000000_add_widget/README.md",
    ];

    expect(filterLintablePaths(input)).toEqual([
      "prisma/migrations/20260901000000_add_widget/migration.sql",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(filterLintablePaths([])).toEqual([]);
  });
});

describe("splitNulDelimited", () => {
  it("splits a NUL-terminated list and drops the trailing empty entry", () => {
    const input = "a/b.sql\0c d/e.sql\0";
    expect(splitNulDelimited(input)).toEqual(["a/b.sql", "c d/e.sql"]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitNulDelimited("")).toEqual([]);
  });

  it("handles a single entry without a trailing NUL", () => {
    expect(splitNulDelimited("only-one.sql")).toEqual(["only-one.sql"]);
  });

  it("preserves a filename containing a space as one entry", () => {
    expect(splitNulDelimited("prisma/migrations/2026_add widget/migration.sql\0")).toEqual([
      "prisma/migrations/2026_add widget/migration.sql",
    ]);
  });
});

describe("resolveMergeBase", () => {
  it("never throws, and returns a full commit SHA or null when nothing is usable", () => {
    // Runs against the real repo checkout (no git calls are mocked): this is
    // an integration-flavored check that the fallback chain degrades
    // gracefully rather than throwing, not a check of git plumbing itself.
    let result: string | null = null;
    expect(() => {
      result = resolveMergeBase();
    }).not.toThrow();
    if (result !== null) {
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns null when every candidate ref is bogus", () => {
    expect(resolveMergeBase({ candidates: ["definitely-not-a-real-ref-xyz"] })).toBeNull();
  });
});
