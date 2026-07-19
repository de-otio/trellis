/**
 * CronLock — narrow single-fire lock wrapper over WS-1's frozen `KvStore`
 * port (`cron` namespace), consumed by the extracted cron cores and the
 * worker container's scheduler (WS-2 §3.4, X1).
 *
 * Consumes exactly the frozen interface:
 *   `KvStore.putIfAbsent(key, value, { ttlSeconds, overwriteExpired: true })
 *    → KvCasResult` (`.applied`)
 * `overwriteExpired: true` is the old inline DynamoDB
 * `attribute_not_exists(pk) OR #ttl < :now` clause — acquire wins on absent
 * OR expired, exactly like today's conditional PutItem.
 *
 * `refresh` is the finding-5 heartbeat: owner-fenced (reads the lock,
 * verifies `value.owner === myOwner`, then a version-guarded `compareAndSet`
 * with a fresh TTL). If the owner changed — our lock expired and someone else
 * took it — `refresh` returns `false` and the caller aborts the running body
 * so it cannot double-execute.
 *
 * NOTE on release: today's Lambda crons never release — the lock persists
 * until its TTL expires, which is what makes a duplicate EventBridge fire
 * inside the window a skip. `withCronLock` therefore does NOT call
 * `release()` on completion; `release` exists for callers that explicitly
 * want early release (e.g. tests, ad-hoc runs).
 */

import type { KvStore } from "@de-otio/saas-foundation/kv";
import type { Logger } from "../logger.js";

/** The typed value stored under the `cron` namespace lock key. */
export interface CronLockValue {
  readonly lockedAt: number;
  readonly owner: string;
}

export interface CronLock {
  /** Try to acquire `name` for `ttlSeconds`. True iff this caller won. */
  acquire(name: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Owner-fenced heartbeat: extend the held lock's TTL. Returns `false` when
   * the lock was lost (expired + taken over, or vanished) — the caller MUST
   * abort its running body (finding 5).
   */
  refresh(name: string, ttlSeconds: number): Promise<boolean>;
  /** Best-effort early release (owner-fenced). Not called by withCronLock. */
  release(name: string): Promise<void>;
}

export interface KvCronLockOptions {
  /** Stable owner token for this process/instance. Default: random UUID. */
  readonly owner?: string;
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Build a `CronLock` over a `KvStore` bound to the `cron` namespace.
 * The store itself owns TTL semantics; this wrapper only adds owner fencing.
 */
export function makeKvCronLock(kv: KvStore, options: KvCronLockOptions = {}): CronLock {
  const owner = options.owner ?? crypto.randomUUID();
  const clock = options.clock ?? Date.now;

  return {
    async acquire(name: string, ttlSeconds: number): Promise<boolean> {
      const value: CronLockValue = {
        lockedAt: Math.floor(clock() / 1000),
        owner,
      };
      const result = await kv.putIfAbsent<CronLockValue>(name, value, {
        ttlSeconds,
        overwriteExpired: true,
      });
      return result.applied;
    },

    async refresh(name: string, ttlSeconds: number): Promise<boolean> {
      // Owner fence: read, verify ownership, then a version-guarded CAS with
      // a fresh TTL. A lost race (someone else took an expired lock) fails
      // the CAS and returns false — the running body must abort.
      const current = await kv.get<CronLockValue>(name, { consistent: true });
      if (current === null || current.value.owner !== owner) {
        return false;
      }
      const result = await kv.compareAndSet<CronLockValue>(
        name,
        current.version,
        { lockedAt: current.value.lockedAt, owner },
        { ttlSeconds },
      );
      return result.applied;
    },

    async release(name: string): Promise<void> {
      try {
        const current = await kv.get<CronLockValue>(name, { consistent: true });
        if (current === null || current.value.owner !== owner) return;
        await kv.delete(name, current.version);
      } catch {
        // Best-effort by contract: an expired lock self-heals via
        // overwriteExpired on the next acquire.
      }
    },
  };
}

export interface WithCronLockResult {
  /** False ⇒ another holder had the lock; the body did not run. */
  readonly acquired: boolean;
}

/**
 * Run `body` under a single-fire cron lock with the finding-5 heartbeat.
 *
 * - `acquire` failed → skip (identical to today's "already running, skip").
 * - While the body runs, `refresh(name, ttlSeconds)` fires every
 *   `ttlSeconds / 3`; a failed refresh aborts the body via the passed
 *   `AbortSignal` (cores check the signal between steps).
 * - The lock is NOT released on completion — it expires by TTL, preserving
 *   today's duplicate-fire-inside-the-window skip semantics.
 */
export async function withCronLock(
  lock: CronLock,
  name: string,
  ttlSeconds: number,
  logger: Logger,
  body: (signal: AbortSignal) => Promise<void>,
): Promise<WithCronLockResult> {
  const acquired = await lock.acquire(name, ttlSeconds);
  if (!acquired) {
    return { acquired: false };
  }

  const controller = new AbortController();
  let refreshing = false;
  const intervalMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
  const heartbeat = setInterval(() => {
    if (refreshing || controller.signal.aborted) return;
    refreshing = true;
    lock
      .refresh(name, ttlSeconds)
      .then((held) => {
        if (!held && !controller.signal.aborted) {
          logger.error("cron lock lost mid-run — aborting body to prevent double-execution", {
            lock: name,
          });
          controller.abort(
            new Error(`cron lock '${name}' lost mid-run (expired and taken over)`),
          );
        }
      })
      .catch((err) => {
        // A refresh ERROR is not a lost lock — the ≥2×-runtime TTL backstop
        // covers a stalled heartbeat (finding 5b). Log and keep running.
        logger.warn("cron lock heartbeat refresh failed (backstop TTL still applies)", {
          lock: name,
          error: err,
        });
      })
      .finally(() => {
        refreshing = false;
      });
  }, intervalMs);
  // Never keep the process alive just for the heartbeat (container shutdown).
  heartbeat.unref?.();

  try {
    await body(controller.signal);
  } finally {
    clearInterval(heartbeat);
  }
  return { acquired: true };
}
