-- Account erasure — part 2 of 2: validate the two foreign keys part 1 swapped
-- to ON DELETE SET NULL ... NOT VALID.
--
-- VALIDATE scans the table but takes only SHARE UPDATE EXCLUSIVE, so reads and
-- writes keep flowing. Expected violations: ZERO — the old constraints
-- enforced the same reference. Validating an already-valid constraint is a
-- no-op, so this file is re-runnable as written.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

-- VALIDATE is idempotent, which is what the robust-statements rule is after.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "entity_ownerships" VALIDATE CONSTRAINT "entity_ownerships_added_by_user_id_fkey";
-- VALIDATE is idempotent, which is what the robust-statements rule is after.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "tenant_invitations" VALIDATE CONSTRAINT "tenant_invitations_invited_by_user_id_fkey";
