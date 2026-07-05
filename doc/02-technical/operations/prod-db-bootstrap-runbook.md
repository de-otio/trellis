# Prod database bootstrap runbook (first deploy of a stage)

> **DRAFT — skybber-bound.** This runbook is written for the consuming
> application (skybber) and belongs in
> `skybber/doc/02-technical/operations/prod-db-bootstrap-runbook.md`.
> It is drafted here (trellis) because the pre-launch schema end-state pass
> was executed in this repo; move it when a skybber-side agent picks it up.
> Trellis itself is not deployed standalone.

Bring a **brand-new stage database** (first prod deploy, or a rebuilt dev)
from empty RDS instance to serving traffic. Order matters: extension →
migrations → seeds → verification.

## Preconditions

- RDS Postgres instance up (`infra/lib/stacks/data-stack.ts`); the master
  credentials secret exists and `/skybber/{stage}/db-secret-arn` points at it.
- The stage's SSM parameters are populated — especially the
  `/skybber/{stage}/media/*` moderation params, which must exist **before**
  the first deploy (see `media-moderation-ops.md`), and the session
  secret/salt params.
- The API image for the target version is in ECR (the migration step runs as
  an ECS task override on that image, per `scripts/deploy.sh`).

## Step 0 — PostGIS extension (usually a no-op)

`CREATE EXTENSION IF NOT EXISTS postgis` is the **first statement of the
init migration**, and skybber's migration task connects with the **RDS
master user** (deploy.sh builds `DATABASE_URL` from the DB secret;
`data-stack.ts` uses `rds.Credentials.fromSecret`). The master user is a
member of `rds_superuser`, which is what PostGIS installation requires — so
under the standard deploy path there is **nothing to do here**.

Run this step manually **only if** migrations have been moved to a
least-privilege DB role (PostGIS is *not* an RDS "trusted extension", so a
plain `CREATE`-privilege role cannot install it; `pg_trgm` is trusted and
would still install fine from the migration):

```sql
-- connect as the master user (rds_superuser), database = skybber
CREATE EXTENSION IF NOT EXISTS postgis;
```

AWS references:
- Trusted-extension list (pg_trgm yes, postgis no):
  <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html>
- PostGIS setup requires rds_superuser (the master user):
  <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.PostGIS.html>

## Step 1 — Apply migrations

Standard path: `./scripts/deploy.sh <stage>` runs the migration ECS task
(`npx prisma migrate deploy`) after pushing the image. For a bootstrap
without a full deploy, run the same one-off ECS task override manually (the
exact `containerOverrides` JSON lives in `scripts/deploy.sh`).

Expected result on an empty database: **two** migrations apply —
`20260705050826_init` (full schema, incl. the graph edge tables
`relationships` / `entity_relationships`, both extensions, and the
hand-written partial-unique / GiST / GIN indexes) and
`20260705051500_seed_role_metadata` (7 `role_metadata` rows, incl.
MODERATOR).

## Step 2 — Seed minimum data

Run in this order (both idempotent upserts; both need `DATABASE_URL` — run
them the same way as the migration task, an ECS task override on the API
image, never from a laptop against prod):

1. **Feature toggles** — `npm run seed:feature-toggles`
   (`apps/api/scripts/seed-feature-toggles.ts` in trellis; reads
   `environments/{ENVIRONMENT}/config.yaml` `FEATURE_FLAGS` as source of
   truth and **overwrites** DB values; set `ENVIRONMENT=<stage>`).
   Note: text moderation is fail-closed-to-enabled — a missing toggle row
   means ON; the seed makes the state explicit.
2. **Platform categories** — `npm run seed:platform-categories`
   (org-classification/directory vocabulary; upserts by `code`).
   *Human checkpoint:* the launch category set is a product decision —
   confirm it before prod bootstrap.

`role_metadata` needs no separate seed (it ships as a migration).

## Step 3 — Verify

From the migration task (or a psql session as the master user):

```sql
-- migrations recorded
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at;
-- graph edge tables exist
\d relationships
\d entity_relationships
-- extensions present
SELECT extname FROM pg_extension WHERE extname IN ('postgis','pg_trgm');
-- hand-written objects present
SELECT indexname FROM pg_indexes WHERE indexname IN
  ('consent_cross_region_key','feature_toggles_key_global',
   'entity_location_location_idx','tenant_display_name_trgm_idx',
   'tenant_directory_profile_desc_trgm_idx','tenant_directory_profile_location_idx');
-- seeds
SELECT count(*) FROM role_metadata;      -- expect 7
SELECT count(*) FROM feature_toggles;    -- expect > 0
SELECT count(*) FROM platform_categories; -- expect > 0
```

Then the standard post-deploy checks: health endpoint smoke test,
`scripts/ops/status.sh`, `scripts/ops/errors.sh 1`.

## Notes

- **Never** run `prisma migrate dev` or `prisma db push` against prod — only
  `migrate deploy`. The CI `schema-drift` job guarantees `schema.prisma` and
  `prisma/migrations/` move in lockstep, so `migrate deploy` is always
  sufficient.
- The dev API scales to zero nightly; a dev bootstrap may additionally need
  `./scripts/ops/wake.sh` before smoke tests.
