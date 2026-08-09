-- Fixture for manually verifying apps/api/scripts/lint-migrations.sh /
-- .squawk.toml against a migration squawk should flag. NOT part of the real
-- schema history — table/column names below are invented and do not exist in
-- prisma/schema.prisma. Not applied by any test; not linted by the unit
-- suite (squawk itself is never invoked from unit tests — see
-- migration-lint-scope.test.ts for the scoping-logic tests instead).
--
-- To try it locally against a real squawk binary:
--   apps/api/scripts/lint-migrations.sh   # (lints your actual diff, not this file)
--   # or, directly:
--   .cache/squawk/squawk-darwin-arm64-v2.62.0 --config .squawk.toml \
--     apps/api/test/fixtures/bad-migration/20260101000000_bad_migration/migration.sql

-- Adding a NOT NULL column with no default takes an ACCESS EXCLUSIVE lock and
-- fails on any existing row.
ALTER TABLE "widget_gadgets" ADD COLUMN "sprocket_id" TEXT NOT NULL;

-- Dropping an index without justification (the analogous trellis-wide rule
-- lives in scripts/check-migration-sql.mjs, not squawk, but this is still a
-- destructive drop squawk should flag independently).
DROP INDEX "sprocket_registry_name_idx";

-- Non-concurrent index creation locks writes on the table for the duration
-- of the build.
CREATE INDEX "widget_gadgets_sprocket_id_idx" ON "widget_gadgets" ("sprocket_id");

-- Adding a column with a volatile/non-null default rewrites the whole table.
ALTER TABLE "sprocket_registry" ADD COLUMN "legacy_flag" BOOLEAN NOT NULL DEFAULT false;
