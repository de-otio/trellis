/**
 * Unit Tests: Export Routes
 *
 * Tests for user data export route handlers including creating export jobs, getting status, and downloading exports.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { exportRoutes } from "../../../src/lib/routes/export.js";
import type { Session } from "../../../src/lib/session-cookie.js";

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

// Mock SecurityHeaders
const mockCreateSecureResponse = vi.fn();
const mockAddSecurityHeaders = vi.fn();
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = mockAddSecurityHeaders;
    constructor(env: any) {}
  },
}));

// Mock UserExportHandler
const mockCreateExportJob = vi.fn();
const mockGetJobStatus = vi.fn();
const mockGetExportFile = vi.fn();
vi.mock("../../../src/lib/user-export-handler", () => ({
  UserExportHandler: class {
    createExportJob = mockCreateExportJob;
    getJobStatus = mockGetJobStatus;
    getExportFile = mockGetExportFile;
  },
}));

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));


describe("Export Routes", () => {
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockSession = {
      userId: "user-123",
      tenantId: "tenant-123",
      expiresAt: new Date(Date.now() + 3600000),
    } as Session;

    mockRequestContext = {
      tenantId: "tenant-123",
      userId: "user-123",
      region: "us-east-1",
    } as TrellisRequestContext;

    mockRequest = new Request("https://example.com/api/user/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ format: "json" }),
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);
    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("POST /api/user/export - Create export job", () => {
    const route = exportRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/user/export",
    );

    it("should create export job successfully with JSON format", async () => {
      const mockJob = {
        jobId: "job-123",
        status: "pending",
      };
      mockCreateExportJob.mockResolvedValue(mockJob);

      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockCreateExportJob).toHaveBeenCalledWith(
        mockSession,
        mockEnv,
        "json",
        mockRequestContext,
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          jobId: "job-123",
          status: "pending",
          message:
            "Export job created. Check status at /api/user/export/status/:jobId",
          estimatedCompletion: "Within 24 hours",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(202);
    });

    it("should create export job with ATProto format", async () => {
      const mockJob = {
        jobId: "job-456",
        status: "pending",
      };
      mockCreateExportJob.mockResolvedValue(mockJob);

      const atprotoRequest = new Request(
        "https://example.com/api/user/export",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ format: "atproto" }),
        },
      );

      await route!.handler(atprotoRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateExportJob).toHaveBeenCalledWith(
        mockSession,
        mockEnv,
        "atproto",
        mockRequestContext,
      );
    });

    it("should default to JSON format when format is not specified", async () => {
      const mockJob = {
        jobId: "job-789",
        status: "pending",
      };
      mockCreateExportJob.mockResolvedValue(mockJob);

      const requestWithoutFormat = new Request(
        "https://example.com/api/user/export",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      await route!.handler(requestWithoutFormat, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateExportJob).toHaveBeenCalledWith(
        mockSession,
        mockEnv,
        "json",
        mockRequestContext,
      );
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockCreateExportJob).not.toHaveBeenCalled();
    });

    it("should handle errors from UserExportHandler", async () => {
      const error = new Error("Failed to create export job");
      mockCreateExportJob.mockRejectedValue(error);

      const response = await route!.handler(mockRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          error: "Failed to create export job",
          message: "Failed to create export job",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });

    it("should handle invalid JSON body gracefully", async () => {
      const mockJob = {
        jobId: "job-123",
        status: "pending",
      };
      mockCreateExportJob.mockResolvedValue(mockJob);

      const invalidJsonRequest = new Request(
        "https://example.com/api/user/export",
        {
          method: "POST",
          body: "invalid json",
        },
      );

      await route!.handler(invalidJsonRequest, mockEnv, {
        requestContext: mockRequestContext,
      });

      // Should default to 'json' format when body parsing fails
      expect(mockCreateExportJob).toHaveBeenCalledWith(
        mockSession,
        mockEnv,
        "json",
        mockRequestContext,
      );
    });
  });

  describe("GET /api/user/export/status/:jobId - Get export job status", () => {
    const route = exportRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("status"),
    );

    it("should get export job status successfully", async () => {
      const mockJob = {
        jobId: "job-123",
        status: "completed",
        createdAt: new Date(),
        completedAt: new Date(),
        downloadUrl: "https://example.com/download/job-123",
      };
      mockGetJobStatus.mockResolvedValue(mockJob);

      const getRequest = new Request(
        "https://example.com/api/user/export/status/job-123",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/status/job-123",
      });

      expect(mockGetSession).toHaveBeenCalledWith(getRequest, "test-secret", mockEnv);
      expect(mockGetJobStatus).toHaveBeenCalledWith(
        "job-123",
        "user-123",
        mockEnv,
      );
      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify(mockJob),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/user/export/status/job-123",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/status/job-123",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetJobStatus).not.toHaveBeenCalled();
    });

    it("should return 404 when job is not found", async () => {
      mockGetJobStatus.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/user/export/status/job-123",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/status/job-123",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(404);
    });

    it("should handle errors from UserExportHandler", async () => {
      const error = new Error("Database error");
      mockGetJobStatus.mockRejectedValue(error);

      const getRequest = new Request(
        "https://example.com/api/user/export/status/job-123",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/status/job-123",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          error: "Failed to get export job status",
          message: "Database error",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("GET /api/user/export/download/:jobId - Download export file", () => {
    const route = exportRoutes.find(
      (r) => r.method === "GET" && r.path.toString().includes("download"),
    );

    it("should download export file successfully", async () => {
      const mockFileResponse = new Response("export data", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="export.json"',
        },
      });
      mockGetExportFile.mockResolvedValue(mockFileResponse);

      const getRequest = new Request(
        "https://example.com/api/user/export/download/job-123",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/download/job-123",
      });

      expect(mockGetSession).toHaveBeenCalledWith(getRequest, "test-secret", mockEnv);
      expect(mockGetExportFile).toHaveBeenCalledWith(
        "job-123",
        "user-123",
        mockEnv,
      );
      expect(mockAddSecurityHeaders).toHaveBeenCalledWith(mockFileResponse);
      expect(mockAddCorsHeaders).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 when session is missing", async () => {
      mockGetSession.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/user/export/download/job-123",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/download/job-123",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockGetExportFile).not.toHaveBeenCalled();
    });

    it("should return 404 when export file is not found or not ready", async () => {
      mockGetExportFile.mockResolvedValue(null);

      const getRequest = new Request(
        "https://example.com/api/user/export/download/job-123",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/download/job-123",
      });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Export file not found or not ready" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      expect(response.status).toBe(404);
    });

    it("should handle errors from UserExportHandler", async () => {
      const error = new Error("File access error");
      mockGetExportFile.mockRejectedValue(error);

      const getRequest = new Request(
        "https://example.com/api/user/export/download/job-123",
        {
          method: "GET",
        },
      );

      await route!.handler(getRequest, mockEnv, {
        pathname: "/api/user/export/download/job-123",
      });

            expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({
          error: "Failed to download export file",
          message: "File access error",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
      expect(mockAddCorsHeaders).toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(exportRoutes).toHaveLength(3);
      expect(exportRoutes.some((r) => r.method === "POST")).toBe(true);
      expect(exportRoutes.filter((r) => r.method === "GET")).toHaveLength(2);
    });

    it("should have middleware configured for all routes", () => {
      exportRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      exportRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
