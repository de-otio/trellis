---
title: Database Migrations
description: How to create, apply, and safely roll out schema migrations in Trellis.
sidebar: Migrations
order: 10
---

# Database Migrations

## Creating a migration

1. Edit `prisma/schema.prisma`
2. `npm run prisma:migrate:dev -- --name describe-your-change`
   (requires both `DATABASE_URL` and `DIRECT_DATABASE_URL` in the environment —
   `scripts/dev-setup.sh` sets these for local runs)
3. `npm run prisma:generate` to regenerate the Prisma client
4. Commit both the `prisma/migrations/` directory and `schema.prisma`

In a deployed environment, migrations are applied with
`npm run prisma:migrate:deploy` as part of the consuming application's release
process.

## `prisma migrate dev --create-only` discipline

Prefer `--create-only` when a migration needs hand-editing before it is
applied (adding `CONCURRENTLY`, a `NOT VALID` constraint, a `lock_timeout`
prologue, or a batched backfill statement — see below). Prisma's generated
SQL is a correct *starting point* for the end-state schema, not necessarily
the *safe* sequence of DDL to get there on a live database:

```bash
npx prisma migrate dev --create-only --name describe-your-change
# edit prisma/migrations/<timestamp>_describe-your-change/migration.sql by hand
npx prisma migrate dev  # applies the (now hand-edited) migration locally
```

