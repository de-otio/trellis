#!/usr/bin/env node
// Fail the build on a `DROP INDEX` in a Prisma migration that does not carry an
// explicit justification.
//
// WHY THIS EXISTS
// ---------------
// `prisma migrate dev` cannot express GiST or `gin_trgm_ops` indexes in
// `schema.prisma`, so it reads the hand-written raw-SQL indexes from the `init`
// migration as unknown drift and proposes DROPPING THEM in every migration it
// generates. Three are affected today:
//
//   entity_location_location_idx            GiST  — ST_DWithin / KNN geo-proximity
//   tenant_display_name_trgm_idx            GIN   — directory similarity search
//   tenant_directory_profile_desc_trgm_idx  GIN   — directory similarity search
//
// Applying that generated SQL destroys geo-proximity and directory search. There
// is no error, no failing test, and nothing at runtime says the index is gone —
// only a query-plan regression under load. Two separate migrations have already
// hit this, which is one more than "a human will remember during diff review"
// survives.
//
// So: mechanical gate. A `DROP INDEX` is not forbidden — dropping an index is a
// legitimate thing to do — it just has to be DELIBERATE. Say so in the file:
//
//   -- ALLOW-DROP-INDEX: superseded by post_author_created_idx (AR10 prune)
//
// The marker must appear in the same migration file. That converts a silent
// default into a decision someone signed.
//
// Usage: node scripts/check-migration-sql.mjs [migrationsDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MIGRATIONS_DIR = process.argv[2] ?? "prisma/migrations";
const ALLOW_MARKER = "ALLOW-DROP-INDEX:";

/**
 * Migrations that predate this check and legitimately drop an index.
 *
 * These are exempted HERE rather than annotated in the migration file because
 * Prisma stores a checksum of `migration.sql` in `_prisma_migrations`. Editing an
 * already-applied migration — even to add a comment — makes every environment
 * that applied it fail with a checksum mismatch. So the exemption lives in the
 * checker, where changing it costs nothing.
 *
 * Do NOT add new entries here. A new migration uses the in-file marker.
 */
const LEGACY_EXEMPT = new Set([
  // Dropped `media_files_moderation_status_idx` and `media_files_upload_status_idx`
  // when the T14 presigned-upload consolidation replaced both single-column
  // indexes with the lifecycle composite. Verified deliberate, not Prisma drift.
  "20260705083217_t14_presigned_upload_lifecycle_consolidation",
]);

// Matches `DROP INDEX`, tolerating extra whitespace and the optional
// IF EXISTS / CONCURRENTLY modifiers, case-insensitively.
const DROP_INDEX = /^\s*DROP\s+INDEX\b/i;

/** Strip `--` line comments so a DROP INDEX inside a comment is not a finding. */
function isCommentLine(line) {
  return line.trimStart().startsWith("--");
}

function migrationFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`check-migration-sql: cannot read ${dir}`);
    process.exit(2);
  }
  const files = [];
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    const sql = join(path, "migration.sql");
    try {
      if (statSync(sql).isFile()) files.push(sql);
    } catch {
      // A migration directory without migration.sql is not this script's problem.
    }
  }
  return files;
}

const findings = [];
const files = migrationFiles(MIGRATIONS_DIR);

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const dir = basename(dirname(file));
  const allowed = text.includes(ALLOW_MARKER) || LEGACY_EXEMPT.has(dir);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!DROP_INDEX.test(line)) return;
    if (allowed) return;
    findings.push({ file, line: i + 1, text: line.trim() });
  });
}

if (findings.length > 0) {
  console.error(
    `\ncheck-migration-sql: ${findings.length} unjustified DROP INDEX statement(s).\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}\n    ${f.text}`);
  }
  console.error(
    `
Prisma proposes these automatically for GiST / gin_trgm_ops indexes it cannot
represent in schema.prisma. If that is what happened, DELETE the statements from
the migration — dropping them silently destroys geo-proximity and directory
search.

If the drop IS intended, record why in the migration file:

  -- ${ALLOW_MARKER} <reason>
`,
  );
  process.exit(1);
}

console.log(
  `check-migration-sql: ${files.length} migration(s) checked, no unjustified DROP INDEX.`,
);
