/**
 * Append-only InteractionEvent dual-write + retention pruning
 * (Surveillance-hardening Phase 0, P2 / E1).
 *
 * Why this table exists: `Relationship.signals` keeps only AGGREGATE per-type
 * counters — it destroys the temporal signal (who interacted with whom, WHEN)
 * that Phase 2 coordinated-behavior detection needs. This module preserves that
 * signal as an append-only log, bounded to a rolling retention window.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * READ-ACCESS INVARIANT (security review blocks on this):
 *   90+ days of who-interacted-with-whom-when is a behavioral fingerprint — the
 *   social graph + activity patterns a fusion platform would buy. Phase 0 ships
 *   ZERO read paths. Any future read is restricted to the Phase 2 detection path
 *   and moderator surfaces, requires MODERATOR/SUPER_ADMIN, and emits an audit
 *   event. There is NO general-purpose query helper here, by design — do not add
 *   one. (doc/02-technical/surveillance-threat-model/03-coordinated-...)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Posture:
 *   - Writes are FAIL-OPEN: a failed event insert must never fail or slow the
 *     user-facing interaction (same posture as audit logging in media-handler).
 *   - No content payload — type + references only (enforced by the P1 schema;
 *     do not smuggle content into a metadata column, there isn't one).
 *   - Pruning is BATCHED with a circuit breaker (CLAUDE.md Infinite Loop
 *     Prevention) — a single unbounded deleteMany on a mass-expiry backlog
 *     would lock the table.
 */

import type { PrismaClient } from "@prisma/client";
import { getCurrentTenantId } from "@de-otio/saas-foundation/tenant";
import type { RecordInteractionInput } from "../types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Runtime configuration. Per the threshold-secrecy invariant these are env-
 * driven with conservative defaults — never bare constants at the call site
 * (the npm tarball is public). Documented + surfaced on `Env.interactionEvents`
 * in env.ts; this parser is the single source.
 */
export interface InteractionEventConfig {
  /** Master kill-switch for the dual-write (rollback). Default on. */
  enabled: boolean;
  /** expiresAt = createdAt + retentionDays. Default 120 — Phase 2 needs a
   *  60–90-day lookback and retention must exceed the detection window with
   *  margin (events expiring the day analysis runs are silent signal loss). */
  retentionDays: number;
  /** Fraction (0..1) of high-volume low-signal `view` events to record.
   *  Default 0 — views are skipped entirely. High-signal types (react,
   *  comment, share, profile_visit, depth_mode, content_creation) are ALWAYS
   *  recorded regardless of this. */
  viewSampleRate: number;
  /** Prune page size (rows per delete batch). Default 1000. */
  pruneBatchSize: number;
  /** Circuit breaker: max prune iterations per run. Default 1000. */
  pruneMaxIterations: number;
}

export const DEFAULT_INTERACTION_EVENT_CONFIG: InteractionEventConfig = {
  enabled: true,
  retentionDays: 120,
  viewSampleRate: 0,
  pruneBatchSize: 1000,
  pruneMaxIterations: 1000,
};

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve config from a process.env-like record. The graph layer is built
 * without an `Env` handle, so both env.ts (for documentation/typing) and the
 * hourly cron (a bare Lambda) call this with `process.env`.
 */
export function resolveInteractionEventConfig(
  source: Record<string, string | undefined> = process.env,
): InteractionEventConfig {
  const rate = Number(source.INTERACTION_EVENT_VIEW_SAMPLE_RATE);
  return {
    // default ON; only the literal "false" disables it
    enabled: source.INTERACTION_EVENTS_ENABLED !== "false",
    retentionDays: intFromEnv(source.INTERACTION_EVENT_RETENTION_DAYS, 120),
    viewSampleRate:
      Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
    pruneBatchSize: Math.max(
      1,
      intFromEnv(source.INTERACTION_EVENT_PRUNE_BATCH_SIZE, 1000),
    ),
    pruneMaxIterations: Math.max(
      1,
      intFromEnv(source.INTERACTION_EVENT_PRUNE_MAX_ITERATIONS, 1000),
    ),
  };
}

