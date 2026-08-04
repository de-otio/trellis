/**
 * Architectural boundary test: the moderation decision core is
 * dependency-free.
 *
 * The decision core — lifecycle state machine, track fan-in, promotion
 * decision, serve-gate predicate, and the provider/port interfaces — must
 * import nothing but Node built-ins and other decision-core modules. No
 * Prisma, no cloud SDKs, no env, no worker or route code. Enforcement
 * (workers, CAS promotion, quotas, serve wiring) is platform code and
 * lives outside this set; new moderation intelligence enters behind the
 * provider seams, never inline. See the "Boundary invariants" section of
 * docs/concepts/media-moderation.md.
 *
 * Adding a module to DECISION_CORE asserts it obeys the same rule.
 * Renaming a module without updating this list fails the existence check
 * (which is intentional: the docs table has gone stale on a rename before).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MEDIA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/lib/media",
);

/** Decision-core modules (basenames within src/lib/media). */
const DECISION_CORE = [
  "media-lifecycle.ts",
  "track-verdict.ts",
  "promote-decision.ts",
  "serve-gate.ts",
  "moderation-provider.ts",
  "text-moderation.ts",
  "media-ports.ts",
  "cas-keys.ts",
  "dedupe-key.ts",
  "processing-types.ts",
  "moderation-resolved-payload.ts",
] as const;

/**
 * Every import/export specifier in a source: static `import ... from "x"`,
 * side-effect `import "x"`, re-export `export ... from "x"`, and dynamic
 * `import("x")`.
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^"']*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^"']*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:");
}

/** A same-directory relative import resolved to its .ts basename. */
function relativeCoreBasename(specifier: string): string | undefined {
  const match = /^\.\/([A-Za-z0-9-]+)\.js$/.exec(specifier);
  return match ? `${match[1]}.ts` : undefined;
}

describe("moderation decision-core boundary", () => {
  it.each(DECISION_CORE)("%s exists (rename guard)", (basename) => {
    expect(existsSync(path.join(MEDIA_DIR, basename))).toBe(true);
  });

  it.each(DECISION_CORE)(
    "%s imports only Node built-ins and decision-core modules",
    async (basename) => {
      const source = await readFile(path.join(MEDIA_DIR, basename), "utf8");
      const violations = importSpecifiers(source).filter((specifier) => {
        if (isNodeBuiltin(specifier)) return false;
        const target = relativeCoreBasename(specifier);
        return !(
          target !== undefined &&
          (DECISION_CORE as readonly string[]).includes(target)
        );
      });
      expect(violations).toEqual([]);
    },
  );
});
