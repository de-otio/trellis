/**
 * Lint test: structured error format for the public route surface.
 *
 * Ensures that every route module flagged public (`publicSpec: true`, either
 * inline per-route or via the `markPublicSpec(...)` module-level wrapper in
 * `routes/index.ts`):
 *   1. Imports from `./errors` (structuredError or one of the pre-built
 *      factories) — but only when the file actually has a 4xx error path;
 *      a public GET-only discovery route with no error branch has nothing
 *      to import that for.
 *   2. Does NOT contain any of the old unstructured `{ error: "Unauthorized" }`
 *      shapes.
 *
 * Plan 034 lane C.4 widened this from a hand-maintained list of federation
 * files to a **discovered** set, computed by reading route-module source
 * text (no import, no server boot) — so a newly-added public route is
 * covered automatically, which is the point: "the lint is the reason the
 * envelope is actually uniform... as the public surface grows."
 *
 * This is the canary that prevents error-format drift in future PRs.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { structuredError } from "../../../src/lib/routes/errors.js";

const ROUTES_DIR = join(import.meta.dirname, "../../../src/lib/routes");
const INDEX_FILE = "index.ts";

/**
 * Known, pre-existing conformance gaps in files this lane does not own
 * (plan 034's file-ownership table: lane C owns `cors-handler.ts`,
 * `routes/errors.ts`, `middleware/idempotency.ts`, and this lint — not
 * individual route modules). Widening the lint's scope surfaces these; the
 * standing rule ("do not pivot on blockers... record it, do not fix it")
 * means they are excluded here with a reason and a canary test below,
 * rather than either silently dropped or fixed out-of-scope.
 */
const KNOWN_NON_CONFORMANT_PUBLIC_FILES = new Set<string>([
  // PATCH /api/user/profile is `publicSpec: true` (routes/user.ts) but its
  // 401/400 branches return `{ error: "Unauthorized" }` /
  // `{ error: "Invalid input: ..." }` directly instead of going through
  // structuredError()/unauthorizedError() — pre-existing, not introduced by
  // plan 034. Recorded 2026-09-04 for owner follow-up (blocks the plan-level
  // gate "every /api/v1 error carries request_id" once user.ts is mounted
  // under /api/v1 by lane G).
  "user.ts",
]);

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

/** Does this file contain any inline 4xx status literal at all? */
function hasErrorPaths(content: string): boolean {
  return /status\s*:\s*4\d\d/.test(content);
}

/**
 * Discover every route module flagged public, by reading source text only:
 *
 * 1. Any top-level `routes/*.ts` file with an inline `publicSpec: true`
 *    (e.g. `app-meta.ts`, `user.ts`).
 * 2. Any file whose exported route array is wrapped in `markPublicSpec(...)`
 *    inside `routes/index.ts` — resolved back to a filename via the
 *    matching `import { xRoutes } from "./file.js"` line.
 *
 * Deliberately static (no dynamic `import()`): building the real route
 * table requires `env`/DB-adjacent modules this lint has no business
 * depending on, and a text scan is exactly what the original, narrower
 * version of this lint already did.
 */
function discoverPublicRouteFiles(): string[] {
  const found = new Set<string>();

  for (const entry of readdirSync(ROUTES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name === INDEX_FILE || entry.name === "types.ts") continue;
    if (/publicSpec\s*:\s*true/.test(readFile(entry.name))) {
      found.add(entry.name);
    }
  }

  const indexContent = readFile(INDEX_FILE);
  const markedIdentifiers = new Set(
    [...indexContent.matchAll(/markPublicSpec\((\w+)\)/g)].map((m) => m[1]),
  );
  for (const identifier of markedIdentifiers) {
    const importMatch = indexContent.match(
      new RegExp(
        `import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*["']\\.\\/([^"']+)\\.js["']`,
      ),
    );
    if (importMatch) {
      found.add(`${importMatch[1]}.ts`);
    }
  }

  return [...found].sort();
}

const publicRouteFiles = discoverPublicRouteFiles().filter(
  (f) => !KNOWN_NON_CONFORMANT_PUBLIC_FILES.has(f),
);

describe("error-format lint", () => {
  it("discovers at least the previously-hardcoded federation surface", () => {
    // Sanity floor: the list this lint used to hardcode, minus the known
    // exclusion, must still be found dynamically. Guards against the
    // discovery mechanism itself silently finding nothing.
    const previouslyHardcoded = [
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
    for (const filename of previouslyHardcoded) {
      expect(publicRouteFiles, `expected to discover ${filename}`).toContain(
        filename,
      );
    }
  });

  it("also discovers public files the original hardcoded list omitted", () => {
    // agent-surface.ts (markPublicSpec-wrapped) and app-meta.ts (inline
    // publicSpec: true) were both publicSpec: true before this lane but
    // were not in the old IN_SCOPE_FILES list.
    expect(publicRouteFiles).toContain("agent-surface.ts");
    expect(publicRouteFiles).toContain("app-meta.ts");
  });

  it("excludes the known pre-existing gap with a reason, not silently", () => {
    expect(publicRouteFiles).not.toContain("user.ts");
    // Canary: if user.ts is fixed elsewhere, this starts failing — that is
    // the signal to remove it from KNOWN_NON_CONFORMANT_PUBLIC_FILES so it
    // rejoins full coverage.
    expect(readFile("user.ts")).toMatch(
      /\{\s*error:\s*["']Unauthorized["']\s*\}/,
    );
  });

  for (const filename of publicRouteFiles) {
    describe(filename, () => {
      const content = readFile(filename);

      for (const { pattern, description } of FORBIDDEN_PATTERNS) {
        it(`does not contain: ${description}`, () => {
          expect(content).not.toMatch(pattern);
        });
      }

      if (hasErrorPaths(content)) {
        it("imports structuredError or a pre-built error factory from ./errors", () => {
          // Must import something from "./errors" (with or without .js, since the
          // codebase is ESM and may or may not have suffixed the specifier yet).
          const importsFromErrors =
            /from\s+["']\.\/errors(?:\.js)?["']/.test(content) ||
            /require\(["']\.\/errors(?:\.js)?["']\)/.test(content);
          expect(importsFromErrors).toBe(true);
        });
      }
    });
  }
});

/**
 * request_id assertion (plan 034 lane C.4's second requirement). The lint
 * above is a static text scan; request_id is a property of every response
 * `structuredError()` builds at runtime, so it is asserted by actually
 * calling the function rather than grepping for it — a file can satisfy
 * every static check above and still, in principle, construct a body that
 * omits request_id if `structuredError` itself regressed. This is that
 * regression's tripwire.
 */
describe("error envelope: request_id (plan 034 lane C.4)", () => {
  it("every structuredError response carries a non-empty request_id", async () => {
    const res = structuredError(400, {
      error: "X",
      message: "m",
      remediation: "r",
    });
    const body = await res.json();
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
  });
});