Once a migration has been applied anywhere (including CI or another
developer's machine), Prisma has recorded its checksum in
`_prisma_migrations` — **never edit an already-applied migration file**.
If it needs a fix, write a new migration.

## Safe vs. unsafe Postgres DDL

Not every schema change is safe to run against a live database without
locking out reads/writes or causing a slow, blocking rewrite. This table
follows the operational guidance in Braintree's
["Safe Operations For High Volume PostgreSQL"](https://braintreepayments.github.io/pgrst/2018/11/13/safe-operations-for-high-volume-postgresql.html),
[`strong_migrations`](https://github.com/ankane/strong_migrations), and
[`squawk`](https://squawkhq.com/) (the linter wired into CI — see
[`migration-lint.yml`](../../.github/workflows/migration-lint.yml)).

| Change | Safe? | Notes |
|---|---|---|
| `ADD COLUMN` with no default, nullable | Safe | Metadata-only in PG11+. |
| `ADD COLUMN ... DEFAULT <volatile-or-non-null>` | **Unsafe** | Any default forces a full-table rewrite unless the default is a constant the planner can inline (PG11+ optimizes simple constant defaults; a function call, `now()`, or a non-null default on a large table still risks a rewrite — verify the plan on a production-sized copy before trusting the "safe" case). |
| `SET NOT NULL` directly | **Unsafe** | Takes `ACCESS EXCLUSIVE` and scans the whole table to verify. |
| `SET NOT NULL` via staged constraint | Safe (staged) | Add `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` (scans without blocking writers), then `SET NOT NULL` (PG12+ skips the re-scan when a validated matching CHECK exists), then drop the now-redundant CHECK. |
| `CREATE INDEX` | **Unsafe** | Takes a table-level lock that blocks writes for the duration of the build. |
| `CREATE INDEX CONCURRENTLY` | Safe | Must run **outside** a transaction block — Prisma migrations run in one transaction by default; hand-edit to move it (see below). |
| `ALTER COLUMN ... TYPE` | **Unsafe** | Rewrites the table (with narrow exceptions, e.g. widening `varchar(n)`). Use expand-contract: add the new-typed column, dual-write, backfill, cut over, drop the old column. |
| `ADD CONSTRAINT ... UNIQUE` | **Unsafe** | Implicitly builds a blocking index. |
| Unique constraint, staged | Safe (staged) | `CREATE UNIQUE INDEX CONCURRENTLY`, then `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX <index_name>` (attaches the existing index without rebuilding or blocking). |
| `ADD CONSTRAINT ... FOREIGN KEY` / `CHECK` directly | **Unsafe** | Takes a lock for the full validation scan. |
| FK / CHECK, staged | Safe (staged) | Add `NOT VALID` (fast — no scan, still enforced for new writes), then `VALIDATE CONSTRAINT` in a follow-up statement/migration (scans without blocking concurrent writers). |
| `RENAME COLUMN` / `RENAME TABLE` | **Forbidden, bare** | A currently-deployed instance still has code compiled against the old name; a bare rename breaks it mid-deploy. Always expand-contract: add the new name, dual-write/dual-read, migrate, drop the old name in a later migration. |
| Batched backfill `UPDATE` loops | **Never in a migration transaction** | A migration's DDL transaction holds its locks for the whole transaction; a large batched `UPDATE` inside it holds those locks for as long as the backfill takes. Backfills are separate scripts run outside the migration — see [`scripts/backfills/`](../../apps/api/scripts/backfills/) and the pointer below. |
| `DROP COLUMN` / `DROP TABLE` | Safe **only** once no deployed code reads it | Fast at the DB level, but only safe after the contract phase confirms nothing running still queries it. |

## The lock-queue problem and the `lock_timeout` prologue

Even a metadata-only DDL statement (e.g. `ADD COLUMN ... NOT NULL DEFAULT
<constant>` in PG11+) must acquire an `ACCESS EXCLUSIVE` lock briefly to
update the catalog. If a long-running query or an idle-in-transaction
session already holds a conflicting lock on that table, the DDL statement
**queues behind it** — and every subsequent query against the table queues
behind the DDL statement, because Postgres grants locks roughly in request
order. The result is that one slow read can turn an instant schema change
into an outage-length queue of blocked queries.

The mitigation is to bound how long the migration will wait for its lock,
so a stuck migration fails fast and loudly instead of silently queueing
every other query behind it. Every hand-edited migration should open with:

```sql
SET lock_timeout = '5s';
```

If the migration can't acquire its lock within the timeout, the statement
errors out (`ERROR: canceling statement due to lock timeout`) and the
migration aborts — safe to retry once the blocking session has cleared,
rather than an unbounded queue building up behind it. Migrations generated
directly by `prisma migrate dev` do not include this prologue automatically;
add it by hand for any migration touching a table under live traffic
(`--create-only`, above).

## Zero-downtime: expand-contract pattern

For changes that could break a running API instance, apply migrations in stages across multiple deploys rather than in a single step:

| Step | Action | Deploy? |
|------|--------|---------|
| 1. Expand | Add new nullable column / table | Deploy |
| 2. Write dual | Code writes to old + new column (`ops_dual_write` toggle on) | Deploy |
| 3. Backfill | Script (`scripts/backfills/`) populates new column from old | Run out-of-band, batched |
| 4. Shadow-read | Code reads both, compares, logs mismatches; still serves the old column | Deploy |
| 5. Switch reads | Flip `ops_read_new` toggle; code serves the new column | Deploy (toggle flip, not a migration) |
| 6. Soak | Run on the new read path under real traffic for a full cycle before touching anything else | Observe |
| 7. Contract | Drop the old column in a new migration, after taking an RDS snapshot | Deploy |

Steps 2 and 5 are ordinary feature-toggle flips (see
[`FeatureToggleService`](../../apps/api/src/lib/feature-toggle-service.ts) if
present in your version), **not migrations** — this is what decouples "ship
the code that can read/write both shapes" from "cut traffic over," so a bad
cutover is a toggle flip back, not a rollback migration. See the Prisma team's
[Expand and Contract Pattern](https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern)
guide for the general shape of this pattern outside Trellis specifically.

Take an RDS (or equivalent managed-Postgres) snapshot immediately before the
contract migration — it is the one step in the sequence that is not
reversible by flipping a toggle.

**Never in a single migration:**
- Rename a column or table (see the DDL table above)
- Drop a column that code still reads
- Change a column from nullable to non-null without a backfill
- Run a batched backfill `UPDATE` inside the migration's own transaction

## Backfill and rebuild scripts

Batched backfills (step 3 above) and denormalized-counter rebuilds live
outside `prisma/migrations/` entirely, as standalone scripts —
[`apps/api/scripts/backfills/`](../../apps/api/scripts/backfills/) and
[`apps/api/scripts/rebuilds/`](../../apps/api/scripts/rebuilds/). See those
directories' own `README.md` for the batching, idempotency, and `--dry-run`
conventions; this guide only establishes that backfills are never DDL.

## Migration rehearsal

Before a migration with any entry in the "Unsafe" column above (or any
migration touching a large/hot table) ships, rehearse it against a
representative-sized database to measure how long it actually takes and
confirm it stays inside the deploy window. The
[`apps/api/scripts/migration-rehearsal.sh`](../../apps/api/scripts/migration-rehearsal.sh)
script automates this locally (seeds representative row counts into the
Compose Postgres, times `prisma migrate deploy`, and fails if the run exceeds
a configurable time budget); the `migration-rehearsal.yml` workflow runs the
same thing on demand (`workflow_dispatch`) in CI. Neither replaces manually
reasoning through the DDL table above — the rehearsal catches "this backfill
takes 40 minutes on 10M rows," not "this statement takes an exclusive lock."

## Pre-launch exemption

Trellis has not yet launched to production traffic, so **today** a single
squashed migration per schema change (no staged expand/contract) is
tolerated for changes that would otherwise need staging — there is no live
traffic to protect yet, and every environment is disposable. This exemption
is temporary and applies only pre-launch: **once Trellis (or the consuming
vertical application) is serving real user traffic, every migration must
follow the safe-DDL table and expand-contract sequence above — no
exceptions.** Do not treat the pre-launch shortcut as the permanent house
style; it exists solely to avoid staging changes across a database with
zero rows and zero deployed consumers.
