-- Consent: third-party sharing columns, the shape CHECK, and the active-row
-- unique key (partner-integration-readiness lane A). Follows
-- 20260904130000_consent_third_party_purpose, which is the migration that adds
-- the enum value this file spells.
--
-- NON-CONCURRENT THROUGHOUT, mirroring consent_cross_region_key in the init
-- migration: the table holds ZERO rows of this purpose by construction (no
-- authorization-server work exists, so nothing writes one), so there is nothing
-- to lock out and CONCURRENTLY buys nothing.

-- House style (M7b / plan 031 C1): timeout prologue so a lock queue fails fast
-- instead of stalling the app; robust (re-runnable) statements throughout. The
-- table is small and holds no rows of this purpose, but the ADD COLUMNs still
-- take ACCESS EXCLUSIVE on the whole table, which does hold cross-region rows.
SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- AlterTable
-- All nullable or constant-defaulted: a catalog-only change on PostgreSQL 11+,
-- no table rewrite.
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "grantee_client_id" TEXT;
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "grantee_issuer"    TEXT;
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "granted_scopes"    TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "grant_profile"     TEXT;
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "subject_entity_id" TEXT;
-- TIMESTAMP(3), not timestamptz: this is what Prisma's `DateTime` maps to and
-- what every other datetime column in this schema is. A timestamptz here would
-- be permanent schema drift for one column's sake.
-- squawk-ignore prefer-timestamp-tz
ALTER TABLE "consent" ADD COLUMN IF NOT EXISTS "expires_at"        TIMESTAMP(3);

-- The shape invariant lives where the evidence lives, not only at a Zod
-- boundary nothing calls yet: a sharing row without a verified grantee, its
-- issuer, at least one scope and an expiry is not a lawful-basis record. A NULL
-- expiry in particular is the eternal sharing grant this design rules out.
-- NOT VALID + VALIDATE keeps squawk quiet and skips an ACCESS EXCLUSIVE full
-- scan; with zero rows of this purpose the validation is instant either way.
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS; the duplicate_object
-- guard makes the file re-runnable, mirroring the CREATE TYPE guard in
-- 20260823150000.
DO $$ BEGIN
  ALTER TABLE "consent" ADD CONSTRAINT "consent_third_party_sharing_shape_check"
    CHECK (
      "purpose" <> 'THIRD_PARTY_DATA_SHARING'
      OR ("grantee_client_id" IS NOT NULL
          AND "grantee_issuer" IS NOT NULL
          AND cardinality("granted_scopes") > 0
          AND "expires_at" IS NOT NULL)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The rule below wants an explicit transaction so a part-way failure can be
-- re-run. Prisma already runs each migration file inside one; wrapping this
-- statement in a second BEGIN/COMMIT would be a nested transaction, not a
-- safer one.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "consent" VALIDATE CONSTRAINT "consent_third_party_sharing_shape_check";

-- One ACTIVE sharing decision per (user, external client, resource). Scopes are
-- a grant property, replaced wholesale on re-grant, NEVER a key part: btree
-- compares text[] element-wise, so {a} vs {a,b} and {a,b} vs {b,a} would each
-- be a separate key and two active grants for one scope could coexist.
-- NULLS NOT DISTINCT (PG15+; Postgres is 16 everywhere) so a NULL grantee or
-- subject cannot escape the key — a NULL subject means "all this user's
-- resources", the row least safe to duplicate.
-- CONCURRENTLY cannot run inside a transaction block, and Prisma wraps every
-- migration file in one — so the rule's fix is not available here. A plain
-- CREATE INDEX also matches the precedent this key sits beside
-- (`consent_cross_region_key`, init migration).
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS "consent_third_party_sharing_key"
  ON "consent" ("user_id", "grantee_client_id", "subject_entity_id") NULLS NOT DISTINCT
  WHERE "purpose" = 'THIRD_PARTY_DATA_SHARING' AND "active";
