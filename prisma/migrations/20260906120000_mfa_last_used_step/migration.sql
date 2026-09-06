-- squawk-ignore-file prefer-bigint-over-int
--
-- The one int4 column below holds an RFC 6238 time-step (unix seconds / 30).
-- Today that is ~6e7 and it reaches the int4 ceiling in the year 4000; a bigint
-- would cost every Prisma caller a BigInt round-trip for a value that can never
-- get there. Scoped to this FILE rather than added to .squawk.toml so the rule
-- keeps applying to every other migration.

-- TOTP replay guard on mfa_enrollments.
--
-- verifyTOTP accepted any code inside the ±1 step window and recorded only
-- last_used_at, so a code observed once (shoulder-surfed, relayed by a phishing
-- page) stayed valid for the full 90 seconds. The handler now persists the
-- accepted time-step here and refuses any code whose step is at or below it.
-- See apps/api/src/lib/mfa/mfa-handler.ts.
--
-- PURELY ADDITIVE and NULLABLE: one ADD COLUMN, no default, no backfill, no
-- index. Existing enrollments read as NULL (= nothing accepted yet), which is
-- the truth for them.
--
-- House style (M7b): timeout prologue so a lock queue fails fast instead of
-- stalling the app; robust (re-runnable) statement.
--
-- Do NOT let `prisma migrate dev` re-add DROP INDEX statements for the
-- hand-written PostGIS/pg_trgm indexes here — see the note in
-- 20260803153411_add_synthetic_provenance/migration.sql.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- Nullable column with no default: catalog-only change (no table rewrite).
ALTER TABLE "mfa_enrollments"
  ADD COLUMN IF NOT EXISTS "last_used_step" INTEGER;