export interface RecordResult {
  /** A row was inserted. */
  written: boolean;
  /** The volume guard intentionally skipped this event (e.g. unsampled view). */
  skipped: boolean;
}

export interface PruneResult {
  deleted: number;
  iterations: number;
  /** Hit pruneMaxIterations with rows still expiring — a backlog the next run
   *  must drain. The caller alarms on this (silent retention failure turns the
   *  table into the unbounded log the design forbids). */
  circuitBreakerTripped: boolean;
}

/**
 * Generic batched prune of expired rows with a circuit breaker. Shared by
 * InteractionEvent (expires_at) and — retrofitted — SecurityEvent
 * (retention_until). Select-then-delete-by-id because Prisma `deleteMany` has
 * no LIMIT; the bounded shape mirrors the cron's media cleanup (`take`).
 */
export async function batchedPruneExpired(args: {
  findExpiredIds: (take: number) => Promise<string[]>;
  deleteByIds: (ids: string[]) => Promise<number>;
  batchSize: number;
  maxIterations: number;
}): Promise<PruneResult> {
  const { findExpiredIds, deleteByIds, batchSize, maxIterations } = args;
  let deleted = 0;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const ids = await findExpiredIds(batchSize);
    if (ids.length === 0) {
      return { deleted, iterations: iterations - 1, circuitBreakerTripped: false };
    }
    deleted += await deleteByIds(ids);
    if (ids.length < batchSize) {
      return { deleted, iterations, circuitBreakerTripped: false };
    }
  }
  // Reached the iteration cap with a full final batch — rows likely remain.
  return { deleted, iterations, circuitBreakerTripped: true };
}

export class InteractionEventOps {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: InteractionEventConfig = DEFAULT_INTERACTION_EVENT_CONFIG,
    /** Injectable RNG for deterministic view-sampling tests. */
    private readonly rng: () => number = Math.random,
  ) {}

  /** Volume guard: high-signal types always; `view` per sample rate. */
  private shouldRecord(interactionType: string): boolean {
    if (interactionType === "view") {
      return this.config.viewSampleRate > 0 && this.rng() < this.config.viewSampleRate;
    }
    return true;
  }

  /**
   * Append one InteractionEvent for this interaction. FAIL-OPEN: never throws,
   * never blocks the caller. Returns whether a row was written / skipped so the
   * caller (or a test) can observe, but the user-facing path ignores it.
   */
  async record(input: RecordInteractionInput): Promise<RecordResult> {
    if (!this.config.enabled) return { written: false, skipped: false };
    if (!this.shouldRecord(input.interactionType)) {
      return { written: false, skipped: true };
    }
    try {
      const tenantId = getCurrentTenantId() ?? null;
      await this.prisma.interactionEvent.create({
        data: {
          actorUserId: input.userId,
          targetType: input.targetType,
          targetId: input.targetId,
          interactionType: input.interactionType,
          tenantId,
          expiresAt: new Date(Date.now() + this.config.retentionDays * MS_PER_DAY),
        },
      });
      return { written: true, skipped: false };
    } catch (err) {
      // Fail-open: log for observability, swallow. A failed behavioral-event
      // write must never degrade the interaction itself.
      // eslint-disable-next-line no-console -- ops-grep fail-open line
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "InteractionEvent write failed (fail-open)",
          interactionType: input.interactionType,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { written: false, skipped: false };
    }
  }

  /** Delete rows whose expiresAt < now, in bounded batches. */
  async prune(now: Date = new Date()): Promise<PruneResult> {
    return batchedPruneExpired({
      findExpiredIds: async (take) => {
        const rows = await this.prisma.interactionEvent.findMany({
          where: { expiresAt: { lt: now } },
          select: { id: true },
          take,
        });
        return rows.map((r) => r.id);
      },
      deleteByIds: async (ids) => {
        const res = await this.prisma.interactionEvent.deleteMany({
          where: { id: { in: ids } },
        });
        return res.count;
      },
      batchSize: this.config.pruneBatchSize,
      maxIterations: this.config.pruneMaxIterations,
    });
  }
}
