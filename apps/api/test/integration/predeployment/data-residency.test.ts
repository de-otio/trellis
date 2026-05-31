/**
 * Integration Tests: Data Residency
 *
 * Tests data residency enforcement and region validation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataRouterEnv } from "../../../src/lib/data-router.js";
import { DataRouter } from "../../../src/lib/data-router.js";

// Mock database
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn((region: string) => {
    const mockPostCreate = vi.fn().mockResolvedValue({
      id: "post123",
      authorId: "user123",
      dataRegion: region,
    });
    const mockDb = {
      user: {
        create: vi.fn().mockResolvedValue({
          id: "user123",
          email: "test@example.com",
          region: region,
          dataRegion: region,
        }),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        upsert: vi.fn().mockResolvedValue({
          id: "user123",
          email: "test@example.com",
          region: region,
          dataRegion: region,
        }),
      },
      post: {
        create: mockPostCreate,
        findUnique: vi.fn().mockResolvedValue(null),
      },
      postEntity: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      entity: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (callback: any) => {
        const tx = {
          post: {
            create: mockPostCreate,
          },
          postEntity: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          entity: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return await callback(tx);
      }),
    };
    return mockDb;
  }),
}));

// Mock audit logger (composer)
vi.mock("../../../src/lib/audit-composer", () => ({
  TrellisAuditLogger: vi.fn().mockImplementation(() => ({
    logUserAction: vi.fn().mockResolvedValue(undefined),
    logDataAccess: vi.fn().mockResolvedValue(undefined),
    withRequestId: vi.fn().mockReturnThis(),
  })),
}));

// Mock database connection manager to use mocked database (no real connections)
// This ensures tests don't try to connect to Hyperdrive or PostgREST
vi.mock("../../../src/lib/database-connection-manager", async () => {
  const dbModule = await import("../../../src/db.js");
  return {
    sharedDatabaseConnectionManager: {
      executeWithRetry: async (
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
        options?: any,
      ) => {
        // Use the mocked createPrismaForRegion from the db mock
        const db = (dbModule.createPrismaForRegion as any)(region, env);
        return await queryFn(db);
      },
    },
    DatabaseConnectionManager: class {
      executeWithRetry = async (
        region: string,
        env: any,
        queryFn: (db: any) => Promise<any>,
        options?: any,
      ) => {
        const db = (dbModule.createPrismaForRegion as any)(region, env);
        return await queryFn(db);
      };
    },
  };
});

describe("Data Residency Integration", () => {
  let mockEnv: DataRouterEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL:
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      DEFAULT_REGION: "US",
      HYPERDRIVE: {
        connectionString:
          "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      } as any,
    };
  });

  describe("Region Validation", () => {
    it("should reject invalid regions", () => {
      expect(() => {
        DataRouter.getDatabaseForRegion("INVALID", mockEnv);
      }).toThrow("Invalid region");
    });

    it("should accept valid regions", () => {
      expect(() => {
        DataRouter.getDatabaseForRegion("US", mockEnv);
      }).not.toThrow();

      expect(() => {
        DataRouter.getDatabaseForRegion("CN", mockEnv);
      }).not.toThrow();

      expect(() => {
        DataRouter.getDatabaseForRegion("EU", mockEnv);
      }).not.toThrow();
    });
  });

  describe("Data Region Enforcement", () => {
    it("should set dataRegion to match region when creating user", async () => {
      const envWithChina = {
        ...mockEnv,
        SUPABASE_URL_CN: "https://cn-test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY_CN: "cn-service-role-key",
      };
      const user = await DataRouter.createUser(
        { id: "user123", email: "test@example.com" },
        "CN",
        envWithChina,
      );

      expect(user.dataRegion).toBe("CN");
      expect(user.region).toBe("CN");
    });

    it("should set dataRegion to match region when creating post", async () => {
      const post = await DataRouter.createPost(
        {
          authorId: "user123",
          text: "Test post",
          visibility: "PUBLIC",
        },
        "CN",
        mockEnv,
      );

      expect(post.dataRegion).toBe("CN");
    });
  });
});
