-- Tenant-qualified foreign keys, part 2, step 2b: clear pointers whose target
-- no longer exists, in the tables that had no FK before step 2.
--
-- Each statement applies exactly what the new FK does when its parent is
-- deleted (CASCADE for the edge and location rows, SET NULL for the event
-- pointers), to rows whose parent was deleted before the FK existed. The
-- entity rows come from delete paths that never ran the GraphService cleanup.
--
-- ONLY rows whose target is missing in EVERY tenant. A row whose target
-- exists in another tenant is not touched: step 3's VALIDATE refuses it and
-- names the key, so it is investigated, not erased.
--
-- Idempotent: a re-run finds nothing. New orphans cannot appear after step 2,
-- whose NOT VALID keys already check new writes.

SET lock_timeout = '1s';
SET statement_timeout = '5min';

DELETE FROM "entity_relationships" AS r
 WHERE NOT EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = r."entity_id")
    OR NOT EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = r."related_entity_id");

DELETE FROM "entity_location" AS l
 WHERE NOT EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = l."entity_id");

UPDATE "events" AS ev SET "group_id" = NULL
 WHERE ev."group_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "groups" g WHERE g."id" = ev."group_id");

UPDATE "events" AS ev SET "announce_post_id" = NULL
 WHERE ev."announce_post_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "posts" p WHERE p."id" = ev."announce_post_id");
