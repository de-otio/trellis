// Pure logic for T4's public-type snapshots (plan §2.3 / §4-T4).
//
// A "public API snapshot" here is a single deterministic text file built by
// concatenating the subset of a package's emitted `.d.ts` files (from `tsc
// --emitDeclarationOnly`) that are TRANSITIVELY REACHABLE from the package's
// public entry point (`index.d.ts`), each preceded by a stable header naming
// its declarations-root-relative path. Tracing the reachable graph (rather
// than either (a) concatenating just the entry file, which would miss types
// that flow through re-exported signatures but aren't inlined by tsc, or (b)
// concatenating the WHOLE emitted output, which would pull in unrelated
// internal modules never reached from the public surface) is what makes this
// snapshot track the actual public API — matching apps/api's "7-export
// public entry" (plan §2.3) and extension-api's `index.ts` re-export surface.
//
// Determinism matters because this is diffed byte-for-byte in CI (finding
// fea-2 / §2.3 race rule): the concatenation order and header format must
// never depend on filesystem iteration order or platform-specific path
// separators.

import posixPath from "node:path/posix";

/**
 * Extract relative-module import specifiers referenced by a `.d.ts` file's
 * text: both `import ... from "./x.js"` / `export * from "./x.js"` style
 * statements and inline `import("./x.js").Foo` type-only import expressions.
 * Bare/package specifiers (no leading `.`) are left in the returned list;
 * callers filter those out when resolving (they point outside this
 * package's own declaration tree).
 *
 * @param {string} content
 * @returns {string[]}
 */
export function extractImportSpecifiers(content) {
  const specifiers = [];
  const fromPattern = /(?:from|require\()\s*["']([^"']+)["']/g;
  const importCallPattern = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of content.matchAll(fromPattern)) specifiers.push(m[1]);
  for (const m of content.matchAll(importCallPattern)) specifiers.push(m[1]);
  return specifiers;
}

/**
 * Compute the candidate declarations-root-relative `.d.ts` path(s) a module
 * specifier found in `currentRelPath`'s content might resolve to. Returns an
 * empty array for bare/package specifiers (not part of this package's own
 * declaration tree) — those are intentionally excluded from the snapshot's
 * reachable set.
 *
 * Two resolution styles both occur in this repo's own packages: NodeNext
 * (`apps/api`) requires an explicit `.js` extension on relative specifiers
 * (`./push/index.js` -> `push/index.d.ts`); classic Node resolution
 * (`packages/extension-api`) allows an extension-less specifier
 * (`./extension` -> `extension.d.ts`, or `./push` -> `push/index.d.ts` for a
 * directory import). Callers try candidates in order and keep the first that
 * exists in the actual file set.
 *
 * @param {string} currentRelPath
 * @param {string} specifier
 * @returns {string[]}
 */
export function resolveRelPathCandidates(currentRelPath, specifier) {
  if (!specifier.startsWith(".")) return [];
  const dir = posixPath.dirname(currentRelPath);
  const joined = posixPath.normalize(posixPath.join(dir, specifier));
  if (joined.endsWith(".js")) {
    return [joined.replace(/\.js$/, ".d.ts")];
  }
  if (joined.endsWith(".d.ts")) {
    return [joined];
  }
  return [`${joined}.d.ts`, `${joined}/index.d.ts`];
}

/**
 * Breadth-first trace of every `.d.ts` file reachable from `entryRelPath`
 * through relative import specifiers, restricted to files present in
 * `filesByRelPath`. Pure: takes already-read file contents, does no I/O.
 *
 * @param {string} entryRelPath
 * @param {Record<string, string>} filesByRelPath
 * @returns {string[]} reachable relPaths, including the entry, in visitation order
 */
export function traceReachableDeclarations(entryRelPath, filesByRelPath) {
  if (!(entryRelPath in filesByRelPath)) {
    throw new Error(
      `traceReachableDeclarations: entry "${entryRelPath}" not found among ${
        Object.keys(filesByRelPath).length
      } declaration files`,
    );
  }
  const visited = new Set([entryRelPath]);
  const queue = [entryRelPath];
  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.shift());
    const content = filesByRelPath[current];
    for (const specifier of extractImportSpecifiers(content)) {
      for (const candidate of resolveRelPathCandidates(current, specifier)) {
        if (candidate in filesByRelPath && !visited.has(candidate)) {
          visited.add(candidate);
          queue.push(candidate);
        }
        if (candidate in filesByRelPath) break;
      }
    }
  }
  return [...visited];
}

const HEADER_PREFIX = "// ===== ";
const HEADER_SUFFIX = " =====";

/**
 * @typedef {{ relPath: string, content: string }} DeclEntry
 */

/**
 * Build the deterministic snapshot text from a set of declaration file
 * entries. Sorted by `relPath` (ASCII order) regardless of input order, with
 * paths normalized to forward slashes so the output is identical on any OS.
 *
 * @param {DeclEntry[]} entries
 * @returns {string}
 */
export function buildSnapshotContent(entries) {
  const normalized = entries
    .map((e) => ({
      relPath: e.relPath.split("\\").join("/"),
      content: e.content,
    }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const blocks = normalized.map((e) => {
    const body = e.content.endsWith("\n") ? e.content : `${e.content}\n`;
    return `${HEADER_PREFIX}${e.relPath}${HEADER_SUFFIX}\n${body}`;
  });

  // Single trailing newline, no leading blank line, blocks separated by
  // exactly one blank line for readability in a diff.
  return blocks.join("\n").replace(/\n*$/, "\n");
}

/**
 * Filter a list of relative file paths down to `.d.ts` declaration files,
 * excluding `.d.ts.map` sourcemap siblings (which end in `.d.ts.map`, not
 * `.d.ts`, so a naive `.endsWith(".d.ts")` check on the map file itself would
 * NOT match — but tsbuildinfo and other non-declaration output must also be
 * excluded explicitly since some emit modes place stray files in the same
 * tree).
 *
 * @param {string[]} relPaths
 * @returns {string[]}
 */
export function filterDeclarationFiles(relPaths) {
  return relPaths.filter((p) => p.endsWith(".d.ts"));
}

/**
 * Compare two snapshot strings and produce a minimal unified-ish line diff
 * for a human-readable CI failure message. Returns `null` when identical.
 *
 * @param {string} expected - the committed snapshot content
 * @param {string} actual - the freshly generated snapshot content
 * @returns {string | null}
 */
export function diffSnapshots(expected, actual) {
  if (expected === actual) return null;

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const diffLines = [];

  for (let i = 0; i < max; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === a) continue;
    if (e !== undefined) diffLines.push(`- ${e}`);
    if (a !== undefined) diffLines.push(`+ ${a}`);
  }

  return diffLines.join("\n");
}
