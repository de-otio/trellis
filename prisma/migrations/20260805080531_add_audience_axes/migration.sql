-- Audience model, step M1 of 4: ADDITIVE ONLY.
--
-- Adds the three audience axes alongside `radius`, which is deliberately
-- RETAINED. The read paths flip from `radius` to `audience_class` in one merge
-- rather than lane by lane: during any window where some endpoints believe one
-- column and some the other, a caller can enumerate endpoints and take the
-- UNION of both policies. `radius` is dropped in a separate destructive
-- migration (M4) once every read path is adopted and green.
--
-- Sequence, and why it is this order:
--   1. add the columns, scopes NULLABLE so a non-empty table accepts them
--   2. create the derivation function
--   3. backfill scopes from radius, and the class from the scopes
--   4. only then SET NOT NULL — a nullable window that no reader observes,
--      because nothing reads these columns until M3
--   5. install the trigger that keeps the class honest from here on
--
-- Hand-authored rather than left as generated. `prisma migrate dev` emitted
-- DROP INDEX for three hand-written indexes it does not model
-- (entity_location_location_idx, tenant_display_name_trgm_idx,
-- tenant_directory_profile_desc_trgm_idx — GiST/pg_trgm, which Prisma cannot
-- express). Those DROPs are removed here: they would silently destroy the
-- geo-proximity and trigram-search indexes, and scripts/check-migration-sql.mjs
-- exists to catch exactly this.

-- CreateEnum
CREATE TYPE "AudienceClass" AS ENUM ('SELF', 'CONNECTIONS', 'PUBLIC');

-- CreateEnum
CREATE TYPE "Discoverability" AS ENUM ('UNLISTED', 'CONNECTIONS_FEED', 'DISCOVERABLE');

-- AlterTable
-- `audience_scopes` is added NULLABLE and tightened in step 4. The other three
-- carry fail-closed defaults, so an existing row — or a future insert that
-- somehow omits them — is private, unpromoted and unfederated rather than
-- broadcast. Defaults here are a storage floor, not the authoring default: the
-- write path sets discoverability explicitly for new posts.
ALTER TABLE "posts"
  ADD COLUMN "audience_scopes"  JSONB,
  ADD COLUMN "audience_gates"   JSONB,
  ADD COLUMN "audience_class"   "AudienceClass"   NOT NULL DEFAULT 'SELF',
  ADD COLUMN "discoverability"  "Discoverability" NOT NULL DEFAULT 'UNLISTED',
  ADD COLUMN "federate"         BOOLEAN           NOT NULL DEFAULT false;

-- MEASURED, not assumed: without this default the migration is NOT additive. It
-- breaks post creation on the spot, because every writer that exists today omits
-- the column and it is NOT NULL. Verified by inserting the exact column list the
-- current write path uses: "null value in column audience_scopes violates
-- not-null constraint". The trigger below turns `[]` into a real audience
-- derived from `radius`, so existing writers stay correct and unchanged.
ALTER TABLE "posts" ALTER COLUMN "audience_scopes" SET DEFAULT '[]'::jsonb;

-- The single derivation of the coarse class from the scope set.
--
-- Scopes are OR'd, so the WIDEST component wins. Anything unrecognised — an
-- empty array, a scope kind this build does not know, a malformed blob — falls
-- through to SELF: the class is a read-path filter, so an unknown audience must
-- narrow to nobody-but-the-author rather than widen.
--
-- `@>` containment matches an element with extra keys, so a scope that later
-- carries a parameter (a list id) still matches its kind.
--
-- IMMUTABLE because it is a pure function of its argument, which lets it be
-- used in expressions and, if ever needed, an index.
CREATE OR REPLACE FUNCTION trellis_audience_class("scopes" JSONB)
RETURNS "AudienceClass"
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN "scopes" @> '[{"k":"PUBLIC"}]'::jsonb      THEN 'PUBLIC'::"AudienceClass"
    WHEN "scopes" @> '[{"k":"CONNECTIONS"}]'::jsonb THEN 'CONNECTIONS'::"AudienceClass"
    ELSE 'SELF'::"AudienceClass"
  END
$$;

