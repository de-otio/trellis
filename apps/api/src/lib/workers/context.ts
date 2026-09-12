/**
 * WorkerContext — the injected capability bundle for extracted worker cores
 * (WS-2 §1.0).
 *
 * Worker cores (`lib/workers/*`) never reach for a global:
 *  (a) all capabilities arrive through `ctx`,
 *  (b) no `aws-lambda` / `@aws-lambda-powertools` imports,
 *  (c) no `process.env` reads — transitively (finding 7): a worker whose call
 *      tree still reads `process.env` for any secret/threshold is not
 *      "extracted". Env resolution stays in the AWS entrypoints and in the
 *      container's context assembly.
 *
 * Each worker declares the narrow `Pick<WorkerContext, …>` it needs — the
 * secret-blast-radius rule (finding 4) hangs on this: the media workers' deps
 * must never include the pseudonym-secret provider, identity-admin port, or
 * any session secret. Secret-bearing capabilities are PROVIDERS (lazy at-use
 * resolution), never eagerly-resolved values on the context.
 */

import type { PrismaClient } from "@prisma/client";
import type { KvStore } from "@de-otio/saas-foundation/kv";
import type { Logger } from "../logger.js";
import type { MetricsPort } from "./metrics-port.js";
import type { CronLock } from "./cron-lock.js";
import type { IdentityAdminPort } from "./identity-admin-port.js";
import type { StagingCleanupResult } from "../media/staging-object-cleanup.js";

/**
 * Provider-neutral object-batch deletion (nightly GC purge). One call deletes
 * one batch (callers slice to ≤1000 keys — the S3 DeleteObjects limit).
 */
export interface ObjectBatchDeleter {
  deleteObjects(keys: readonly string[]): Promise<void>;
}

/** Provider-neutral queue producer (matches the `CloudflareQueue` send shape). */
export interface QueueProducer {
  send(message: unknown): Promise<void>;
}

/**
 * Provider-neutral link threat-intel lookup (Google Safe Browsing today).
 *
 * A PORT rather than the service's env, because `checkSafeBrowsing` needs
 * `GOOGLE_SAFE_BROWSING_API_KEY` and a worker core may not read secrets or
 * `process.env` transitively (finding 7). The adapter binds the key and the KV
 * cache at the composition root; the core sees only a URL in and a verdict out.
 *
 * `status` mirrors `ThreatIntelResult`: "unknown" means the lookup could not
 * produce a verdict, and `retryable` says whether trying again could. A
 * transient API failure is retryable; a missing API key is not.
 */
export interface LinkThreatIntelPort {
  check(url: string): Promise<{
    status: "safe" | "unsafe" | "unknown";
    threats?: string[];
    failOpenReason?: string;
    retryable: boolean;
  }>;
}

export interface WorkerContext {
  /** Prisma client (Lambda: `getLambdaPrisma()`; container: pooled). */
  readonly db: PrismaClient;
  /**
   * LAZY Prisma resolution — used by the cron cores so a fire that loses the
   * single-fire lock (skip) never opens a DB connection, exactly like the old
   * handlers (lock first, `getPrisma()` second). Queue workers, which always
   * need the DB, use the eager `db` instead.
   */
  readonly getDb?: () => Promise<PrismaClient>;
  /** Neutral logger (`lib/logger.ts`, foundation/pino) — NOT powertools. */
  readonly logger: Logger;
  /** Metric emission port (§5.2). AWS: EMF adapter; container: OTel/no-op. */
  readonly metrics: MetricsPort;
  /** Injectable clock, epoch ms (aligned with WS-1's KvStore clock model). */
  readonly clock: () => number;
  /** Single-fire cron lock over WS-1 `KvStore.putIfAbsent` (`cron` ns, §3.4). */
  readonly cronLock: CronLock;

  // -- optional capabilities (present only where the worker needs them) -----

  /**
   * Direct access to the `cron`-namespace KvStore — ONLY for the
   * maintenance cron's defense-in-depth stale-lock sweep (§3.4; mostly
   * redundant once `overwriteExpired` handles expiry, kept deliberately).
   * Everything else goes through `cronLock`.
   */
  readonly cronKv?: KvStore;
  /** Provisional identity admin port (X6); Cognito-backed today. */
  readonly identity?: IdentityAdminPort;
  /**
   * GDPR-erasure tombstone HMAC key provider (findings 2 + 7). LAZY at-use
   * resolution — never an eagerly-resolved field (finding 4: the media
   * workers' ctx must not carry this). Consumers MUST fail closed on an
   * empty/absent value: throw before any deletion, never `HMAC("", …)`.
   */
  readonly resolvePseudonymSecret?: () => Promise<string>;
  /**
   * Staging-object cleanup for the account-deletion paths (wraps
   * `deleteStagingObjects` with the bucket + client bound in).
   */
  readonly deleteStagingObjects?: (
    keys: string[],
  ) => Promise<StagingCleanupResult>;
  /** Batch object deletion for the nightly soft-deleted-media purge. */
  readonly objectStore?: ObjectBatchDeleter;
  /** Queue producers the workers enqueue to (e2e-sweeper → delete-account). */
  readonly queues?: {
    readonly deleteAccount?: QueueProducer;
  };
  /**
   * Link threat-intel lookup for the `link-check` queue. Absent ⇒ the core
   * fails closed exactly as it did when it was a stub: it throws, nothing is
   * acked, and the message dead-letters rather than recording a verdict the
   * deployment never actually obtained.
   */
  readonly linkThreatIntel?: LinkThreatIntelPort;
}
