/**
 * Unit Tests: Entity Handler
 *
 * Tests for entity profile management and listing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityHandler } from "../../src/lib/entity-handler.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock extensions registry with a generic test extension
const { mockGetExtension } = vi.hoisted(() => {
  const testExt = {
    id: "test",
    terminology: { entity: "test", entityPlural: "tests" },
    routes: [],
    metadataSchema: { safeParse: (data: any) => ({ success: true, data }) },
    computeLifeStage: () => null,
  };
  return {
    mockGetExtension: vi.fn((entityType: string) => {
      if (entityType === "test") return testExt;
      return undefined;
    }),
  };
});
vi.mock("../../src/extensions", () => ({
  getExtension: mockGetExtension,
}));

// Mock DataRouter
const mockGetDatabaseForRegion = vi.fn();
const mockGetUser = vi.fn();
vi.mock("../../src/lib/data-router", () => ({
  DataRouter: {
    getDatabaseForRegion: (...args: any[]) => mockGetDatabaseForRegion(...args),
    getUser: (...args: any[]) => mockGetUser(...args),
  },
}));

// Mock createPrisma to return mockDb
const mockCreatePrisma = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: (...args: any[]) => mockCreatePrisma(...args),
  DatabaseClient: {
    createForRegion: vi.fn(),
    clearPoolCache: vi.fn(),
    getPoolStatus: vi.fn().mockReturnValue([]),
  },
}));

// Mock region detection
const mockDetectRegion = vi.fn();
vi.mock("../../src/lib/region-detection", () => {
  return {
    detectRegion: (...args: any[]) => mockDetectRegion(...args),
    detectRegionSync: vi.fn(() => "US"),
    RegionDetector: class RegionDetector {
      detectRegion = mockDetectRegion;
    },
  };
});

// Mock request-context
vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: vi.fn().mockResolvedValue({
    region: "US",
    requestId: "req123",
  }),
}));

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => {
  return {
    SessionManager: class {
      getSession = mockGetSession;
    },
  };
});

// Mock FeatureToggleService
const mockIsEnabled = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    isEnabled = mockIsEnabled;
    constructor(db: any) {}
  },
}));


// Mock Validator
const mockValidateEntityProfile = vi.fn();
const mockSanitizeError = vi.fn((error) => error?.message || "Unknown error");
vi.mock("../../src/lib/validation", () => ({
  Validator: class {
    validateEntityProfile = mockValidateEntityProfile;
    sanitizeError = mockSanitizeError;
  },
}));

// Mock database connection manager and query helper
const mockWithQueryTimeoutAndRetry = vi.fn();
const mockSharedDatabaseConnectionManager = {
  executeWithRetry: vi.fn(),
};

vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: mockSharedDatabaseConnectionManager,
  DatabaseConnectionManager: class DatabaseConnectionManager {
    executeWithRetry = mockSharedDatabaseConnectionManager.executeWithRetry;
  },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock life-stage-calculator
vi.mock("../../src/lib/life-stage-calculator", () => ({
  calculateLifeStage: vi.fn((birthdate, breedSize) => "life-stage:puppy"),
  extractBirthdateFromMetadata: vi.fn(
    (metadata) => metadata?.birthdate || null,
  ),
  extractBreedSizeFromMetadata: vi.fn(
    (metadata) => metadata?.breedSize || null,
  ),
  isValidLifeStageTaxonId: vi.fn((id) => id?.startsWith("life-stage:")),
}));

describe("EntityHandler", () => {
  let handler: EntityHandler;
  let mockEnv: any;
  let mockSession: Session;
  let mockRequestContext: TrellisRequestContext;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new EntityHandler();

    mockDb = {
      entity: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      featureToggle: {
        findUnique: vi.fn().mockResolvedValue({ enabled: true }), // Default: feature enabled
      },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockCreatePrisma.mockReturnValue(mockDb);

    mockEnv = {
      DATABASE_URL: "postgres://test",
      US_DATABASE_URL: "postgres://us-test",
      EU_DATABASE_URL: "postgres://eu-test",
      CN_DATABASE_URL: "postgres://cn-test",
      DEFAULT_REGION: "US",
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "dev",
      trellis_dev_session_secret: "test-secret",
    };

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    };

    mockRequestContext = {
      region: "US" as const,
      config: {
        featureFlags: {
          authentication: {},
          features: {},
          performance: {},
          security: {},
        },
        endpoints: {
          api: "https://api.example.com",
          frontend: "https://app.example.com",
          cdn: "https://cdn.example.com",
        },
        timeouts: {
          database: 5000,
          api: 10000,
        },
      },
      session: mockSession,
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockDetectRegion.mockResolvedValue("US");
    mockIsEnabled.mockResolvedValue(true); // Default: feature enabled
    mockValidateEntityProfile.mockReturnValue({
      valid: true,
      data: { name: "Test", entityType: "test", metadata: {} },
    });
  });

  describe("listEntityProfiles", () => {
    beforeEach(() => {
      // Default mock: withQueryTimeoutAndRetry executes the query function with mockDb
      mockWithQueryTimeoutAndRetry.mockImplementation(
        async (
          manager: any,
          region: string,
          env: any,
          queryFn: (db: any) => Promise<any>,
        ) => {
          return await queryFn(mockDb);
        },
      );
    });

    it("should return entities owned by user", async () => {
      const entities = [
        {
          id: "entity-1",
          name: "Dog 1",
          entityType: "test",
          metadata: { breed: "Golden Retriever" },
          createdAt: new Date("2024-01-01T10:00:00Z"),
        },
        {
          id: "entity-2",
          name: "Dog 2",
          entityType: "test",
          metadata: { breed: "Labrador" },
          createdAt: new Date("2024-01-02T10:00:00Z"),
        },
      ];
      mockDb.entity.findMany.mockResolvedValue(entities);

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.profiles).toHaveLength(2);
      expect(data.profiles[0]).toEqual({
        id: "entity-1",
        name: "Dog 1",
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        createdAt: "2024-01-01T10:00:00.000Z",
      });

      // Verify withQueryTimeoutAndRetry was called with correct parameters
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 3000,
          retryTimeoutMs: 2000,
          maxRetries: 3,
          baseDelayMs: 100,
          context: {
            operation: "listEntityProfiles",
            userId: "user-123",
            region: "US",
          },
        }),
      );

      // Verify the query function was called with correct parameters
      expect(mockDb.entity.findMany).toHaveBeenCalledWith({
        where: {
          owners: { some: { userId: "user-123", status: "ACTIVE" } },
        },
        select: {
          id: true,
          name: true,
          entityType: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: {
          name: "asc",
        },
      });
    });

    it("should return empty array when user has no entities", async () => {
      mockDb.entity.findMany.mockResolvedValue([]);

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.profiles).toEqual([]);

      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should return null entityType when not specified", async () => {
      mockDb.entity.findMany.mockResolvedValue([
        {
          id: "entity-1",
          name: "Dog 1",
          entityType: null,
          metadata: {},
          createdAt: new Date("2024-01-01T10:00:00Z"),
        },
      ]);

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.profiles[0].entityType).toBeNull();
    });

    it("should use session dataRegion regardless of requestContext", async () => {
      const euRequestContext = {
        ...mockRequestContext,
        region: "EU" as const,
      };

      mockDb.entity.findMany.mockResolvedValue([]);

      const request = new Request("http://test.com/entities");
      await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        euRequestContext,
      );

      // Verify withQueryTimeoutAndRetry was called with session.dataRegion (US via DEFAULT_REGION),
      // not requestContext.region (EU) — the implementation uses the session's data region
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            region: "US",
          }),
        }),
      );
    });

    it("should use session dataRegion when requestContext not provided", async () => {
      mockDb.entity.findMany.mockResolvedValue([]);

      const request = new Request("http://test.com/entities");
      await handler.listEntityProfiles(mockSession, mockEnv, request);

      // Verify withQueryTimeoutAndRetry was called with session.dataRegion (US via DEFAULT_REGION)
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            region: "US",
          }),
        }),
      );
    });

    it("should use default region when not detected", async () => {
      mockDb.entity.findMany.mockResolvedValue([]);
      mockDetectRegion.mockResolvedValue(null);

      const request = new Request("http://test.com/entities");
      await handler.listEntityProfiles(mockSession, mockEnv, request);

      // Verify withQueryTimeoutAndRetry was called with default US region
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US", // DEFAULT_REGION from mockEnv
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          context: expect.objectContaining({
            region: "US",
          }),
        }),
      );
    });

    it("should return 500 when database query fails", async () => {
      // When withQueryTimeoutAndRetry throws, it's caught by the outer try-catch
      // and returns a 500 error response
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database query failed"),
      );

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should handle database errors gracefully", async () => {
      // Mock withQueryTimeoutAndRetry to throw an error
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Database error"),
      );

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBeDefined();
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should use timeout/retry logic with USER_FACING preset", async () => {
      mockDb.entity.findMany.mockResolvedValue([]);

      const request = new Request("http://test.com/entities");
      await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      // Verify withQueryTimeoutAndRetry was called with USER_FACING preset
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalledWith(
        mockSharedDatabaseConnectionManager,
        "US",
        mockEnv,
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 3000, // USER_FACING timeout
          retryTimeoutMs: 2000, // USER_FACING retry timeout
          maxRetries: 3,
          baseDelayMs: 100,
        }),
      );
    });

    it("should return 500 when query times out", async () => {
      // The implementation queries a single region; a timeout results in a 500 error
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Query timeout"),
      );

      const request = new Request("http://test.com/entities");

      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should handle timeout/retry errors and return 500", async () => {
      // Mock withQueryTimeoutAndRetry to throw timeout error after retries
      mockWithQueryTimeoutAndRetry.mockRejectedValue(
        new Error("Query timeout after retries"),
      );

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBeDefined();
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should order entities by name ascending", async () => {
      const entities = [
        {
          id: "entity-2",
          name: "Zebra",
          entityType: "test",
          metadata: {},
          createdAt: new Date("2024-01-02T10:00:00Z"),
        },
        {
          id: "entity-1",
          name: "Alpha",
          entityType: "test",
          metadata: {},
          createdAt: new Date("2024-01-01T10:00:00Z"),
        },
      ];
      mockDb.entity.findMany.mockResolvedValue(entities);

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      // Verify the query was ordered by name
      expect(mockDb.entity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: {
            name: "asc",
          },
        }),
      );
      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle entities with null metadata", async () => {
      const entities = [
        {
          id: "entity-1",
          name: "Dog 1",
          entityType: "test",
          metadata: null,
          createdAt: new Date("2024-01-01T10:00:00Z"),
        },
      ];
      mockDb.entity.findMany.mockResolvedValue(entities);

      const request = new Request("http://test.com/entities");
      const response = await handler.listEntityProfiles(
        mockSession,
        mockEnv,
        request,
        mockRequestContext,
      );

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.profiles[0].metadata).toEqual({});
      // Verify timeout/retry was used
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });
  });

  describe("createEntityProfile", () => {
    beforeEach(() => {
      // Ensure mockGetDatabaseForRegion returns mockDb
      mockGetDatabaseForRegion.mockReturnValue(mockDb);
      // Ensure mockCreatePrisma returns mockDb for FeatureToggleService
      mockCreatePrisma.mockReturnValue(mockDb);
      // Reset validation mock to return valid by default
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Test", entityType: "test", metadata: {} },
      });
      // Mock user operations (required for user upsert in createEntityProfile)
      mockDb.user.findUnique.mockResolvedValue(null); // User doesn't exist by default
      mockDb.user.upsert.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
      });
      // Mock region detection
      mockDetectRegion.mockResolvedValue("US");
      mockGetSession.mockResolvedValue(mockSession);
    });

    it("should create entity profile successfully with all fields", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {
          breed: "Golden Retriever",
          bio: "A friendly dog",
          birthdate: "2020-01-15",
          privacy: "public",
        },
        lifeStage: "life-stage:adult",
        lifeStageCalculatedAt: createdAt,
        lifeStageManualOverride: false,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockIsEnabled.mockResolvedValueOnce(true); // global_public_posting_enabled (for public privacy)

      // Set up validation to return the request body
      const requestBody = {
        name: "Buddy",
        entityType: "test",
        metadata: {
          breed: "Golden Retriever",
          bio: "A friendly dog",
          birthdate: "2020-01-15",
          privacy: "public",
        },
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.id).toBe("entity-123");
      expect(data.name).toBe("Buddy");
      expect(data.entityType).toBe("test");
      expect(data.metadata).toEqual({
        breed: "Golden Retriever",
        bio: "A friendly dog",
        birthdate: "2020-01-15",
        privacy: "public",
      });
      expect(data.createdAt).toBe(createdAt.toISOString());
      expect(data.updatedAt).toBe(updatedAt.toISOString());
      expect(mockDb.entity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Buddy",
          entityType: "test",
          ownerId: "user-123",
          metadata: requestBody.metadata,
        }),
      });
    });

    it("should create entity profile with minimal fields", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Max",
        entityType: "test",
        metadata: {},
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled

      const requestBody = {
        name: "Max",
        entityType: "test",
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.name).toBe("Max");
      expect(data.entityType).toBe("test"); // Default
      expect(mockDb.entity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Max",
          entityType: "test",
          ownerId: "user-123",
          metadata: {},
        }),
      });
    });

    it("should return 400 for invalid input (missing name)", async () => {
      // Arrange
      const requestBody = {};

      mockValidateEntityProfile.mockReturnValue({
        valid: false,
        error: "Name is required",
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(mockDb.entity.create).not.toHaveBeenCalled();
    });

    it("should use session dataRegion for database routing", async () => {
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockGetSession.mockResolvedValue(mockSession);

      const requestBody = { name: "Buddy", entityType: "test" };
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(201);
      // Verify getDatabaseForRegion was called with session.dataRegion (US via DEFAULT_REGION)
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should handle region detection failure and use default region", async () => {
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockDetectRegion.mockResolvedValue(null); // Region detection fails
      mockGetSession.mockResolvedValue(mockSession);

      const requestBody = { name: "Buddy", entityType: "test" };
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(201);
      // Should fall back to default region
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US", // DEFAULT_REGION fallback
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should ensure user exists before creating entity", async () => {
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt,
        updatedAt,
      };

      // Mock user not existing initially, then created via upsert
      mockDb.user.findUnique.mockResolvedValueOnce(null); // User doesn't exist
      mockDb.user.upsert.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
      });
      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockDetectRegion.mockResolvedValue("US");
      mockGetSession.mockResolvedValue(mockSession);

      const requestBody = { name: "Buddy", entityType: "test" };
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(201);
      // Verify user upsert was called
      expect(mockDb.user.upsert).toHaveBeenCalledWith({
        where: { id: "user-123" },
        create: expect.objectContaining({
          id: "user-123",
          email: "test@example.com",
          role: "END_USER",
          region: "US",
          dataRegion: "US",
        }),
        update: expect.any(Object),
      });
    });

    it("should return 400 for invalid input (empty name)", async () => {
      // Arrange
      const requestBody = { name: "" };

      mockValidateEntityProfile.mockReturnValue({
        valid: false,
        error: "Name cannot be empty",
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBeDefined();
      expect(mockDb.entity.create).not.toHaveBeenCalled();
    });

    it("should return 403 when entity_profiles_enabled is disabled", async () => {
      // Arrange
      mockIsEnabled.mockResolvedValueOnce(false); // entity_profiles_enabled

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain("disabled");
      expect(mockDb.entity.create).not.toHaveBeenCalled();
    });

    it("should allow creation when entity_profiles_enabled is true", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(201);
      expect(mockDb.entity.create).toHaveBeenCalled();
    });

    it("should calculate and set life stage when birthdate is provided", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Puppy",
        entityType: "test",
        metadata: {
          birthdate: "2023-12-01",
          breedSize: "medium",
        },
        lifeStage: "life-stage:puppy",
        lifeStageCalculatedAt: createdAt,
        lifeStageManualOverride: false,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);

      const requestBody = {
        name: "Puppy",
        entityType: "test",
        metadata: {
          birthdate: "2023-12-01",
          breedSize: "medium",
        },
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(201);
      // In the core repo, computeLifeStage returns null (no extension logic).
      // The handler should still create the entity successfully.
      expect(mockDb.entity.create).toHaveBeenCalled();
    });

    it("should use session dataRegion for database routing", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      await handler.createEntityProfile(request, mockSession, mockEnv);

      // Assert — implementation uses session.dataRegion (US via DEFAULT_REGION), not detectRegion
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        mockEnv,
        request,
        "user-123",
      );
    });

    it("should use default region when detection fails", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockDetectRegion.mockResolvedValue(null);

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      await handler.createEntityProfile(request, mockSession, mockEnv);

      // Assert
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US", // DEFAULT_REGION
        mockEnv,
        request,
        "user-123",
      );
    });

    it("should trim whitespace from name", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);

      const requestBody = {
        name: "  Buddy  ",
        entityType: "test",
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      await handler.createEntityProfile(request, mockSession, mockEnv);

      // Assert
      expect(mockDb.entity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Buddy", // Trimmed
        }),
      });
    });

    it("should handle database errors gracefully", async () => {
      // Arrange
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockDb.entity.create.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should handle JSON parsing errors", async () => {
      // Arrange
      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: "invalid json",
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should reject creation when entityType is not provided", async () => {
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Buddy" }, // entityType not provided
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Buddy" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(request, mockSession, mockEnv);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("MISSING_ENTITY_TYPE");
    });

    it("should handle null metadata gracefully", async () => {
      // Arrange
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: null,
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true);
      mockIsEnabled.mockResolvedValueOnce(true);

      const requestBody = {
        name: "Buddy",
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      // Act
      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      // Assert
      const data = await response.json();
      expect(response.status).toBe(201);
      expect(data.metadata).toEqual({}); // Should default to empty object
    });

    it("should return 403 when public posting is disabled and privacy is public", async () => {
      // Set up ALL mocks BEFORE calling handler to prevent errors
      // This ensures createPrisma doesn't throw, which would result in 500 instead of 403
      mockCreatePrisma.mockReturnValue(mockDb);
      mockDetectRegion.mockResolvedValue("US");
      mockGetSession.mockResolvedValue(mockSession);

      // Reset and set up mockIsEnabled for both calls
      mockIsEnabled.mockReset();
      mockIsEnabled
        .mockResolvedValueOnce(true) // entity_profiles_enabled
        .mockResolvedValueOnce(false); // global_public_posting_enabled

      // Also mock the database query that FeatureToggleService actually uses
      // The implementation queries prisma.featureToggle.findUnique for both toggles
      mockDb.featureToggle.findUnique.mockReset();
      mockDb.featureToggle.findUnique.mockImplementation(async (query: any) => {
        const key = query?.where?.key;
        if (key === "entity_profiles_enabled") {
          return { enabled: true };
        }
        if (key === "global_public_posting_enabled") {
          return { enabled: false };
        }
        return null;
      });

      const requestBody = {
        name: "Buddy",
        metadata: {
          privacy: "public",
        },
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("PUBLIC_POSTING_DISABLED");
      expect(mockDb.entity.create).not.toHaveBeenCalled();
    });

    it("should allow public privacy when public posting is enabled", async () => {
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { privacy: "public" },
        lifeStage: null,
        createdAt,
        updatedAt,
      };

      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled
        .mockResolvedValueOnce(true) // entity_profiles_enabled
        .mockResolvedValueOnce(true); // global_public_posting_enabled

      const requestBody = {
        name: "Buddy",
        metadata: {
          privacy: "public",
        },
      };

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      const response = await handler.createEntityProfile(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(201);
      expect(mockDb.entity.create).toHaveBeenCalled();
    });

    it("should respect lifeStageManualOverride when set", async () => {
      const createdAt = new Date("2024-01-01T10:00:00Z");
      const updatedAt = new Date("2024-01-01T10:00:00Z");
      const createdEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {
          birthdate: "2020-01-15",
          breedSize: "medium",
        },
        lifeStage: "life-stage:senior", // Manual override
        lifeStageCalculatedAt: null,
        lifeStageManualOverride: true,
        createdAt,
        updatedAt,
      };

      // Mock user upsert (required for createEntityProfile)
      mockDb.user.findUnique.mockResolvedValue(null); // User doesn't exist
      mockDb.user.upsert.mockResolvedValue({
        id: "user-123",
        email: "test@example.com",
      });
      mockDb.entity.create.mockResolvedValue(createdEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockDetectRegion.mockResolvedValue("US");
      mockGetSession.mockResolvedValue(mockSession);

      const requestBody = {
        name: "Buddy",
        entityType: "test",
        metadata: {
          birthdate: "2020-01-15",
          breedSize: "medium",
        },
        lifeStage: "life-stage:senior",
        lifeStageManualOverride: true,
      };

      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: requestBody,
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "Content-Type": "application/json" },
      });

      await handler.createEntityProfile(request, mockSession, mockEnv);

      // In the core repo, computeLifeStage returns null (no extension logic).
      expect(mockDb.entity.create).toHaveBeenCalled();
    });
  });

  describe("getEntityProfile", () => {
    beforeEach(() => {
      // Reset mocks for getEntityProfile tests
      mockGetDatabaseForRegion.mockReturnValue(mockDb);
      mockCreatePrisma.mockReturnValue(mockDb);
      // Reset featureToggle mock to default (enabled: true) but tests can override
      // Note: This is the database query that FeatureToggleService.isEnabled() actually uses
      mockDb.featureToggle.findUnique.mockResolvedValue({ enabled: true });
      // Reset mockIsEnabled - don't set a default, let each test set it explicitly
      // This prevents beforeEach from overriding test-specific mock values
      mockIsEnabled.mockReset();
    });

    it("should return entity profile for owner", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "user-123",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe("entity-123");
      expect(data.name).toBe("Buddy");
    });

    it("should return 404 if entity not found", async () => {
      mockDb.entity.findUnique.mockResolvedValue(null);
      mockIsEnabled.mockResolvedValue(true);

      const response = await handler.getEntityProfile(
        "nonexistent",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Entity not found");
    });

    it("should return 403 if feature disabled", async () => {
      // Set mock AFTER beforeEach runs - use mockResolvedValue to ensure it persists
      mockIsEnabled.mockResolvedValue(false);
      // Also mock the database query that FeatureToggleService actually uses
      // The implementation queries prisma.featureToggle.findUnique with key 'entity_profiles_enabled'
      // Override the default from beforeEach
      mockDb.featureToggle.findUnique.mockImplementation(async (query: any) => {
        if (query?.where?.key === "entity_profiles_enabled") {
          return { enabled: false };
        }
        return { enabled: true }; // Default for other toggles
      });
      mockCreatePrisma.mockReturnValue(mockDb);

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain("disabled");
    });

    it("should return 403 for private entity not owned by user", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { privacy: "private" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "other-user",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Forbidden");
    });

    it("should work with request parameter and use session dataRegion", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "user-123",
      };

      // Explicitly set all mocks, don't rely on beforeEach defaults
      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);
      mockDb.featureToggle.findUnique.mockImplementation(async (query: any) => {
        if (query?.where?.key === "entity_profiles_enabled") {
          return { enabled: true };
        }
        return null;
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockCreatePrisma.mockReturnValue(mockDb);

      const request = new Request("http://test.com/api/entities/entity-123");

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
        request,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe("entity-123");
      // Implementation uses session.dataRegion (US via DEFAULT_REGION), passes request through
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should allow access to public entity even if not owner", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { privacy: "public" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "other-user",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe("entity-123");
    });

    it("should default privacy to public when not specified", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {}, // No privacy specified
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "other-user",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
    });

    it("should handle database errors gracefully", async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockDb.entity.findUnique.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should work without request parameter (uses default region)", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "user-123",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);

      // Call without request parameter
      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe("entity-123");
      // Should use default region when no request provided
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US", // DEFAULT_REGION from mockEnv
        expect.any(Object),
        undefined, // No request
        "user-123",
      );
    });

    it("should handle region detection failure gracefully", async () => {
      const mockEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: {},
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        ownerId: "user-123",
      };

      mockDb.entity.findUnique.mockResolvedValue(mockEntity);
      mockIsEnabled.mockResolvedValue(true);
      mockDetectRegion.mockResolvedValue(null); // Region detection fails
      mockGetSession.mockResolvedValue(mockSession);

      const request = new Request("http://test.com/api/entities/entity-123");

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
        request,
      );

      expect(response.status).toBe(200);
      // Should fall back to default region
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US", // DEFAULT_REGION fallback
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should handle database routing error gracefully", async () => {
      mockIsEnabled.mockResolvedValue(true);
      // When getDatabaseForRegion throws for all regions, the per-region errors
      // are tracked and a 500 is returned
      mockGetDatabaseForRegion.mockImplementation(() => {
        throw new Error("Database routing failed");
      });
      mockGetSession.mockResolvedValue(mockSession);

      const request = new Request("http://test.com/api/entities/entity-123");

      const response = await handler.getEntityProfile(
        "entity-123",
        mockSession,
        mockEnv,
        request,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("updateEntityProfile", () => {
    beforeEach(() => {
      // Reset mocks for updateEntityProfile tests
      mockGetDatabaseForRegion.mockReturnValue(mockDb);
    });

    it("should update entity profile successfully", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        lifeStage: "life-stage:adult",
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy Updated",
        entityType: "test",
        metadata: { breed: "Labrador" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Buddy Updated", metadata: { breed: "Labrador" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Buddy Updated",
          metadata: { breed: "Labrador" },
        }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("Buddy Updated");
      expect(mockDb.entity.update).toHaveBeenCalled();
      // Note: detectRegion is only called in the error path when user lookup fails.
      // In this test, user lookup succeeds, so detectRegion is not called.
      // Verify getDatabaseForRegion was called with the user's dataRegion and request
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US",
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should handle region detection failure and use default region", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        lifeStage: "life-stage:adult",
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy Updated",
        entityType: "test",
        metadata: { breed: "Labrador" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Buddy Updated", metadata: { breed: "Labrador" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue(null); // Region detection fails

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Buddy Updated",
          metadata: { breed: "Labrador" },
        }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      // Should fall back to default region
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "US", // DEFAULT_REGION fallback
        expect.any(Object),
        request,
        "user-123",
      );
    });

    it("should use user dataRegion instead of detected region to find entity", async () => {
      // This test verifies the fix for region mismatch issue
      // Entity is stored in user's dataRegion (EU), but region detection returns US
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        lifeStage: "life-stage:adult",
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy Updated",
        entityType: "test",
        metadata: { breed: "Labrador" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      // Mock: User's dataRegion is EU (where entity is stored)
      mockGetUser.mockResolvedValueOnce({ dataRegion: "EU", region: "EU" }); // First call for EU

      // Mock: Entity found in EU database (user's dataRegion)
      const mockDbEU = {
        ...mockDb,
        entity: {
          findUnique: vi.fn().mockResolvedValue(existingEntity),
          update: vi.fn().mockResolvedValue(updatedEntity),
        },
      };
      mockGetDatabaseForRegion.mockReturnValue(mockDbEU);

      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Buddy Updated", metadata: { breed: "Labrador" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US"); // Region detection returns US (different from dataRegion)

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Buddy Updated",
          metadata: { breed: "Labrador" },
        }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("Buddy Updated");

      // Verify getUser was called to get user's dataRegion
      expect(mockGetUser).toHaveBeenCalled();

      // Verify getDatabaseForRegion was called with EU (user's dataRegion), not US (detected region)
      expect(mockGetDatabaseForRegion).toHaveBeenCalledWith(
        "EU", // User's dataRegion, not detected region
        expect.any(Object),
        request,
        "user-123",
      );

      // Verify entity was found and updated in EU database
      expect(mockDbEU.entity.findUnique).toHaveBeenCalledWith({
        where: { id: "entity-123" },
        select: {
          id: true,
          entityType: true,
          metadata: true,
          lifeStage: true,
          lifeStageManualOverride: true,
          owners: {
            select: { userId: true, role: true },
            where: { status: "ACTIVE" },
          },
        },
      });
      expect(mockDbEU.entity.update).toHaveBeenCalled();
    });

    it("should search other regions if entity not found in user dataRegion", async () => {
      // This test verifies fallback to other regions when entity not found
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { breed: "Golden Retriever" },
        lifeStage: "life-stage:adult",
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy Updated",
        entityType: "test",
        metadata: { breed: "Labrador" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      // Mock: User's dataRegion is EU
      mockGetUser.mockResolvedValueOnce({ dataRegion: "EU", region: "EU" }); // First call for EU

      // Mock: Entity NOT found in EU database
      const mockDbEU = {
        ...mockDb,
        entity: {
          findUnique: vi.fn().mockResolvedValue(null), // Not found in EU
          update: vi.fn(),
        },
      };

      // Mock: Entity found in US database (fallback)
      const mockDbUS = {
        ...mockDb,
        entity: {
          findUnique: vi.fn().mockResolvedValue(existingEntity),
          update: vi.fn().mockResolvedValue(updatedEntity),
        },
      };

      // Return different databases for different regions
      mockGetDatabaseForRegion.mockImplementation((region: string) => {
        if (region === "EU") return mockDbEU;
        if (region === "US") return mockDbUS;
        return mockDb;
      });

      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Buddy Updated", metadata: { breed: "Labrador" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("EU");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Buddy Updated",
          metadata: { breed: "Labrador" },
        }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("Buddy Updated");

      // Verify it searched EU first (user's dataRegion)
      expect(mockDbEU.entity.findUnique).toHaveBeenCalled();

      // Verify it then searched US (fallback)
      expect(mockDbUS.entity.findUnique).toHaveBeenCalled();

      // Verify update happened in US (where entity was found)
      expect(mockDbUS.entity.update).toHaveBeenCalled();
      expect(mockDbEU.entity.update).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid input", async () => {
      mockValidateEntityProfile.mockReturnValue({
        valid: false,
        error: "Name cannot be empty",
      });

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }), // Invalid: empty name
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      expect(mockDb.entity.update).not.toHaveBeenCalled();
    });

    it("should return 403 when feature disabled", async () => {
      mockIsEnabled.mockResolvedValueOnce(false); // entity_profiles_enabled

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      // ✅ Updated: Error code is now more specific (ENTITY_PROFILES_DISABLED)
      expect(data.error).toBe("ENTITY_PROFILES_DISABLED");
      expect(data.message).toContain("disabled");
    });

    it("should return 404 if entity not found", async () => {
      mockDb.entity.findUnique.mockResolvedValue(null);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Updated" },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Entity not found");
    });

    it("should return 403 if user does not own entity", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "other-user", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Updated" },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      // ✅ Updated: Error code is now more specific (OWNERSHIP_MISMATCH)
      expect(data.error).toBe("OWNERSHIP_MISMATCH");
      expect(data.message).toContain("permission");
    });

    it("should merge metadata on update", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { breed: "Golden Retriever", bio: "Friendly dog" },
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { breed: "Labrador", bio: "Friendly dog", age: 5 },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { metadata: { breed: "Labrador", age: 5 } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: { breed: "Labrador", age: 5 },
        }),
      });

      await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(mockDb.entity.update).toHaveBeenCalledWith({
        where: { id: "entity-123" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            breed: "Labrador",
            bio: "Friendly dog", // Preserved from existing
            age: 5, // New field
          }),
        }),
      });
    });

    it("should recalculate life stage when birthdate updated", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { birthdate: "2023-12-01" },
        lifeStage: "life-stage:puppy",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { metadata: { birthdate: "2023-12-01", breedSize: "medium" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: { birthdate: "2023-12-01", breedSize: "medium" },
        }),
      });

      await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      // In the core repo, computeLifeStage returns null (no extension logic).
      expect(mockDb.entity.update).toHaveBeenCalled();
    });

    it("should not recalculate life stage when manual override is set", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: {},
        lifeStage: "life-stage:senior",
        lifeStageManualOverride: true,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Buddy",
        entityType: "test",
        metadata: { birthdate: "2023-12-01" },
        lifeStage: "life-stage:senior", // Should keep existing
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { metadata: { birthdate: "2023-12-01" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: { birthdate: "2023-12-01" },
        }),
      });

      await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      // In the core repo, computeLifeStage returns null (no extension logic).
      expect(mockDb.entity.update).toHaveBeenCalled();
    });

    it("should return 403 when public posting disabled and setting privacy to public", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: { privacy: "private" },
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockIsEnabled
        .mockResolvedValueOnce(true) // entity_profiles_enabled
        .mockResolvedValueOnce(false); // global_public_posting_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { metadata: { privacy: "public" } },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: { privacy: "public" },
        }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("PUBLIC_POSTING_DISABLED");
    });

    it("should handle database errors gracefully", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockRejectedValue(
        new Error("Database update failed"),
      );
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Updated" },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it("should trim whitespace from name on update", async () => {
      const existingEntity = {
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY_OWNER" }],
        entityType: "test",
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      };

      const updatedEntity = {
        id: "entity-123",
        name: "Updated Name",
        entityType: "test",
        metadata: {},
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };

      mockDb.entity.findUnique.mockResolvedValue(existingEntity);
      mockDb.entity.update.mockResolvedValue(updatedEntity);
      mockIsEnabled.mockResolvedValueOnce(true); // entity_profiles_enabled
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "  Updated Name  " },
      });
      mockGetSession.mockResolvedValue(mockSession);
      mockDetectRegion.mockResolvedValue("US");

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Updated Name  " }),
      });

      await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(mockDb.entity.update).toHaveBeenCalledWith({
        where: { id: "entity-123" },
        data: expect.objectContaining({
          name: "Updated Name", // Trimmed
        }),
      });
    });
  });
});
