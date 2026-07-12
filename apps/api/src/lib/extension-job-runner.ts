/**
 * In-process extension job runner (O-1 design §5.2 / §12.4 item 2).
 *
 * Runs extension-declared scheduled jobs INSIDE the API container (the
 * `server.ts` process — the only process that `registerExtension`s; the worker
 * Lambdas bundle from `@de-otio/trellis/dist/lambda/*` and load zero
 * extensions). Cluster-wide single-flight (N Fargate tasks all tick) is enforced
 * by a DynamoDB conditional-put lock generalized from `lambda/hourly-cron.ts`,
 * with two fixes the hourly idiom lacks:
 *
 *   1. **TTL = timeout + margin**, not a flat hour — a minute-cadence job under
 *      an hour-TTL lock would self-block for 59 minutes after finishing.
 *   2. **`lockToken` + conditional release** — the lock item carries a
 *      `crypto.randomUUID()` token; release is a `DeleteItem` guarded by
 *      `ConditionExpression: "lockToken = :myToken"`, so a holder that overran
 *      its TTL (and whose lock was legitimately re-acquired by another task)
 *      can NEVER delete the new holder's lock (anti lock-stealing). A stale
 *      release is a silent no-op.
 *
 * The job body is wrapped in `Promise.race` against a `setTimeout(timeout)`; on
 * timeout the runner `AbortController.abort()`s (cooperative cancel for the body)
 * and then conditionally releases the lock in `finally`.
 *
 * **Functional core / imperative shell:** {@link jobLockPk},
 * {@link scheduleIntervalMs} and the context builder are pure; DynamoDB and the
 * timer are the injected edges. All nondeterminism — the clock, the uuid, the
 * DynamoDB client — is injected so tests pin it (fake timers + injected clock +
 * a mocked DynamoDB).
 */

import {
  type DeleteItemCommandOutput,
  DeleteItemCommand,
  type PutItemCommandOutput,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  CrossTenantReadDelegate,
  ExtensionJobContext,
  ExtensionJobDecl,
  ExtensionJobSchedule,
  ScopedDb,
  TenantId as ExtensionTenantId,
  TrellisExtension,
} from "@de-otio/trellis-extension-api";
import { mintTenantId, type TenantId } from "./mint-tenant-id.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Injected dependencies (the imperative-shell seams)
// ---------------------------------------------------------------------------

/**
 * The narrow DynamoDB surface the lock needs. The real `DynamoDBClient`
 * satisfies it structurally; tests provide a fake honoring the two
 * ConditionExpressions the runner uses.
 */
export interface JobLockDynamo {
  send(command: PutItemCommand): Promise<PutItemCommandOutput>;
  send(command: DeleteItemCommand): Promise<DeleteItemCommandOutput>;
}

/**
 * Everything the runner needs, all injected so nothing is wall-clock or
 * ambient. `scopedDbFactory` is optional: O-1 v1 ships zero jobs, so
 * `ctx.tenant(...)` is never invoked in production yet — the L1 scoped-DB
 * factory is wired into it at Phase-2 integration. Tests inject a stub to
 * exercise the `tenant()` path.
 */
export interface JobRunnerDeps {
  /** DynamoDB client for the single-flight lock. */
  readonly dynamo: JobLockDynamo;
  /** The KV/lock table name (same table `hourly-cron` uses). */
  readonly tableName: string;
  /** Injected clock — MILLISECONDS since epoch (e.g. `Date.now`). */
  readonly now: () => number;
  /** Injected uuid — the lock token generator (e.g. `crypto.randomUUID`). */
  readonly uuid: () => string;
  /** Resolve a declared cross-tenant-read model name to its raw read delegate. */
  readonly readDelegateSource: (model: string) => CrossTenantReadDelegate | undefined;
  /** L1's tenant-scoped DB factory (Phase-2 wired). Absent ⇒ `tenant()` throws. */
  readonly scopedDbFactory?: (tid: TenantId) => ScopedDb;
  /** Deployment stage, surfaced on the job context for logging/metrics. */
  readonly stage: string;
  /** Structured logger. */
  readonly logger: Pick<Logger, "info" | "error">;
  /** Per-job body timeout in SECONDS. Drives both `Promise.race` and the TTL. */
  readonly timeoutSeconds?: number;
  /** TTL safety margin in SECONDS added on top of the timeout. */
  readonly marginSeconds?: number;
}

