-- Account erasure — part 1 of 2: stop two "who did it" references from
-- blocking the erasure of the user they point at.
--
-- entity_ownerships.added_by_user_id and tenant_invitations.invited_by_user_id
-- referenced users(id) NOT NULL ... ON DELETE RESTRICT. Both rows belong to
-- someone else (another owner's ownership, the tenant's invitation), so
-- erasure must neither delete them nor be blocked by them: the reference
-- becomes NULL instead. Before this, deleteUserData's final DELETE FROM users
-- failed for any user who had ever added a co-owner or invited a member.
--
-- DROP NOT NULL is catalog-only (no rewrite, no scan). The foreign keys are
-- swapped NOT VALID so the ADD takes no validating scan under its lock; part 2
-- validates them in a separate file.
--
-- House style (M7b): timeout prologue so a lock queue fails fast.

SET lock_timeout = '1s';
SET statement_timeout = '5s';

-- Dropping NOT NULL is the point of this migration: the clients that read the
-- column are in this repo and type-check against the now-optional field. It is
-- also idempotent (DROP NOT NULL on a nullable column is a no-op), and Prisma
-- wraps this file in one transaction, so both rules are satisfied in substance.
-- squawk-ignore ban-drop-not-null, prefer-robust-stmts
ALTER TABLE "entity_ownerships" ALTER COLUMN "added_by_user_id" DROP NOT NULL;

ALTER TABLE "entity_ownerships" DROP CONSTRAINT IF EXISTS "entity_ownerships_added_by_user_id_fkey";
ALTER TABLE "entity_ownerships" ADD CONSTRAINT "entity_ownerships_added_by_user_id_fkey"
  FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- Dropping NOT NULL is the point of this migration: the clients that read the
-- column are in this repo and type-check against the now-optional field. It is
-- also idempotent (DROP NOT NULL on a nullable column is a no-op), and Prisma
-- wraps this file in one transaction, so both rules are satisfied in substance.
-- squawk-ignore ban-drop-not-null, prefer-robust-stmts
ALTER TABLE "tenant_invitations" ALTER COLUMN "invited_by_user_id" DROP NOT NULL;

ALTER TABLE "tenant_invitations" DROP CONSTRAINT IF EXISTS "tenant_invitations_invited_by_user_id_fkey";
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_user_id_fkey"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
