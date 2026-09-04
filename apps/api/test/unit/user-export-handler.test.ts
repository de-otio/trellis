/**
 * Unit Tests: User Export Handler
 *
 * Tests for GDPR-compliant user data export, job creation, and processing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";
import {
  UserExportHandler,
  type Env,
  type ExportJob,
} from "../../src/lib/user-export-handler.js";
import {
  setExtensionModelRegistry,
  __resetExtensionModelRegistryForTest,
} from "../../src/lib/extension-model-registry.js";

// Mock DataRouter
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getUser: vi.fn(),
    getDatabaseForRegion: vi.fn(),
  },
}));

// Mock database
const mockDb = {
  post: {
    findMany: vi.fn(),
  },
  postComment: {
    findMany: vi.fn(),
  },
  postSentiment: {
    findMany: vi.fn(),
  },
  commentSentiment: {
    findMany: vi.fn(),
  },
  postGeoIndex: {
    findMany: vi.fn(),
  },
};

describe("UserExportHandler", () => {
  let handler: UserExportHandler;
  let mockEnv: Env;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext | undefined;
  let mockExportJobsKV: any;
  let mockExportFilesR2: any;
  let mockExportQueue: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    handler = new UserExportHandler();

    mockSession = {
      userId: "user123",
      email: "test@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      sessionType: "user",
      lastActivityAt: Date.now(),
    };

    mockRequestContext = {
      region: "US",
      requestId: "req123",
    };

    mockExportJobsKV = {
      get: vi.fn(),
      put: vi.fn(),
    };

    mockExportFilesR2 = {
      put: vi.fn(),
      get: vi.fn(),
    };

    mockExportQueue = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      EXPORT_JOBS_KV: mockExportJobsKV,
      EXPORT_FILES_R2: mockExportFilesR2,
      EXPORT_QUEUE: mockExportQueue,
      DEFAULT_REGION: "EU",
    };

    // Setup default mocks
    const { DataRouter } = await import("../../src/lib/data-router.js");
    vi.mocked(DataRouter.getDatabaseForRegion).mockReturnValue(mockDb);
    vi.mocked(DataRouter.getUser).mockResolvedValue({
      id: "user123",
      email: "test@example.com",
      did: "did:plc:test123",
      handle: "testuser",
      createdAt: new Date("2024-01-01"),
      region: "US",
    });

    mockDb.post.findMany.mockResolvedValue([]);
    mockDb.postComment.findMany.mockResolvedValue([]);
    mockDb.postSentiment.findMany.mockResolvedValue([]);
    mockDb.commentSentiment.findMany.mockResolvedValue([]);
    mockDb.postGeoIndex.findMany.mockResolvedValue([]);
  });

  describe("createExportJob", () => {
    it("should create export job successfully with JSON format", async () => {
      const job = await handler.createExportJob(
        mockSession,
        mockEnv,
        "json",
        mockRequestContext,
      );

      expect(job).toBeDefined();
      expect(job.jobId).toContain("export-user123");
      expect(job.userId).toBe("user123");
      expect(job.email).toBe("test@example.com");
      expect(job.format).toBe("json");
      expect(job.status).toBe("pending");
      expect(job.region).toBe("US");
      expect(mockExportJobsKV.put).toHaveBeenCalled();
      expect(mockExportQueue.send).toHaveBeenCalledWith({
        jobId: job.jobId,
        userId: "user123",
        email: "test@example.com",
        format: "json",
        region: "US",
      });
    });

    it("should create export job with AT Protocol format", async () => {
      const job = await handler.createExportJob(
        mockSession,
        mockEnv,
        "atproto",
        mockRequestContext,
      );

      expect(job.format).toBe("atproto");
      expect(mockExportQueue.send).toHaveBeenCalledWith(
        expect.objectContaining({
          format: "atproto",
        }),
      );
    });

    it("should use default region if not provided in request context", async () => {
      const job = await handler.createExportJob(
        mockSession,
        mockEnv,
        "json",
        undefined,
      );

      expect(job.region).toBe("EU"); // DEFAULT_REGION
    });

    // BOTH REVERSED. "Graceful degradation" and "development mode" were the
    // stated intent; the actual behaviour was that a GDPR Art. 15 data-access
    // request returned a `pending` job that was never stored and never queued.
    // getJobStatus then reported it as not-found, so the user saw an export
    // accepted, then vanished. Nothing degraded gracefully — the request was
    // dropped and success reported.
    it("refuses rather than reporting an export it cannot track (no EXPORT_JOBS_KV)", async () => {
      delete mockEnv.EXPORT_JOBS_KV;

      await expect(
        handler.createExportJob(mockSession, mockEnv, "json"),
      ).rejects.toThrow(/unavailable/i);
    });

    it("refuses rather than reporting an export that will never run (no EXPORT_QUEUE)", async () => {
      delete mockEnv.EXPORT_QUEUE;

      await expect(
        handler.createExportJob(mockSession, mockEnv, "json"),
      ).rejects.toThrow(/unavailable/i);
    });

    it("does not queue a job whose status row could not be written", async () => {
      // Ordering matters: a queued export with no status row looks to the user
      // like one that was never requested.
      delete mockEnv.EXPORT_JOBS_KV;

      await expect(
        handler.createExportJob(mockSession, mockEnv, "json"),
      ).rejects.toThrow();
      expect(mockExportQueue.send).not.toHaveBeenCalled();
    });
  });

  describe("getJobStatus", () => {
    it("should return job status for valid job", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "processing",
        createdAt: new Date().toISOString(),
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const result = await handler.getJobStatus("job123", "user123", mockEnv);

      expect(result).toEqual(job);
      expect(mockExportJobsKV.get).toHaveBeenCalledWith("job:job123");
    });

    it("should return null if job not found", async () => {
      mockExportJobsKV.get.mockResolvedValue(null);

      const result = await handler.getJobStatus("job123", "user123", mockEnv);

      expect(result).toBeNull();
    });

    it("should return null if job belongs to different user (security)", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "other-user",
        email: "other@example.com",
        format: "json",
        status: "processing",
        createdAt: new Date().toISOString(),
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const result = await handler.getJobStatus("job123", "user123", mockEnv);

      expect(result).toBeNull();
    });

    it("should return null if EXPORT_JOBS_KV not configured", async () => {
      delete mockEnv.EXPORT_JOBS_KV;

      const result = await handler.getJobStatus("job123", "user123", mockEnv);

      expect(result).toBeNull();
    });
  });

  describe("processExportJob", () => {
    const mockJobData = {
      jobId: "job123",
      userId: "user123",
      email: "test@example.com",
      format: "json" as const,
      region: "US",
    };

    beforeEach(() => {
      mockExportJobsKV.get.mockResolvedValue(
        JSON.stringify({
          jobId: "job123",
          userId: "user123",
          email: "test@example.com",
          format: "json",
          status: "pending",
          createdAt: new Date().toISOString(),
          region: "US",
        }),
      );
    });

    it("should process export job successfully", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      const { DataRouter } = await import("../../src/lib/data-router.js");
      expect(DataRouter.getDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        mockEnv,
      );
      expect(DataRouter.getUser).toHaveBeenCalledWith("user123", "US", mockEnv);
      expect(mockDb.post.findMany).toHaveBeenCalled();
      expect(mockExportFilesR2.put).toHaveBeenCalled();
      expect(mockExportJobsKV.put).toHaveBeenCalledWith(
        "job:job123",
        expect.stringContaining('"status":"completed"'),
        expect.any(Object),
      );
    });

    it("should throw error if user not found", async () => {
      const { DataRouter } = await import("../../src/lib/data-router.js");
      vi.mocked(DataRouter.getUser).mockResolvedValue(null);

      await expect(
        handler.processExportJob(mockJobData, mockEnv),
      ).rejects.toThrow("User not found");
    });

    it("should determine region from job data if not provided", async () => {
      const jobDataWithoutRegion = {
        ...mockJobData,
        region: undefined,
      };

      await handler.processExportJob(jobDataWithoutRegion, mockEnv);

      const { DataRouter } = await import("../../src/lib/data-router.js");
      expect(DataRouter.getDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        mockEnv,
      );
    });

    it("should determine region from user record if not in job", async () => {
      mockExportJobsKV.get.mockResolvedValue(
        JSON.stringify({
          jobId: "job123",
          userId: "user123",
          email: "test@example.com",
          format: "json",
          status: "pending",
          createdAt: new Date().toISOString(),
          // No region in job
        }),
      );

      const jobDataWithoutRegion = {
        ...mockJobData,
        region: undefined,
      };

      await handler.processExportJob(jobDataWithoutRegion, mockEnv);

      // Should try to get region from user
      const { DataRouter } = await import("../../src/lib/data-router.js");
      expect(DataRouter.getUser).toHaveBeenCalled();
    });

    it("should query posts with correct filters", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockDb.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            authorId: "user123",
            deletedAt: null,
          }),
        }),
      );
    });

    it("should query comments on others posts", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockDb.postComment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            authorId: "user123",
          }),
        }),
      );
    });

    it("should query reactions on others posts", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockDb.postSentiment.findMany).toHaveBeenCalled();
    });

    it("should query reactions on others comments", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockDb.commentSentiment.findMany).toHaveBeenCalled();
    });

    it("should format export data correctly", async () => {
      const mockPost = {
        id: "post1",
        text: "Test post",
        visibility: "public",
        dogRef: "dog123",
        geoData: { lat: 40.7128, lng: -74.006 },
        uri: "at://test",
        contentWarnings: ["cw1"],
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
        media: [
          {
            id: "media1",
            mediaId: "media-id-1",
            alt: "Test image",
            order: 0,
          },
        ],
        sentiments: [
          {
            id: "sentiment1",
            sentiment: "like",
            createdAt: new Date("2024-01-01"),
          },
        ],
        comments: [],
      };

      mockDb.post.findMany.mockResolvedValue([mockPost]);

      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockExportFilesR2.put).toHaveBeenCalled();
      const putCall = mockExportFilesR2.put.mock.calls[0];
      const exportedData = JSON.parse(putCall[1]);

      expect(exportedData.user.id).toBe("user123");
      expect(exportedData.posts).toHaveLength(1);
      expect(exportedData.posts[0].text).toBe("Test post");
      expect(exportedData.posts[0].media).toHaveLength(1);
    });

    it("should transform to AT Protocol format when requested", async () => {
      const atprotoJobData = {
        ...mockJobData,
        format: "atproto" as const,
      };

      mockDb.post.findMany.mockResolvedValue([
        {
          id: "post1",
          text: "Test post",
          visibility: "public",
          uri: "at://test",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-02"),
          media: [],
          sentiments: [],
          comments: [],
          contentWarnings: [],
        },
      ]);

      await handler.processExportJob(atprotoJobData, mockEnv);

      const putCall = mockExportFilesR2.put.mock.calls[0];
      const exportedData = JSON.parse(putCall[1]);

      expect(exportedData.format).toBe("atproto");
      expect(exportedData.posts[0]).toHaveProperty("$type");
    });

    it("should store file in R2 with correct metadata", async () => {
      await handler.processExportJob(mockJobData, mockEnv);

      expect(mockExportFilesR2.put).toHaveBeenCalledWith(
        expect.stringContaining("exports/user123/job123/"),
        expect.any(String),
        expect.objectContaining({
          httpMetadata: expect.objectContaining({
            contentType: "application/json",
          }),
          customMetadata: expect.objectContaining({
            userId: "user123",
            format: "json",
          }),
        }),
      );
    });

    it("should mark job as failed on error", async () => {
      mockDb.post.findMany.mockRejectedValue(
        new Error("Database connection failed"),
      );

      await expect(
        handler.processExportJob(mockJobData, mockEnv),
      ).rejects.toThrow("Database connection failed");

      expect(mockExportJobsKV.put).toHaveBeenCalledWith(
        "job:job123",
        expect.stringContaining('"status":"failed"'),
        expect.any(Object),
      );
    });

    it("should work without EXPORT_FILES_R2 (graceful degradation)", async () => {
      delete mockEnv.EXPORT_FILES_R2;

      await handler.processExportJob(mockJobData, mockEnv);

      // Should still complete, just without file storage
      expect(mockExportJobsKV.put).toHaveBeenCalledWith(
        "job:job123",
        expect.stringContaining('"status":"completed"'),
        expect.any(Object),
      );
    });
  });

  describe("getExportFile", () => {
    it("should return file for completed job", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "completed",
        createdAt: new Date().toISOString(),
        fileKey: "exports/user123/job123/export.json",
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const mockR2Object = {
        text: vi.fn().mockResolvedValue('{"user": {"id": "user123"}}'),
      };
      mockExportFilesR2.get.mockResolvedValue(mockR2Object);

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).not.toBeNull();
      expect(response?.headers.get("content-type")).toBe("application/json");
      expect(response?.headers.get("Content-Disposition")).toContain(
        "attachment",
      );
    });

    it("should return null if job not found", async () => {
      mockExportJobsKV.get.mockResolvedValue(null);

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });

    it("should return null if job not completed", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "processing",
        createdAt: new Date().toISOString(),
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });

    it("should return null if file key not set", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "completed",
        createdAt: new Date().toISOString(),
        // No fileKey
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });

    it("should return null if job belongs to different user", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "other-user",
        email: "other@example.com",
        format: "json",
        status: "completed",
        createdAt: new Date().toISOString(),
        fileKey: "exports/other-user/job123/export.json",
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });

    it("should return null if EXPORT_FILES_R2 not configured", async () => {
      delete mockEnv.EXPORT_FILES_R2;

      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "completed",
        createdAt: new Date().toISOString(),
        fileKey: "exports/user123/job123/export.json",
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });

    it("should return null if R2 object not found", async () => {
      const job: ExportJob = {
        jobId: "job123",
        userId: "user123",
        email: "test@example.com",
        format: "json",
        status: "completed",
        createdAt: new Date().toISOString(),
        fileKey: "exports/user123/job123/export.json",
      };

      mockExportJobsKV.get.mockResolvedValue(JSON.stringify(job));
      mockExportFilesR2.get.mockResolvedValue(null);

      const response = await handler.getExportFile(
        "job123",
        "user123",
        mockEnv,
      );

      expect(response).toBeNull();
    });
  });

  describe("processExportJob — extension-owned data (O-1 / GDPR Art.15/20)", () => {
    const jobData = {
      jobId: "job123",
      userId: "user123",
      email: "test@example.com",
      format: "json" as const,
      region: "US",
    };

    afterEach(() => {
      __resetExtensionModelRegistryForTest();
      delete (mockDb as any).ext_dog__private;
      delete (mockDb as any).ext_cascade_only;
    });

    it("includes ext_* rows where the user is the erasure subject", async () => {
      setExtensionModelRegistry([
        {
          model: "ext_dog__private",
          tenantField: "tenantId",
          erasureSubjectField: "createdByUserId",
          fkFields: [],
        },
      ]);
      const row = { entityId: "e1", createdByUserId: "user123", microchip: "982000123456789" };
      (mockDb as any).ext_dog__private = {
        findMany: vi.fn().mockResolvedValue([row]),
      };

      await handler.processExportJob(jobData, mockEnv);

      expect((mockDb as any).ext_dog__private.findMany).toHaveBeenCalledWith({
        where: { createdByUserId: "user123" },
      });
      const body = JSON.parse(mockExportFilesR2.put.mock.calls[0][1]);
      expect(body.extensionData.ext_dog__private).toEqual([row]);
    });

    it("skips a cascade-only model (null erasureSubjectField) and omits extensionData when empty", async () => {
      setExtensionModelRegistry([
        {
          model: "ext_cascade_only",
          tenantField: "tenantId",
          erasureSubjectField: null,
          fkFields: [],
        },
      ]);
      (mockDb as any).ext_cascade_only = { findMany: vi.fn() };

      await handler.processExportJob(jobData, mockEnv);

      expect((mockDb as any).ext_cascade_only.findMany).not.toHaveBeenCalled();
      const body = JSON.parse(mockExportFilesR2.put.mock.calls[0][1]);
      expect(body.extensionData).toBeUndefined();
    });
  });
});
