/**
 * stale-media-reap.ts — the SINGLE source of truth for which MediaFile rows the
 * stale-upload reapers may delete (AR4).
 *
 * Two reapers share this scope: the hourly Lambda cron
 * (`src/lambda/hourly-cron.ts`) and the scheduled job
 * (`src/lib/scheduled/media-stale-cleanup.ts`). Before AR4 each hard-deleted
 * `uploadStatus IN (PENDING, FAILED)` rows older than 1h — but async video
 * uploads are born PENDING and the pipeline advanced only
 * `contentHash`/`originalKey` (processing) and `moderationStatus` (completion),
 * never `uploadStatus`. Result: approved videos were deleted (cascading their
 * `MediaModerationJob` records, and in one reaper the S3 object) roughly an
 * hour after upload.
 *
 * The reap scope is therefore:
 *
 *   1. `uploadStatus IN (PENDING, FAILED)` — unchanged; terminal COMPLETE rows
 *      are never candidates (the consumer's persistence ports now advance
 *      `uploadStatus` to COMPLETE when processing + moderation finish).
 *   2. `createdAt` older than a reap window ≫ the moderation SLA (default
 *      24h, overridable via `MEDIA_STALE_REAP_WINDOW_MS`) — a jobless PENDING
 *      row may simply be waiting in a backlogged processing queue; only well
 *      past any plausible pipeline latency does "jobless + PENDING" mean
 *      "abandoned".
 *   3. `moderationJobs: { none: {} }` — a row the moderation pipeline has
 *      engaged with (ANY `MediaModerationJob`, open OR resolved) is never
 *      reaped. An open job means moderation is in flight; a resolved job with
 *      a still-PENDING `uploadStatus` means the completion worker has not (or
 *      failed to) finish — deleting it would destroy a possibly-approved
 *      object plus its moderation audit records. Such rows must surface as a
 *      pipeline fault, not be silently deleted. (Deliberately stricter than
 *      "no OPEN job".)
 *
 * Reapers must apply {@link staleMediaReapWhere} to BOTH the candidate
 * `findMany` AND the subsequent `deleteMany` (not `id IN (...)` alone), so a
 * row that acquires a moderation job between the two statements is re-excluded
 * atomically at delete time (the reaper cannot be raced into deleting a row
 * the pipeline just picked up).
 *
 * The window default is compiled but env-overridable (threshold-secrecy rule:
 * operational windows are runtime config with defaults). It is a cleanup
 * window, not a security threshold — the load-bearing guard is (3).
 *
 * NOTE (T14 handoff): the broader `moderationStatus`/`uploadStatus`/orphan-flag
 * consolidation into one lifecycle state machine is deliberately NOT done here
 * — it is folded into the presigned-upload rework (02 T14).
 */

/** Non-terminal upload states eligible for reaping (see module doc). */
export const REAPABLE_UPLOAD_STATUSES: readonly string[] = ["PENDING", "FAILED"];

/**
 * Default reap window: 24 hours. Must be ≫ the worst-case moderation latency
 * (minutes, plus queue retry/DLQ cycles), so that "no moderation job yet" at
 * cutoff age genuinely means the upload was abandoned, not queue-delayed.
 */
export const DEFAULT_STALE_MEDIA_REAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the reap window, honoring the `MEDIA_STALE_REAP_WINDOW_MS` override
 * (a positive integer of milliseconds). Any absent/invalid/non-positive value
 * falls back to the default — the reapers must never end up with a zero or
 * negative window.
 */
export function staleMediaReapWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MEDIA_STALE_REAP_WINDOW_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_STALE_MEDIA_REAP_WINDOW_MS;
}

/** The `createdAt` cutoff: rows younger than this are never candidates. */
export function staleMediaReapCutoff(
  now: Date = new Date(),
  windowMs: number = staleMediaReapWindowMs(),
): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * The Prisma `where` shape shared by both reapers. Structurally compatible
 * with the generated `MediaFileWhereInput` (kept hand-declared so the
 * `media-stale-cleanup` module — which binds an untyped client — and unit
 * tests share the exact same object).
 */
export interface StaleMediaReapWhere {
  uploadStatus: { in: string[] };
  createdAt: { lt: Date };
  moderationJobs: { none: Record<string, never> };
}

/**
 * Build the reap scope for a given cutoff. Apply to BOTH `findMany` and
 * `deleteMany` (see module doc — the delete must re-assert the guard).
 */
export function staleMediaReapWhere(cutoff: Date): StaleMediaReapWhere {
  return {
    uploadStatus: { in: [...REAPABLE_UPLOAD_STATUSES] },
    createdAt: { lt: cutoff },
    // Prisma relation filter: matches rows with ZERO related MediaModerationJob
    // records (an empty condition matches every job). Any engaged row is
    // off-limits (see module doc, guard 3).
    moderationJobs: { none: {} },
  };
}
