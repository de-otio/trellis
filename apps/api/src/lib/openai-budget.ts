/**
 * OpenAI Request Budget
 *
 * Tracks OpenAI API calls per hour/day using atomic DynamoDB counters.
 * When the budget is exceeded, returns false so callers can skip the API call.
 * Fail-open: if DynamoDB is unavailable, allows the call through.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout, type KvStore } from "@de-otio/saas-foundation/kv";
import { getLogger, Logger } from "./logger.js";

export interface OpenAiBudgetConfig {
  enabled: boolean;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
}

export interface OpenAiBudgetStatus {
  hourlyUsed: number;
  hourlyLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  exceeded: boolean;
}

const TABLE_NAME = process.env.DYNAMODB_TABLE || `${process.env.STAGE || "dev"}-trellis`;

let _store: KvStore | null = null;

/**
 * Lazily build the default DynamoKvStore over the byte-compat `costbudget`
 * layout (pk `costbudget:{key}`, sk `v`, ttl attr `ttl`, native `count`).
 * `allowSeparatorInKey` because the key is a server-constructed
 * `openai:hourly:{ts}` / `openai:daily:{date}` composite (ws1-kv-port-plan §3.2).
 */
function store(): KvStore {
  if (_store !== null) return _store;
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  });
  const layout: DynamoKvLayout = {
    tableName: TABLE_NAME,
    pkPrefix: "costbudget",
    pkSeparator: ":",
    skName: "sk",
    skValue: "v",
    ttlAttr: "ttl",
    versionAttr: "_v",
    nativeNumberFields: ["count"],
    allowSeparatorInKey: true,
  };
  _store = new DynamoKvStore(client, layout);
  return _store;
}

/** Test seam: inject a `KvStore` (e.g. `MemoryKvStore`) for outcome-equivalence tests. */
export function __setOpenAiBudgetStoreForTest(s: KvStore | null): void {
  _store = s;
}

export class OpenAiBudget {
  private config: OpenAiBudgetConfig;
  private logger = getLogger();

  constructor(config: OpenAiBudgetConfig) {
    this.config = config;
  }

  /**
   * Try to consume one OpenAI request from the budget.
   * Returns true if the call is allowed, false if budget is exceeded.
   * Fail-open: returns true on any DynamoDB error.
   */
  async tryConsume(): Promise<boolean> {
    if (!this.config.enabled) return true;

    try {
      const now = new Date();
      const hourlyKey = `openai:hourly:${now.toISOString().slice(0, 13)}`;
      const dailyKey = `openai:daily:${now.toISOString().slice(0, 10)}`;

      // Atomically increment hourly counter
      const hourlyCount = await this.atomicIncrement(hourlyKey, 7200);
      if (hourlyCount > this.config.maxRequestsPerHour) {
        this.logger.warn("[OpenAiBudget] Hourly budget exceeded", {
          hourlyCount,
          limit: this.config.maxRequestsPerHour,
        });
        return false;
      }

      // Atomically increment daily counter
      const dailyCount = await this.atomicIncrement(dailyKey, 172800);
      if (dailyCount > this.config.maxRequestsPerDay) {
        this.logger.warn("[OpenAiBudget] Daily budget exceeded", {
          dailyCount,
          limit: this.config.maxRequestsPerDay,
        });
        return false;
      }

      return true;
    } catch (error) {
      // Fail-open: if DynamoDB is down, allow the call
      this.logger.warn("[OpenAiBudget] Counter error, failing open", { error });
      return true;
    }
  }

  /**
   * Read-only status check for the health/admin endpoint.
   * Does not increment counters.
   */
  async getStatus(): Promise<OpenAiBudgetStatus> {
    if (!this.config.enabled) {
      return {
        hourlyUsed: 0,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed: 0,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded: false,
      };
    }

    try {
      const now = new Date();
      const hourlyKey = `openai:hourly:${now.toISOString().slice(0, 13)}`;
      const dailyKey = `openai:daily:${now.toISOString().slice(0, 10)}`;

      const [hourlyUsed, dailyUsed] = await Promise.all([
        this.readCounter(hourlyKey),
        this.readCounter(dailyKey),
      ]);

      return {
        hourlyUsed,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded:
          hourlyUsed >= this.config.maxRequestsPerHour ||
          dailyUsed >= this.config.maxRequestsPerDay,
      };
    } catch {
      return {
        hourlyUsed: 0,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed: 0,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded: false,
      };
    }
  }

  /**
   * Atomically increment a counter in DynamoDB using ADD expression.
   * Returns the post-increment value.
   */
  private async atomicIncrement(key: string, ttlSeconds: number): Promise<number> {
    // Atomic server-side add with set-once TTL; returns the post-value
    // (matches the pre-port `ADD #count :inc ... ReturnValues:"ALL_NEW"`).
    return store().increment(key, "count", 1, { ttlSeconds });
  }

  /**
   * Read a counter value without incrementing.
   */
  private async readCounter(key: string): Promise<number> {
    const rec = await store().get<{ count?: number }>(key);
    return rec?.value.count ?? 0;
  }
}
