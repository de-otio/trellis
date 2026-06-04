/**
 * Mock Cloudflare Workers Environment
 *
 * Provides a mock Env object for testing Cloudflare Workers.
 */

import type {
  KVNamespace,
  AnalyticsEngineDataset,
  AnalyticsEngineDataPoint,
} from "@cloudflare/workers-types";

export interface MockEnv {
  DATABASE_URL: string;
  DIRECT_URL: string;
  SESSION_SECRET: string;
  ENVIRONMENT?: string;
  DEPLOY_ENV?: string;
  APP_DOMAIN?: string;
  BLUESKY_SERVICE_URL?: string;
  OPENAI_API_KEY?: string; // OpenAI API key for moderation API (text moderation)
  RATE_LIMIT_KV?: KVNamespace;
  SESSIONS?: KVNamespace;
  IDEMPOTENCY_KV?: KVNamespace;
  FEED_CACHE_KV?: KVNamespace;
  MODERATION_CACHE_KV?: KVNamespace;
  FRIENDS_KV?: KVNamespace;
  CONNECTION_CODES_KV?: KVNamespace;
  COMMENTS_KV?: KVNamespace;
  LOGS?: AnalyticsEngineDataset;
  [key: string]: any; // Allow dynamic secret keys
}

export function createMockEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  const env: MockEnv = {
    DATABASE_URL:
      "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
    DIRECT_URL: "postgres://test",
    SESSION_SECRET: "test-secret-key-32-characters-long!!",
    ENVIRONMENT: "dev",
    APP_DOMAIN: "https://test.example.com",
    BLUESKY_SERVICE_URL: "https://bsky.social",
    ...overrides,
  };
  return env;
}

/**
 * Mock KV Namespace
 *
 * Implements a simplified version of KVNamespace for testing.
 * Uses 'as any' for complex overloads to keep the mock simple.
 */
export class MockKV {
  private store: Map<string, { value: string; expirationTtl?: number }> =
    new Map();

  // Implement all KVNamespace.get overloads
  async get(key: string, type?: "text"): Promise<string | null>;
  async get(key: string, type: "json"): Promise<any>;
  async get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  async get(key: string, type: "stream"): Promise<ReadableStream | null>;
  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream",
  ): Promise<string | null | any | ArrayBuffer | ReadableStream> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Simple expiration check (in real tests, you'd want more sophisticated handling)
    if (type === "json") {
      return JSON.parse(entry.value);
    }
    if (type === "arrayBuffer") {
      return new TextEncoder().encode(entry.value).buffer;
    }
    if (type === "stream") {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(entry.value));
          controller.close();
        },
      });
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number; metadata?: any },
  ): Promise<void> {
    let stringValue: string;
    if (typeof value === "string") {
      stringValue = value;
    } else if (value instanceof ArrayBuffer) {
      stringValue = Buffer.from(value).toString("utf-8");
    } else if (value instanceof Uint8Array) {
      stringValue = Buffer.from(value).toString("utf-8");
    } else if (ArrayBuffer.isView(value)) {
      // Handle other ArrayBufferView types
      const uint8Array = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      stringValue = Buffer.from(uint8Array).toString("utf-8");
    } else {
      throw new Error("Unsupported value type for MockKV");
    }

    this.store.set(key, {
      value: stringValue,
      expirationTtl: options?.expirationTtl,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: any): Promise<any> {
    return {
      keys: Array.from(this.store.keys()).map((name) => ({ name })),
      list_complete: true as const,
      cacheStatus: null as string | null,
    };
  }

  async getWithMetadata<Metadata = unknown>(
    key: string,
    options?: any,
  ): Promise<any> {
    const value = await this.get(key);
    return {
      value,
      metadata: null as Metadata | null,
      cacheStatus: null as string | null,
    };
  }

  // Clear for test cleanup
  clear(): void {
    this.store.clear();
  }
}

// Type assertion to make MockKV compatible with KVNamespace for tests
// Note: MockKV implements a simplified version of KVNamespace
// The type assertion is needed because the full KVNamespace interface
// has complex overloads that are difficult to match exactly
export const MockKVAsKV = MockKV as any as new () => KVNamespace<string>;

// Helper to cast MockKV instance to KVNamespace
export function asKVNamespace(mockKV: MockKV): KVNamespace {
  return mockKV as any as KVNamespace;
}

/**
 * Mock Analytics Engine
 */
export class MockAnalyticsEngine implements AnalyticsEngineDataset {
  async writeDataPoint(event: AnalyticsEngineDataPoint): Promise<void> {
    // In tests, we might want to capture these for assertions
    // For now, just a no-op
  }
}
