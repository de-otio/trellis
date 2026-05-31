/**
 * Integration Tests: Data Routing
 *
 * Tests data routing with region validation and data residency enforcement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DataRouter } from "../../../src/lib/data-router.js";
import type { DataRouterEnv } from "../../../src/lib/data-router.js";

// Mock database
vi.mock("../../../src/db", () => ({
  createPrismaForRegion: vi.fn((region: string) => {
    return {
      user: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      post: {
        create: vi.fn(),
        findUnique: vi.fn(),
      },
    };
  }),
}));

describe("Data Routing Integration", () => {
  let mockEnv: DataRouterEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL:
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      DEFAULT_REGION: "US",
    };
  });

  describe("getDatabaseForRegion", () => {
    it("should return database for US region", () => {
      const db = DataRouter.getDatabaseForRegion("US", mockEnv);

      expect(db).toBeDefined();
    });

    it("should return database for CN region", () => {
      const db = DataRouter.getDatabaseForRegion("CN", mockEnv);

      expect(db).toBeDefined();
    });

    it("should throw error for invalid region", () => {
      expect(() => {
        DataRouter.getDatabaseForRegion("INVALID", mockEnv);
      }).toThrow("Invalid region");
    });
  });

  describe("region validation", () => {
    it("should validate region before routing", () => {
      expect(() => {
        DataRouter.getDatabaseForRegion("XX", mockEnv);
      }).toThrow("Invalid region");
    });
  });
});
