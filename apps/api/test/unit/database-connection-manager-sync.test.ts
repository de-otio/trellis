import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseConnectionManager,
  type EnvWithDb,
} from "../../src/lib/database-connection-manager.js";

// Mock pg.Pool
const mockPoolInstances: Array<{
  instance: any;
  config: any;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      config: any;
      totalCount: number = 0;
      idleCount: number = 0;
      waitingCount: number = 0;
      query: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;

      constructor(config: any) {
        this.config = config;
        this.query = vi.fn();
        this.end = vi.fn().mockResolvedValue(undefined);
        this.on = vi.fn();
        mockPoolInstances.push({
          instance: this,
          config,
          query: this.query,
          end: this.end,
          on: this.on,
        });
      }
    },
  };
});

// Mock PrismaPg adapter
vi.mock("@prisma/adapter-pg", () => {
  return {
    PrismaPg: class MockPrismaPg {
      pool: any;
      constructor(pool: any) {
        this.pool = pool;
      }
    },
  };
});

// Mock PrismaClient
const mockPrismaClientInstances: any[] = [];
vi.mock("@prisma/client", () => {
  return {
    PrismaClient: class MockPrismaClient {
      adapter: any;
      constructor(config: any) {
        this.adapter = config.adapter;
        mockPrismaClientInstances.push(this);
      }
      $disconnect() {
        return Promise.resolve();
      }
    },
  };
});

// Mock database-config
vi.mock("../../src/lib/database-config", () => {
  return {
    getDatabaseConnection: vi.fn((region: string, env: any) => {
      if (region === "CN") {
        return env.DATABASE_URL_CN;
      }
      return env.DATABASE_URL;
    }),
  };
});

describe("DatabaseConnectionManager Sync Methods", () => {
  const baseEnv: EnvWithDb = {
    DATABASE_URL:
      "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    HYPERDRIVE: {
      connectionString:
        "postgresql://test-hyperdrive.hyperdrive.workers.dev:5432/postgres",
    } as any,
  };

  let manager: DatabaseConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolInstances.length = 0;
    mockPrismaClientInstances.length = 0;
    manager = new DatabaseConnectionManager();
  });

  afterEach(() => {
    manager.clearPools();
  });

  it("createClientSync should reuse cached Pool for same connection string", () => {
    // First call
    const client1 = manager.createClientSync("US", baseEnv);
    expect(mockPoolInstances.length).toBe(1);
    const pool1 = mockPoolInstances[0].instance;

    // Second call - reuses cached pool
    const client2 = manager.createClientSync("US", baseEnv);
    expect(mockPoolInstances.length).toBe(1); // No new pool created

    expect(client1).toBe(client2); // Same cached Prisma client
  });

  it("createClientSync should create new pool if configuration changes", () => {
    const client1 = manager.createClientSync("US", baseEnv);

    const env2 = { ...baseEnv, DATABASE_STATEMENT_TIMEOUT_MS: "20000" };
    const client2 = manager.createClientSync("US", env2);

    expect(mockPoolInstances.length).toBe(2);
  });

  it("createClientSync and async createClient share the same cached pool", async () => {
    // Create via sync
    const clientSync = manager.createClientSync("US", baseEnv);
    expect(mockPoolInstances.length).toBe(1);

    // Create via async - reuses cached pool
    const { client: clientAsync } = await manager.createClient("US", baseEnv);
    expect(mockPoolInstances.length).toBe(1); // Same pool reused

    expect(clientSync).toBe(clientAsync); // Same cached Prisma client
  });

  it("createClientSync should handle China region correctly", () => {
    const envCN: EnvWithDb = {
      ...baseEnv,
      SUPABASE_URL_CN: "https://cn-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY_CN: "cn-key",
    };

    const client = manager.createClientSync("CN", envCN);
    expect(client).toBeDefined();
    // CN region now uses a regular Pool (same as other regions in AWS architecture)
    expect(mockPoolInstances.length).toBe(1);
  });
});
