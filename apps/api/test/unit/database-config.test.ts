/**
 * Unit tests for database configuration manager
 */

import { describe, it, expect } from "vitest";
import { getDatabaseConnection } from "../../src/lib/database-config.js";
import type { Env } from "../../src/lib/database-config.js";

describe("Database Configuration Manager", () => {
  const baseEnv: Env = {
    DATABASE_URL:
      "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
  };

  describe("getDatabaseConnection", () => {
    it("should return global connection for US region", () => {
      const connection = getDatabaseConnection("US", baseEnv);

      expect(connection).toBe(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should return global connection for EU region", () => {
      const connection = getDatabaseConnection("EU", baseEnv);

      expect(connection).toBe(
        "postgresql://test-hyperdrive-id.hyperdrive.workers.dev:5432/postgres",
      );
    });

    it("should return China connection for CN region when available", () => {
      const envWithChina: Env = {
        ...baseEnv,
        DATABASE_URL_CN: "postgresql://cn-test-host:5432/postgres",
      };

      const connection = getDatabaseConnection("CN", envWithChina);

      expect(connection).toBe("postgresql://cn-test-host:5432/postgres");
    });

    it("should throw error for CN region when China connection is missing", () => {
      expect(() => {
        getDatabaseConnection("CN", baseEnv);
      }).toThrow("China region requires DATABASE_URL_CN environment variable");
    });

    it("should throw error for invalid region", () => {
      expect(() => {
        getDatabaseConnection("INVALID", baseEnv);
      }).toThrow("Invalid region: INVALID");
    });

    it("should throw error when DATABASE_URL is missing", () => {
      const envWithoutUrl: Env = {
        DATABASE_URL: "",
      };

      expect(() => {
        getDatabaseConnection("US", envWithoutUrl);
      }).toThrow("DATABASE_URL environment variable is required");
    });

    it("should handle empty DATABASE_URL_CN gracefully", () => {
      const envWithEmptyChina: Env = {
        ...baseEnv,
        DATABASE_URL_CN: "",
      };

      expect(() => {
        getDatabaseConnection("CN", envWithEmptyChina);
      }).toThrow("China region requires DATABASE_URL_CN environment variable");
    });
  });
});