/** Default job body timeout (seconds) when a deps override is absent. */
export const DEFAULT_JOB_TIMEOUT_SECONDS = 300;
/** Default TTL margin (seconds) added to the timeout for the lock TTL. */
export const DEFAULT_JOB_TTL_MARGIN_SECONDS = 60;

/** Outcome of a single job tick. */
export type JobRunOutcome = "ran" | "skipped" | "failed";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown internally when a job body exceeds its timeout budget. */
export class JobTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Extension job timed out after ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Thrown when a job declares a `crossTenantRead` model that the runtime has no
 * read delegate for (typo / undeclared table). Fails LOUD at context build,
 * before the body runs — never a silent undefined delegate.
 */
export class UndeclaredJobModelError extends Error {
  constructor(public readonly model: string) {
    super(`Job declared crossTenantRead model "${model}" that is not available`);
    this.name = "UndeclaredJobModelError";
  }
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** The DynamoDB partition key for a job's lock. Pure. */
export function jobLockPk(extId: string, jobId: string): string {
  return `job:${extId}:${jobId}`;
}

/** Poll cadence in milliseconds for a schedule. Pure, exhaustive. */
export function scheduleIntervalMs(schedule: ExtensionJobSchedule): number {
  switch (schedule) {
    case "hourly":
      return 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    default: {
      // Exhaustiveness guard — a new schedule literal must be handled here.
      const never: never = schedule;
      throw new Error(`Unhandled job schedule: ${String(never)}`);
    }
  }
}

/** True iff `err` is DynamoDB's ConditionalCheckFailedException. Pure. */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Job context — built BY CONSTRUCTION (only declared models exposed)
// ---------------------------------------------------------------------------

/**
 * Internal shape: the public {@link ExtensionJobContext} plus the abort
 * `signal`. The signal is exposed so a cooperative job body can observe a
 * timeout cancel; formalizing `signal?` on the public contract is a deferred
 * additive extension-api bump (see ASSUMPTIONS).
 */
export type InternalJobContext = ExtensionJobContext & { readonly signal: AbortSignal };

/**
 * Build the restricted job context. `read` contains EXACTLY the models the job
 * declared in `crossTenantRead` — nothing else is reachable (undeclared keys
 * are absent, so `ctx.read.other` is `undefined`). `tenant()` mints the row's
 * tenant id with `"job"` provenance before handing to the scoped-DB factory, so
 * per-row work is correctly tenant-scoped and audited.
 */
/**
 * The five cross-tenant READ methods a job delegate may expose. Anything else
 * (create/update/delete/…) must be unreachable at runtime.
 */
const READ_DELEGATE_METHODS = [
  "findMany",
  "findFirst",
  "count",
  "aggregate",
  "groupBy",
] as const;

/**
 * Wrap a raw delegate so ONLY the read methods above are reachable at runtime.
 * `readDelegateSource` may return a full Prisma delegate (which also carries
 * create/update/delete/deleteMany); `CrossTenantReadDelegate` is a *type-only*
 * restriction, so without this facade a job body could call
 * `(ctx.read.model as any).deleteMany({})` — an unscoped cross-tenant write.
 * (Security review 2026-07-12, Finding 1: type-only read restriction.)
 */
function toReadOnlyDelegate(raw: CrossTenantReadDelegate): CrossTenantReadDelegate {
  const source = raw as unknown as Record<string, unknown>;
  const facade: Record<string, unknown> = Object.create(null);
  for (const method of READ_DELEGATE_METHODS) {
    const fn = source[method];
    if (typeof fn !== "function") {
      throw new TypeError(
        `[extension-job-runner] read delegate is missing method: ${method}`,
      );
    }
    facade[method] = (fn as (...args: unknown[]) => unknown).bind(raw);
  }
  return Object.freeze(facade) as unknown as CrossTenantReadDelegate;
}

export function buildJobContext(
  deps: JobRunnerDeps,
  job: ExtensionJobDecl,
  signal: AbortSignal,
): InternalJobContext {
  const read: Record<string, CrossTenantReadDelegate> = Object.create(null);
  for (const model of job.crossTenantRead) {
    const delegate = deps.readDelegateSource(model);
    if (!delegate) throw new UndeclaredJobModelError(model);
    // Runtime read-only facade — the raw delegate carries write methods the
    // read-only type hides (security review Finding 1).
    read[model] = toReadOnlyDelegate(delegate);
  }
  Object.freeze(read);

  return Object.freeze({
    read,
    tenant(tenantId: ExtensionTenantId): ScopedDb {
      // Per-row work: re-mint the raw tenant id with "job" provenance (audit
      // seam) and hand the branded value to L1's scoped factory.
      const minted = mintTenantId(tenantId, "job");
      if (!deps.scopedDbFactory) {
        throw new Error(
          "Extension job called tenant(): scoped-DB factory not wired in this runtime",
        );
      }
      return deps.scopedDbFactory(minted);
    },
    stage: deps.stage,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Imperative shell — lock acquire/release + timed run
// ---------------------------------------------------------------------------

function resolveTimeouts(deps: JobRunnerDeps): {
  timeoutSeconds: number;
  marginSeconds: number;
} {
  return {
    timeoutSeconds: deps.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS,
    marginSeconds: deps.marginSeconds ?? DEFAULT_JOB_TTL_MARGIN_SECONDS,
  };
}

/**
 * Acquire the single-flight lock via conditional PutItem.
 *
 * Returns the lock token on success, `null` if another task already holds a
 * live lock (ConditionalCheckFailed). Any other error propagates.
 */
export async function acquireJobLock(
  deps: JobRunnerDeps,
  extId: string,
  jobId: string,
): Promise<string | null> {
  const { timeoutSeconds, marginSeconds } = resolveTimeouts(deps);
  const nowSec = Math.floor(deps.now() / 1000);
  const ttl = nowSec + timeoutSeconds + marginSeconds;
  const lockToken = deps.uuid();

  try {
    await deps.dynamo.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: marshall({
          pk: jobLockPk(extId, jobId),
          sk: "lock",
          ttl,
          lockedAt: nowSec,
          lockToken,
        }),
        // Acquire iff no lock exists OR the existing one has expired (crashed
        // holder — TTL-based recovery, matching hourly-cron's idiom).
        ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: marshall({ ":now": nowSec }),
      }),
    );
    return lockToken;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return null;
    throw err;
  }
}

/**
 * Release the lock via conditional DeleteItem — a NO-OP if a different holder
 * now owns it (our token no longer matches). Returns whether we deleted our own
 * lock. Never throws on a lost-lock race (returns `false`); other errors
 * propagate.
 */
export async function releaseJobLock(
  deps: JobRunnerDeps,
  extId: string,
  jobId: string,
  lockToken: string,
): Promise<boolean> {
  try {
    await deps.dynamo.send(
      new DeleteItemCommand({
        TableName: deps.tableName,
        Key: marshall({ pk: jobLockPk(extId, jobId), sk: "lock" }),
        ConditionExpression: "lockToken = :myToken",
        ExpressionAttributeValues: marshall({ ":myToken": lockToken }),
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
}

/**
 * Race the job body against its timeout. On timeout: abort the controller
 * (cooperative cancel) and reject with {@link JobTimeoutError}. The timer is
 * always cleared in `finally`. Uses the global `setTimeout` so vitest fake
 * timers drive it deterministically.
 */
async function raceWithTimeout(
  body: () => Promise<void>,
  timeoutMs: number,
  controller: AbortController,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([body(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a single job tick: acquire the lock (single-flight), build the restricted
 * context, race the body against its timeout, then conditionally release.
 *
 * - Lock held by another task ⇒ `"skipped"` (no body run, no release).
 * - Body throws / times out ⇒ `"failed"` (lock still released in `finally`).
 * - Body completes ⇒ `"ran"`.
 *
 * Never throws: a job's failure must not crash the API container's timer.
 */
export async function runJobOnce(
  deps: JobRunnerDeps,
  extId: string,
  job: ExtensionJobDecl,
): Promise<JobRunOutcome> {
  let lockToken: string | null;
  try {
    lockToken = await acquireJobLock(deps, extId, job.id);
  } catch (err) {
    deps.logger.error("extension job: lock acquire failed", {
      extId,
      jobId: job.id,
      error: errMessage(err),
    });
    return "skipped";
  }

  if (lockToken === null) {
    deps.logger.info("extension job: already running elsewhere, skipping", {
      extId,
      jobId: job.id,
    });
    return "skipped";
  }

  const { timeoutSeconds } = resolveTimeouts(deps);
  const controller = new AbortController();
  let outcome: JobRunOutcome;
  try {
    const ctx = buildJobContext(deps, job, controller.signal);
    await raceWithTimeout(() => job.run(ctx), timeoutSeconds * 1000, controller);
    outcome = "ran";
  } catch (err) {
    if (err instanceof JobTimeoutError) {
      deps.logger.error("extension job: timed out, aborted", {
        extId,
        jobId: job.id,
        timeoutSeconds,
      });
    } else {
      deps.logger.error("extension job: run failed", {
        extId,
        jobId: job.id,
        error: errMessage(err),
      });
    }
    outcome = "failed";
  } finally {
    try {
      await releaseJobLock(deps, extId, job.id, lockToken);
    } catch (err) {
      deps.logger.error("extension job: lock release failed", {
        extId,
        jobId: job.id,
        error: errMessage(err),
      });
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Startup registration (called from server.ts)
// ---------------------------------------------------------------------------

/** Handle to stop all registered job timers (graceful shutdown / tests). */
export interface JobRunnerHandle {
  /** Clear every interval. Idempotent. */
  stop(): void;
  /** Number of registered job timers (for wiring assertions). */
  readonly jobCount: number;
}

/**
 * Register a recurring timer per declared job across all extensions. Each tick
 * calls {@link runJobOnce}, whose DynamoDB lock enforces cluster-wide
 * single-flight. Timers are `unref`'d so they never keep the process alive.
 *
 * Returns a handle whose `stop()` clears all timers (call from server shutdown).
 * No-ops cleanly when no extension declares any job (the O-1 v1 reality).
 */
export function startExtensionJobRunners(
  deps: JobRunnerDeps,
  extensions: readonly TrellisExtension[],
): JobRunnerHandle {
  const timers: Array<ReturnType<typeof setInterval>> = [];

  for (const ext of extensions) {
    for (const job of ext.jobs ?? []) {
      const intervalMs = scheduleIntervalMs(job.schedule);
      const timer = setInterval(() => {
        // Fire-and-forget with a catch-all: a rejected tick must never bubble
        // to an unhandled rejection or stop the interval.
        void runJobOnce(deps, ext.id, job).catch((err) => {
          deps.logger.error("extension job: tick error", {
            extId: ext.id,
            jobId: job.id,
            error: errMessage(err),
          });
        });
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      timers.push(timer);
      deps.logger.info("extension job: registered", {
        extId: ext.id,
        jobId: job.id,
        schedule: job.schedule,
        intervalMs,
      });
    }
  }

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
    },
    jobCount: timers.length,
  };
}
