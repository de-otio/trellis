/**
 * Compatibility type shims for code migrated from Cloudflare Workers.
 * These types match the Cloudflare interfaces so migrated code works unchanged.
 */

// Cloudflare-KV-compatible types are owned by @de-otio/saas-foundation.
// Re-export them here so trellis code can keep its current import shape.
// Foundation's interface is narrower than the original Cloudflare KV API
// (no `<T>`-generic JSON get, no ReadableStream put) — those wider shapes
// were never exercised by trellis.
export type {
  KVNamespace,
  KvPutOptions,
  KvListOptions,
  KvListResult,
} from "@de-otio/saas-foundation/kv";

// Cloudflare-Queue-compatible producer types are owned by
// @de-otio/saas-foundation. Re-export them here so trellis code can keep its
// current import shape. `CloudflareQueue` is retained as a trellis-historical
// alias for `Queue` so handler imports stay unchanged. The consumer-side
// `Message` / `MessageBatch` types stay local — foundation ships
// producer-only (consumer adapters belong to the deployment layer).
export type {
  Queue,
  Queue as CloudflareQueue,
  QueueSendOptions,
  QueueBatchEntry,
} from "@de-otio/saas-foundation/queue";

// Cloudflare-R2-compatible storage types are owned by @de-otio/saas-foundation.
// Re-export them here so trellis code can keep its current import shape
// (`import type { R2Bucket } from "../types/cloudflare-compat"`) while the
// single source of truth lives in foundation. R2Object (head/put response)
// is metadata-only; the streaming body methods (`arrayBuffer`, `text`)
// live on R2ObjectBody (get response) — that distinction matches
// Cloudflare's actual API.
export type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2ListResult,
  R2HttpMetadata,
} from "@de-otio/saas-foundation/storage";

/** Cloudflare ExecutionContext — used for ctx.waitUntil() */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Minimal AnalyticsEngineDataset shim */
export interface AnalyticsEngineDataset {
  writeDataPoint(data: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

/** Minimal Hyperdrive shim (unused in AWS, only for type compatibility) */
export interface Hyperdrive {
  connectionString: string;
}

/** Cloudflare Queue MessageBatch — used by queue consumer handlers */
export interface Message<T = unknown> {
  id: string;
  timestamp: Date;
  body: T;
  ack(): void;
  retry(): void;
}

export interface MessageBatch<T = unknown> {
  queue: string;
  messages: Message<T>[];
  ackAll(): void;
  retryAll(): void;
}

/** Cloudflare Cron ScheduledEvent */
export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