-- Backfill from `radius`.
--
-- LOUD maps to CONNECTIONS, NOT to PUBLIC. This is the one mapping worth
-- arguing about: ActivityPub addressing treated LOUD as fully public (via a
-- fail-open default branch), while no local read path has ever admitted a LOUD
-- post to anyone but its author. Those two readings disagree, so the migration
-- takes the narrower one — a backfill that widens historical content is a
-- disclosure that no later fix can recall, whereas one that narrows is a
-- product complaint someone can report.
UPDATE "posts"
SET "audience_scopes" = CASE "radius"
      WHEN 'WHISPER' THEN '[{"k":"SELF"}]'::jsonb
      WHEN 'NORMAL'  THEN '[{"k":"CONNECTIONS"}]'::jsonb
      WHEN 'LOUD'    THEN '[{"k":"CONNECTIONS"}]'::jsonb
      WHEN 'SHOUT'   THEN '[{"k":"PUBLIC"}]'::jsonb
      ELSE '[{"k":"SELF"}]'::jsonb
    END
WHERE "audience_scopes" IS NULL;

-- Derive the class from what was just written, rather than mapping it from
-- `radius` a second time. Two independent mappings would be two things to keep
-- in agreement; deriving guarantees the invariant holds for these rows on the
-- same code path that will maintain it afterwards.
UPDATE "posts"
SET "audience_class" = trellis_audience_class("audience_scopes");

-- Now that every row has a value.
ALTER TABLE "posts" ALTER COLUMN "audience_scopes" SET NOT NULL;

-- Keep `audience_class` a faithful function of `audience_scopes`, forever.
--
-- This is a TRIGGER rather than application code because the write path cannot
-- be trusted to maintain it: DataRouter.createPost builds its payload as
-- Record<string, any> and casts it `as any`, so the compiler cannot force a
-- scope change to update the class. A stale class here is a DISCLOSURE, not a
-- slow query — the feed's index selects on it. The trigger also covers raw SQL,
-- future migrations and manual repair, none of which any TypeScript invariant
-- can reach.
--
-- It fires on UPDATE OF both columns, so hand-setting the class is not merely
-- discouraged: it is overwritten with the derived value.
-- It also fills in the scopes for a writer that did not supply them, which is
-- what keeps this migration additive (see the SET DEFAULT note above). NULL and
-- `[]` both mean "not specified": an empty scope set admits nobody, so it is
-- never an authored intent. The derivation is the same mapping as the backfill,
-- LOUD included, so a row written during the transition is indistinguishable
-- from one the backfill produced.
--
-- This NULL/`[]` branch is TRANSITIONAL. Once the write path always supplies
-- scopes, it should be deleted and the default dropped — leaving the trigger
-- with the single job of keeping the class faithful. Until then it is the only
-- thing standing between this migration and a broken create path.
CREATE OR REPLACE FUNCTION trellis_posts_set_audience_class()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only ABSENCE triggers the derivation: a NULL, or an empty array. A value
  -- that is present but malformed (an object, a bare string, an array of
  -- unrecognised members) is a BUG, not an omission, and must NOT be
  -- reinterpreted from `radius` — doing so would turn a malformed write on a
  -- SHOUT post into a genuinely public audience. Those fall through to
  -- trellis_audience_class, which fails them closed to SELF.
  IF NEW."audience_scopes" IS NULL
     OR (jsonb_typeof(NEW."audience_scopes") = 'array'
         AND jsonb_array_length(NEW."audience_scopes") = 0) THEN
    NEW."audience_scopes" := CASE NEW."radius"
      WHEN 'WHISPER' THEN '[{"k":"SELF"}]'::jsonb
      WHEN 'NORMAL'  THEN '[{"k":"CONNECTIONS"}]'::jsonb
      WHEN 'LOUD'    THEN '[{"k":"CONNECTIONS"}]'::jsonb
      WHEN 'SHOUT'   THEN '[{"k":"PUBLIC"}]'::jsonb
      ELSE '[{"k":"SELF"}]'::jsonb
    END;
  END IF;

  NEW."audience_class" := trellis_audience_class(NEW."audience_scopes");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "posts_audience_class_biu"
BEFORE INSERT OR UPDATE OF "audience_scopes", "audience_class" ON "posts"
FOR EACH ROW
EXECUTE FUNCTION trellis_posts_set_audience_class();

-- CreateIndex
-- Selectivity order: tenant equality first (most selective, and a hard AND on
-- every post read), then the coarse audience class, then residency, then the
-- keyset scan. Leading with audience_class would lose to the existing
-- [tenant_id, created_at] index and the cached column would earn nothing.
CREATE INDEX "posts_tenant_id_audience_class_data_region_created_at_idx"
  ON "posts"("tenant_id", "audience_class", "data_region", "created_at" DESC);
