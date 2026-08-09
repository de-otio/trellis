# Backfill scripts

A **backfill** populates or corrects existing rows after a schema/behavior
change — e.g. filling a new nullable column from an existing one, migrating
data into a new shape, or re-deriving a value the application previously
computed incorrectly. It is distinct from a **rebuild** (see
`../rebuilds/README.md`): a rebuild recomputes a denormalized value from its
current source-of-truth rows and is meant to be run repeatedly over the
life of the feature; a backfill is a one-time (or few-time) data migration
tied to a specific change and is normally deleted once it has run
successfully everywhere it needs to.

## Rules (every backfill script must follow all of these)

1. **Script-in-repo.** The backfill is a committed TypeScript file under this
   directory, not a one-off shell snippet run by hand against prod. It is
   reviewed like any other code change.
2. **Idempotent.** Running the script twice (or after a partial/interrupted
   run) must not double-apply the change or corrupt data. Prefer
   conditional writes (`WHERE column IS NULL`, `updateMany` with a guard
   predicate) over unconditional overwrites, and make the "already done"
   check part of the row selection, not a side-table flag.
3. **Batched (~10k rows per batch).** Never select or update the whole table
   in one query. Page through rows in batches of roughly 10,000 (tune down
   for wide rows / expensive per-row work), committing progress between
   batches so a restart resumes near where it left off rather than from
   zero.
4. **Throttled.** Sleep briefly between batches (env-configurable, sane
   default) so the backfill does not saturate the primary's connection
   pool or I/O while production traffic is being served. The throttle
   delay is runtime config (an env var with a default), never a compiled
   constant, per the threshold-secrecy rule.
5. **Resumable.** The script must be safe to stop (SIGINT/SIGTERM,
   deploy replacing the task, transient DB error) and restart from where
   it left off, driven by the same "already done" predicate as rule 2 —
   not by an external checkpoint file that can drift from the DB's real
   state.
6. **Observable.** Structured progress logs (JSON lines or clearly
   labeled text) at minimum: batch number, rows examined, rows changed,
   cumulative totals, and a final summary. A backfill that fails silently
   or logs nothing is not mergeable.
7. **Runs via the one-off task mechanism.** Backfills are invoked the same
   way the migration task is — a one-off ECS task override on the deployed
   API image (see `doc/02-technical/operations/prod-db-bootstrap-runbook.md`
   for the pattern), reading `DATABASE_URL` from the environment. They are
   never run by hand against a production connection string from a laptop.
8. **Dual-write toggle ON before backfill.** If the backfill exists because
   application code is being migrated to a new write path (e.g. a new
   column, a new table), the dual-write (writing both old and new shape)
   must already be deployed and active *before* the backfill runs. The
   backfill only catches up historical rows; it must never be the sole
   writer of the new shape, or newly-created rows during/after the
   backfill window would be missed.

## Template

Copy `_template.ts` to a descriptively-named file
(`YYYYMMDD-<what-it-does>.ts`) and fill in the marked sections. Do not
delete the template.

## Cleanup

Once a backfill has been confirmed complete in every environment that needs
it, it is safe to delete the script (or leave it — committed backfills are
harmless once done, since rule 2 makes re-running a no-op). Note in the PR
description which environments it was run against.
