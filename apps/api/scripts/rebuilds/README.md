# Rebuild scripts

**Rule: no denormalized value ships without a runnable rebuild.** Any field
that is a cached/aggregated function of other rows (a count, a sum, a
rolling total) must have a companion script here that recomputes it from
the current source-of-truth rows. Denormalized counters drift — a missed
event, a bug in the increment/decrement call site, a manual DB fix, a
partially-applied backfill — and the rebuild is how an operator gets back
to a known-correct state without a full data restore.

A rebuild differs from a backfill (`../backfills/README.md`): a rebuild is
**re-run whenever drift is suspected**, for the life of the feature; it is
not deleted after one successful run.

## Rebuild script rules

- **Batched**, over the child rows the counter is derived from, not loaded
  entirely into memory.
- **Idempotent** — recomputing an already-correct counter is a no-op write
  (or is skipped entirely when the computed value already matches).
- **`--dry-run` by default.** The script must require an explicit
  `--apply` (or equivalent) flag to write; running it with no flags only
  reports what *would* change. This is the opposite default from backfills
  precisely because rebuild scripts are run ad hoc by whoever is
  investigating a drift report, often without having re-read the script
  first.
- **Reads `DATABASE_URL` from the environment**, same as backfills — never
  a hard-coded connection string.
- **Structured progress logs** — same shape as backfills (JSON lines: batch
  number, rows examined, rows that would change / did change, summary).

## Denormalized counters in the schema (enumerated 2026-08, `prisma/schema.prisma`)

Searched for `Int @default(0)` fields with a "denormalized" comment or an
obvious derivation from a child table. Seven found:

| # | Field | Model | Derived from | Rebuild status |
|---|---|---|---|---|
| 1 | `itemCount` | `Collection` | `count(CollectionItem where collectionId = X)` | **`rebuild-collection-item-count.ts`** — worked example in this directory |
| 2 | `useCount` | `ConnectionCode` | `count(ConnectionCodeRedemption where connectionCodeId = X)` | Not yet implemented — follow the worked example's shape (swap model/relation names) |
| 3 | `rsvpCount` | `Event` | `count(Rsvp where eventId = X and status in (GOING, MAYBE))` | Not yet implemented — note the status filter (`WAITLISTED` rows count toward `waitlistCount`, not this field) before writing it |
| 4 | `waitlistCount` | `Event` | `count(Rsvp where eventId = X and status = WAITLISTED)` | Not yet implemented |
| 5 | `filledCount` | `EventShift` | `count(ShiftSignup where shiftId = X)` | Not yet implemented |
| 6 | `interactionCount` | `Relationship` | `count(InteractionEvent where actorUserId = X and targetId/targetType match)` | **Known limitation: not exactly rebuildable.** `InteractionEvent` rows are retention-bound and pruned (`expiresAt`, hourly cron) — a rebuild from current rows would *undercount* relationships whose interactions have aged out and does not reproduce the scoring engine's decay function (`graph/postgres/scoring.ts`). Do not write a rebuild script that silently overwrites this field from a partial event window; if this ever needs correcting, it needs a design decision (accept the undercount explicitly, or reconstruct from an archival copy of expired events), not a mechanical rebuild. Recorded here, not implemented. |
| 7 | `bounceCount` | `EmailSubscription` | Incremented directly by the bounce-webhook handler; there is no child table recording individual bounce events | **Not rebuildable from stored rows** — no source-of-truth table exists to recompute from (the email provider's own delivery log is the only such source, and it is external to this database). If this field drifts, correcting it requires reconciling against the provider's bounce log out of band; it is out of scope for a `rebuilds/` script. Recorded here, not implemented. |

Only #1 has a worked-example script in this initial pass (T6 of the
evolvability plan); #2–#5 follow the same shape (count child rows grouped
by parent id, batch over parents, compare-and-write) and are natural
follow-up work. #6 and #7 are **not** mechanical rebuild candidates — see
their notes above — and should not be "completed" by writing a script that
recomputes from an incomplete source; that would produce a confidently
wrong number, which is worse than the drift it was meant to fix.

## Worked example: `rebuild-collection-item-count.ts`

Recomputes `Collection.itemCount` from `count(CollectionItem)` grouped by
`collectionId`, batched over collections, `--dry-run` by default. See the
file for the runnable script and `../../test/unit/rebuild-collection-item-count.test.ts`
for unit tests of the pure computation/batching logic (repo `vi.hoisted`
mock-Prisma pattern).

Run with:

```bash
# Report what would change, writes nothing (default):
npx tsx apps/api/scripts/rebuilds/rebuild-collection-item-count.ts

# Apply the corrections:
npx tsx apps/api/scripts/rebuilds/rebuild-collection-item-count.ts --apply
```
