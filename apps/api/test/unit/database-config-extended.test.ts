/**
 * Extended Unit Tests: Database Configuration
 *
 * Tests edge cases for database connection configuration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDatabaseConnection } from "../../src/lib/database-config.js";
import type { Env } from "../../src/lib/database-config.js";

describe("Database Configuration Extended", () => {
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DATABASE_URL:
        "postgresql://default-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
    };
  });

  describe("getDatabaseConnection", () => {
    it("should return DATABASE_URL for US region", () => {
      const env: Env = {
        ...mockEnv,
        DATABASE_URL:
          "postgresql://us-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      };
      const connection = getDatabaseConnection("US", env);
      expect(connection).toBe(
        "postgresql://us-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should return DATABASE_URL for EU region", () => {
      const env: Env = {
        ...mockEnv,
        DATABASE_URL:
          "postgresql://eu-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      };
      const connection = getDatabaseConnection("EU", env);
      expect(connection).toBe(
        "postgresql://eu-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should return DATABASE_URL_CN for CN region", () => {
      const env: Env = {
        ...mockEnv,
        DATABASE_URL_CN: "postgresql://cn-test-host:5432/postgres",
      };
      const connection = getDatabaseConnection("CN", env);
      expect(connection).toBe("postgresql://cn-test-host:5432/postgres");
    });

    it("should fallback to DATABASE_URL if region-specific URL not set", () => {
      const connection = getDatabaseConnection("US", mockEnv);
      expect(connection).toBe(
        "postgresql://default-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should throw error for invalid region", () => {
      expect(() => getDatabaseConnection("INVALID", mockEnv)).toThrow(
        "Invalid region",
      );
    });

    it("should throw error if CN region URL not set", () => {
      const env: Env = {
        ...mockEnv,
        DATABASE_URL_CN: undefined,
      };
      expect(() => getDatabaseConnection("CN", env)).toThrow(
        "China region requires DATABASE_URL_CN",
      );
    });

    it("should throw error if DATABASE_URL not set", () => {
      const env: Env = {
        DATABASE_URL: "",
      };
      expect(() => getDatabaseConnection("US", env)).toThrow(
        "DATABASE_URL environment variable is required",
      );
    });
  });
});
