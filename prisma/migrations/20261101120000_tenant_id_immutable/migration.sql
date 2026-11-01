-- tenant_id is immutable: a BEFORE UPDATE OF tenant_id trigger on every table
-- that has the column refuses any change to it.
--
-- The tenant-qualified FKs (20261101090100 onward) pin a child to its
-- parent's tenant, and ON UPDATE NO ACTION stops a parent's tenant_id changing
-- while it has children. That leaves a row with no children, or any table
-- outside an FK pair, free to move between tenants. Nothing in the
-- application ever changes a tenant_id, and RLS WITH CHECK only covers the
-- armed, non-system path. This closes it for every client.
--
-- The function reads no other table, so RLS state is irrelevant to it. The
-- trigger fires only when tenant_id is in the UPDATE's SET list, and raises
-- only when the value actually changes (IS DISTINCT FROM, so NULL -> value on
-- the nullable audit tables counts as a change). An upsert that writes back
-- the same tenant_id (entity-geo-repository.ts) passes.
--
-- Consequence: tenants.id can no longer change once a row references it.
-- The ON UPDATE CASCADE from tenants would rewrite the children's tenant_id,
-- and this trigger refuses that. Tenant ids are never changed.
--
-- New tables: add the trigger in the migration that creates the column.
-- tenant-id-immutable.integration.test.ts fails for any tenant_id table
-- without it.
--
-- Prisma does not model triggers, so `prisma migrate diff` is unaffected.

SET lock_timeout = '1s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION trellis_tenant_id_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
    -- Default SQLSTATE P0001, not an integrity class: Prisma reports any
    -- class-23 code it does not recognise as a foreign-key violation and
    -- drops this message.
    RAISE EXCEPTION 'tenant_id of a row in % cannot change', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE TRIGGER (PG 14+) keeps this re-runnable without a DROP.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER "tenant_id_immutable_bu" '
      'BEFORE UPDATE OF "tenant_id" ON %I '
      'FOR EACH ROW EXECUTE FUNCTION trellis_tenant_id_immutable()',
      t
    );
  END LOOP;
END
$$;
