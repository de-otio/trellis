-- S-CP2: make `handle` the canonical, non-null, globally-unique identifier.
-- Backfill NULL handles and de-duplicate any pre-existing collisions BEFORE
-- adding the constraints, so the migration is safe against existing data
-- (handle previously had no DB-level uniqueness; app-layer checks could race).

-- 1. Backfill NULL handles deterministically from the row id (cuid; unique).
UPDATE "users" SET "handle" = 'user_' || "id" WHERE "handle" IS NULL;

-- 2. De-duplicate: any handle shared by >1 row gets suffixed with the row id
--    (id is the PK, so the result is guaranteed unique). Non-colliding handles
--    are left untouched.
UPDATE "users" u
SET "handle" = u."handle" || '_' || u."id"
WHERE (SELECT count(*) FROM "users" u2 WHERE u2."handle" = u."handle") > 1;

-- 3. Enforce the invariants: non-null + globally unique.
ALTER TABLE "users" ALTER COLUMN "handle" SET NOT NULL;
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");
