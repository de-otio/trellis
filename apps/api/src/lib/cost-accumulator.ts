/**
 * Cost Accumulator
 *
 * Tracks counts of expensive operations in-memory, flushes to DynamoDB
 * periodically. Provides estimated daily spend by service.
 *
 * record() is synchronous and never throws — safe to call on every operation.
 * Flush happens every 10 seconds via setTimeout.
 */

import type { KvStore } from "@de-otio/saas-foundation/kv";
import { getKvStore } from "./kv/kv-provider.js";
import { getLogger, Logger } from "./logger.js";

export interface CostEvent {
  service: "openai" | "sqs" | "dynamodb" | "s3" | "ses";
  operation: string;
  units: number;
}

export interface DailyCostSummary {
  date: string;
  estimatedTotal: number;
  limit: number;
  services: Record<string, number>;
}

export interface CostLimitsConfig {
  dailyTotal: number;
  dailyPerService: Record<string, number>;
}

/** Approximate unit costs in USD. Within 2x of real pricing is fine. */
const UNIT_COSTS: Record<string, Record<string, number>> = {
  openai: { moderation: 0.001 },
  ses: { "send-email": 0.0001 },
  sqs: { "send-message": 0.0000004 },
  s3: { "put-object": 0.000005, "get-object": 0.0000004 },
  dynamodb: { write: 0.00000125, read: 0.00000025 },
};

let _store: KvStore | null = null;

/** The `costtrack` KvStore, provider-selected (KV_PROVIDER, default DynamoDB). */
function store(): KvStore {
  if (_store !== null) return _store;
  _store = getKvStore("costtrack");
  return _store;
}

/** Test seam: inject a `KvStore` (e.g. `MemoryKvStore`) for outcome-equivalence tests. */
export function __setCostStoreForTest(s: KvStore | null): void {
  _store = s;
}

let _instance: CostAccumulator | null = null;

export class CostAccumulator {
  private buffer: Map<string, number> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs = 10_000;
  private readonly logger = getLogger();
  private costLimits: CostLimitsConfig;

  constructor(costLimits: CostLimitsConfig) {
    this.costLimits = costLimits;
  }

  /** Get or create the singleton instance. */
  static getInstance(costLimits?: CostLimitsConfig): CostAccumulator {
    if (!_instance) {
      _instance = new CostAccumulator(costLimits || { dailyTotal: 10, dailyPerService: {} });
    }
    return _instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (_instance?.flushTimer) {
      clearTimeout(_instance.flushTimer);
    }
    _instance = null;
  }

  /**
   * Record a cost event. Synchronous, never throws, zero I/O.
   */
  record(event: CostEvent): void {
    const key = `${event.service}:${event.operation}`;
    this.buffer.set(key, (this.buffer.get(key) || 0) + event.units);
    this.ensureFlushScheduled();
  }

  /**
   * Get estimated daily spend by service from DynamoDB.
   */
  async getDailySummary(): Promise<DailyCostSummary> {
    const date = new Date().toISOString().slice(0, 10);
    const services: Record<string, number> = {};
    let estimatedTotal = 0;

    for (const service of Object.keys(UNIT_COSTS)) {
      try {
        const count = await this.readServiceCount(date, service);
        let cost = 0;
        for (const [op, unitCost] of Object.entries(UNIT_COSTS[service])) {
          // For simplicity, all units for a service are attributed to its first op cost
          cost += count * unitCost;
          break; // Use first operation's cost as estimate
        }
        // Refine: read per-op counts if stored
        services[service] = Math.round(cost * 100) / 100;
        estimatedTotal += cost;
      } catch {
        services[service] = 0;
      }
    }

    return {
      date,
      estimatedTotal: Math.round(estimatedTotal * 100) / 100,
      limit: this.costLimits.dailyTotal,
      services,
    };
  }

  /**
   * Check if any service exceeds its daily budget.
   */
  async isOverBudget(): Promise<{ exceeded: boolean; services: string[] }> {
    const summary = await this.getDailySummary();
    const overServices: string[] = [];

    if (summary.estimatedTotal >= this.costLimits.dailyTotal) {
      return { exceeded: true, services: ["total"] };
    }

    for (const [service, cost] of Object.entries(summary.services)) {
      const limit = this.costLimits.dailyPerService[service];
      if (limit && cost >= limit) {
        overServices.push(service);
      }
    }

    return { exceeded: overServices.length > 0, services: overServices };
  }

  /** Force an immediate flush (for graceful shutdown or testing). */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private ensureFlushScheduled(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => {
        this.logger.warn("[CostAccumulator] Flush error", { error: err });
      });
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const snapshot = new Map(this.buffer);
    this.buffer.clear();

    const date = new Date().toISOString().slice(0, 10);

    for (const [key, units] of snapshot) {
      const [service] = key.split(":");
      try {
        await this.atomicAdd(date, service, units);
      } catch {
        // Re-buffer on failure — will be retried on next flush
        this.buffer.set(key, (this.buffer.get(key) || 0) + units);
        this.ensureFlushScheduled();
      }
    }
  }

  private async atomicAdd(date: string, service: string, units: number): Promise<void> {
    // Atomic server-side add + set-once 48h TTL (matches the pre-port
    // `ADD #units :inc SET #ttl = if_not_exists(#ttl, :ttl)`).
    await store().increment(`${date}:${service}`, "units", units, { ttlSeconds: 172800 });
  }

  private async readServiceCount(date: string, service: string): Promise<number> {
    const rec = await store().get<{ units?: number }>(`${date}:${service}`);
    return rec?.value.units ?? 0;
  }
}
