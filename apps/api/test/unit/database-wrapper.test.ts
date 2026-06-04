/**
 * Unit Tests: Database Wrapper
 *
 * Tests for database operation monitoring, logging, and error handling.
 */

import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseWrapper,
  type DatabaseWrapperEnv,
  type DatabaseWrapperOptions,
} from "../../src/lib/database-wrapper.js";

// Mock DatabaseMonitor
const mockLogQuery = vi.fn();
const mockLogConnectionFailure = vi.fn();
vi.mock("../../src/lib/database-monitor", () => ({
  DatabaseMonitor: class {
    logQuery = mockLogQuery;
    logConnectionFailure = mockLogConnectionFailure;
  },
}));

describe("DatabaseWrapper", () => {
  let wrapper: DatabaseWrapper;
  let mockPrisma: PrismaClient;
  let mockEnv: DatabaseWrapperEnv;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPrisma = {
      user: {
        findUnique: vi.fn(),
      },
    } as any;

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    };

    mockRequest = new Request("https://api.example.com/test", {
      method: "GET",
    });

    wrapper = new DatabaseWrapper(mockPrisma, mockEnv, "US");
  });

  describe("constructor", () => {
    it("should create wrapper with Prisma client and region", () => {
      const newWrapper = new DatabaseWrapper(mockPrisma, mockEnv, "EU");

      expect(newWrapper).toBeDefined();
      expect(newWrapper.getClient()).toBe(mockPrisma);
    });
  });

  describe("execute", () => {
    const createOptions = (
      overrides?: Partial<DatabaseWrapperOptions>,
    ): DatabaseWrapperOptions => ({
      region: "US",
      request: mockRequest,
      env: mockEnv,
      ...overrides,
    });

    it("should execute operation successfully and log query", async () => {
      const mockOperation = vi.fn().mockResolvedValue("result");
      const options = createOptions({
        operation: "findUser",
        userId: "user123",
      });

      const result = await wrapper.execute(mockOperation, options);

      expect(result).toBe("result");
      expect(mockOperation).toHaveBeenCalled();
      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "findUser",
          region: "US",
          success: true,
          userId: "user123",
        }),
        mockEnv,
      );
    });

    it("should log query duration", async () => {
      const mockOperation = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve("result"), 15)),
        );
      const options = createOptions({ operation: "findUser" });

      await wrapper.execute(mockOperation, options);

      const logCall = mockLogQuery.mock.calls[0][0];
      expect(logCall.duration).toBeGreaterThanOrEqual(10);
      expect(logCall.success).toBe(true);
    });

    it("should handle operation without operation name", async () => {
      const mockOperation = vi.fn().mockResolvedValue("result");
      const options = createOptions();

      const result = await wrapper.execute(mockOperation, options);

      expect(result).toBe("result");
      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "unknown",
        }),
        mockEnv,
      );
    });

    it("should handle operation without userId", async () => {
      const mockOperation = vi.fn().mockResolvedValue("result");
      const options = createOptions({ operation: "findUser" });

      await wrapper.execute(mockOperation, options);

      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: undefined,
        }),
        mockEnv,
      );
    });

    it("should throw error and log query failure", async () => {
      const mockError = new Error("Database query failed");
      const mockOperation = vi.fn().mockRejectedValue(mockError);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow(
        "Database query failed",
      );

      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "findUser",
          success: false,
          error: "Database query failed",
        }),
        mockEnv,
      );
    });

    it("should log connection failure for connection errors", async () => {
      const connectionError = new Error("Connection failed: ECONNREFUSED");
      const mockOperation = vi.fn().mockRejectedValue(connectionError);
      const options = createOptions({
        operation: "findUser",
        userId: "user123",
      });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogConnectionFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "US",
          error: "Connection failed: ECONNREFUSED",
          operation: "findUser",
          userId: "user123",
        }),
        mockEnv,
      );
    });

    it("should detect Prisma connection error codes", async () => {
      const prismaError = new Error("P1001: Can't reach database server");
      const mockOperation = vi.fn().mockRejectedValue(prismaError);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogConnectionFailure).toHaveBeenCalled();
    });

    it("should detect timeout errors", async () => {
      const timeoutError = new Error("Connection timeout");
      const mockOperation = vi.fn().mockRejectedValue(timeoutError);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogConnectionFailure).toHaveBeenCalled();
    });

    it("should detect network errors", async () => {
      const networkError = new Error("Network error occurred");
      const mockOperation = vi.fn().mockRejectedValue(networkError);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogConnectionFailure).toHaveBeenCalled();
    });

    it("should not log connection failure for non-connection errors", async () => {
      const validationError = new Error("Invalid input data");
      const mockOperation = vi.fn().mockRejectedValue(validationError);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogConnectionFailure).not.toHaveBeenCalled();
      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
        }),
        mockEnv,
      );
    });

    it("should handle errors without message", async () => {
      const errorWithoutMessage = { code: "ERROR" };
      const mockOperation = vi.fn().mockRejectedValue(errorWithoutMessage);
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      expect(mockLogQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Unknown error",
        }),
        mockEnv,
      );
    });

    it("should log query duration even on error", async () => {
      const mockError = new Error("Query failed");
      const mockOperation = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((_, reject) => setTimeout(() => reject(mockError), 15)),
        );
      const options = createOptions({ operation: "findUser" });

      await expect(wrapper.execute(mockOperation, options)).rejects.toThrow();

      const logCall = mockLogQuery.mock.calls[0][0];
      expect(logCall.duration).toBeGreaterThanOrEqual(10);
      expect(logCall.success).toBe(false);
    });
  });

  describe("getClient", () => {
    it("should return underlying Prisma client", () => {
      const client = wrapper.getClient();

      expect(client).toBe(mockPrisma);
    });

    it("should allow direct access to Prisma methods", () => {
      const client = wrapper.getClient();
      expect(client.user).toBeDefined();
    });
  });
});
