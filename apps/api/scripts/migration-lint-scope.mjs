#!/usr/bin/env node
// Computes the set of Prisma migration SQL files a PR actually touched, for
// the squawk migration-lint gate (migration-lint.yml / lint-migrations.sh).
//
// WHY THIS EXISTS
// ---------------
// squawk should only lint migrations a change *adds or edits* — never the
// pre-existing migration history (relinting old, already-applied SQL against
// a newer rule set would fail the build for code nobody touched). Scoping is
// done here, in Node, rather than via a shell one-liner over `git diff`,
// because:
//   - filenames must never be re-interpolated through `sh -c` (a filename
//     with a space, or worse, shell metacharacters, must not be able to
//     split into extra argv words or break out of a quoted string);
//   - `git diff -z --name-only` is null-delimited specifically so this
//     script can split on NUL rather than newline/whitespace, which is the
//     only splitting rule that survives a space in a path.
//
// Output: NUL-delimited list of in-scope migration `.sql` paths (relative to
// the repo root) written to stdout. Empty output (zero bytes) is a valid,
// non-error result — "no in-scope migration SQL for this diff".
//
// Usage: node apps/api/scripts/migration-lint-scope.mjs [baseRef]
//   baseRef defaults to trying origin/main, then main, then HEAD~1, then
//   "no base" (empty scope) — see resolveMergeBase().

import { execFileSync } from "node:child_process";

export const MIGRATIONS_DIR_PREFIX = "prisma/migrations/";
export const MIGRATION_LOCK_FILE = "migration_lock.toml";

// The migrations that predate this gate. Never re-linted, even if a future
// change happens to touch their directory (e.g. a rename).  Keep in sync with
// `prisma/migrations/` at the time this gate was introduced (2026-08).
export const EXEMPT_MIGRATIONS = new Set([
  "20260705050826_init",
  "20260705051500_seed_role_metadata",
  "20260705083217_t14_presigned_upload_lifecycle_consolidation",
  "20260705120000_t16_tenant_storage_quota",
  "20260705171948_t8_push_devices",
  "20260708065241_open_social_web",
  "20260710000000_events_primitive",
  "20260718000000_ws1_kv_entries",
  "20260718010000_ws1_rate_limit_buckets",
  "20260803153411_add_synthetic_provenance",
  "20260803175955_add_comment_text_provenance_and_tenant_posture",
]);

/**
 * Is this repo-relative path an in-scope migration SQL file the lint gate
 * should check? Pure function — no I/O — so it is unit-testable directly.
 *
 * @param {string} path repo-relative path, forward-slash separated
 * @returns {boolean}
 */
export function isLintableMigrationPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith(MIGRATIONS_DIR_PREFIX)) return false;
  if (!path.endsWith(".sql")) return false; // excludes migration_lock.toml and any non-SQL file
  if (path.endsWith(`/${MIGRATION_LOCK_FILE}`) || path === MIGRATION_LOCK_FILE) return false;

  const rest = path.slice(MIGRATIONS_DIR_PREFIX.length);
  const migrationDir = rest.split("/")[0];
  if (!migrationDir || EXEMPT_MIGRATIONS.has(migrationDir)) return false;

  return true;
}

/**
 * Filters a list of repo-relative paths down to in-scope migration SQL.
 * Pure function — no I/O.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function filterLintablePaths(paths) {
  return paths.filter(isLintableMigrationPath);
}

/**
 * Splits NUL-delimited `git diff -z` output into an array of paths, dropping
 * the trailing empty element `-z` output always ends with. Pure function.
 *
 * @param {string} nulDelimited
 * @returns {string[]}
 */
export function splitNulDelimited(nulDelimited) {
  if (!nulDelimited) return [];
  return nulDelimited.split("\0").filter((entry) => entry.length > 0);
}

function tryRevParse(ref, cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolves a base commit to diff against, trying each candidate ref in turn,
 * falling back gracefully (never throwing) when a ref — most commonly
 * `origin/main` in a shallow or fork checkout — is unavailable.
 *
 * @param {{ cwd?: string, candidates?: string[] }} [options]
 * @returns {string | null} a commit SHA, or null if nothing usable was found
 */
export function resolveMergeBase(options = {}) {
  const cwd = options.cwd;
  const candidates = options.candidates ?? ["origin/main", "main", "HEAD~1"];

  const head = tryRevParse("HEAD", cwd);
  if (!head) return null;

  for (const ref of candidates) {
    const sha = tryRevParse(ref, cwd);
    if (!sha) continue;
    try {
      const base = execFileSync("git", ["merge-base", "HEAD", sha], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (base) return base;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function computeScope(cwd) {
  const base = resolveMergeBase({ cwd });
  if (!base) {
    process.stderr.write(
      "migration-lint-scope: no usable base ref (origin/main, main, HEAD~1) found; " +
        "treating this as an empty diff (no migrations in scope).\n",
    );
    return [];
  }

  let diffOutput;
  try {
    diffOutput = execFileSync(
      "git",
      ["diff", "-z", "--name-only", "--diff-filter=ACMR", base, "HEAD", "--", MIGRATIONS_DIR_PREFIX],
      { cwd, encoding: "utf8" },
    );
  } catch (error) {
    process.stderr.write(`migration-lint-scope: git diff failed: ${error.message}\n`);
    return [];
  }

  return filterLintablePaths(splitNulDelimited(diffOutput));
}

function main() {
  const baseOverrideArg = process.argv[2];
  const cwd = process.cwd();

  let scope;
  if (baseOverrideArg) {
    // Explicit base ref override (used by lint-migrations.sh / manual runs).
    let diffOutput;
    try {
      diffOutput = execFileSync(
        "git",
        ["diff", "-z", "--name-only", "--diff-filter=ACMR", baseOverrideArg, "HEAD", "--", MIGRATIONS_DIR_PREFIX],
        { cwd, encoding: "utf8" },
      );
    } catch (error) {
      process.stderr.write(`migration-lint-scope: git diff against "${baseOverrideArg}" failed: ${error.message}\n`);
      process.exitCode = 0; // graceful: empty scope, never a hard failure from this script
      return;
    }
    scope = filterLintablePaths(splitNulDelimited(diffOutput));
  } else {
    scope = computeScope(cwd);
  }

  process.stdout.write(scope.join("\0"));
  if (scope.length > 0) process.stdout.write("\0");
}

const isDirectExecution = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectExecution) {
  main();
}
