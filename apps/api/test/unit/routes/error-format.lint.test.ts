/**
 * Lint test: structured error format for federation surface.
 *
 * Ensures that every in-scope federation route file:
 *   1. Imports from `./errors` (structuredError or one of the pre-built factories).
 *   2. Does NOT contain any of the old unstructured `{ error: "Unauthorized" }` shapes.
 *
 * This is the canary that prevents error-format drift in future PRs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(
  import.meta.dirname,
  "../../../src/lib/routes",
);

/** In-scope federation route files. */
const IN_SCOPE_FILES = [
  "tenants.ts",
  "tenant-domains.ts",
  "tenant-idp.ts",
  "tenant-members.ts",
  "tenant-role-mappings.ts",
  "tenant-audit.ts",
  "tenant-compliance.ts",
  "auth-discover.ts",
  "oauth.ts",
  "agent-authorize.ts",
  "agent-sessions.ts",
  "setup-status.ts",
];

/**
 * Old unstructured shapes that must not appear in in-scope files.
 *
 * We check for literal string patterns that indicate hand-rolled error
 * responses were not migrated.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\{\s*error:\s*["']Unauthorized["']\s*\}/,
    description: '{ error: "Unauthorized" } — use unauthorizedError() instead',
  },
  {
    pattern: /\{\s*error:\s*["']Forbidden["']\s*\}/,
    description: '{ error: "Forbidden" } — use forbiddenError() instead',
  },
  {
    pattern: /\{\s*error:\s*["']Not found["']\s*\}/,
    description: '{ error: "Not found" } — use notFoundError() or structuredError() instead',
  },
  {
    pattern: /\{\s*error:\s*["']Not Found["']\s*\}/,
    description: '{ error: "Not Found" } — use notFoundError() or structuredError() instead',
  },
];

function readFile(filename: string): string {
  return readFileSync(join(ROUTES_DIR, filename), "utf8");
}

describe("error-format lint", () => {
  for (const filename of IN_SCOPE_FILES) {
    describe(filename, () => {
      const content = readFile(filename);

      it("imports structuredError or a pre-built error factory from ./errors", () => {
        // Must import something from "./errors" (with or without .js, since the
        // codebase is ESM and may or may not have suffixed the specifier yet).
        const importsFromErrors =
          /from\s+["']\.\/errors(?:\.js)?["']/.test(content) ||
          /require\(["']\.\/errors(?:\.js)?["']\)/.test(content);
        expect(importsFromErrors).toBe(true);
      });

      for (const { pattern, description } of FORBIDDEN_PATTERNS) {
        it(`does not contain: ${description}`, () => {
          expect(content).not.toMatch(pattern);
        });
      }
    });
  }
});
