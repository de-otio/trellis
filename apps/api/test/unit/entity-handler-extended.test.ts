/**
 * Extended Unit Tests: Entity Handler
 *
 * Tests uncovered code paths: deleteEntityProfile, getEntityProfile edge cases
 * (cross-region search, private entity access, database errors),
 * updateEntityProfile region search fallback, and life stage calculation branches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntityHandler } from "../../src/lib/entity-handler.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock extensions registry
vi.mock("../../src/extensions", () => ({
  extensions: [],
  getExtension: vi.fn((entityType: string) => {
    if (entityType === "dog") {
      return {
        id: "dog",
        terminology: { entity: "dog", entityPlural: "dogs" },
        routes: [],
        metadataSchema: { safeParse: (data: any) => ({ success: true, data }) },
      };
    }
    return undefined;
  }),
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

// Mock createPrisma
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
vi.mock("../../src/lib/region-detection", () => ({
  detectRegion: (...args: any[]) => mockDetectRegion(...args),
  detectRegionSync: vi.fn(() => "US"),
  RegionDetector: class { detectRegion = mockDetectRegion; },
}));

// Mock request-context
vi.mock("../../src/lib/request-context", () => ({
  createRequestContext: vi.fn().mockResolvedValue({ region: "US", requestId: "req123" }),
}));

// Mock SessionManager
const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class { getSession = mockGetSession; },
}));

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
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: { executeWithRetry: vi.fn() },
  DatabaseConnectionManager: class { executeWithRetry = vi.fn(); },
}));

vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) => mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
    BACKGROUND: { timeoutMs: 12000, retryTimeoutMs: 5000 },
    CRITICAL: { timeoutMs: 5000, retryTimeoutMs: 3000 },
    STANDARD: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock life-stage-calculator
vi.mock("../../src/lib/life-stage-calculator", () => ({
  calculateLifeStage: vi.fn(() => "life-stage:puppy"),
  extractBirthdateFromMetadata: vi.fn((metadata) => metadata?.birthdate || null),
  extractBreedSizeFromMetadata: vi.fn((metadata) => metadata?.breedSize || null),
  isValidLifeStageTaxonId: vi.fn((id) => id?.startsWith("life-stage:")),
}));

describe("EntityHandler - Extended", () => {
  let handler: EntityHandler;
  let mockEnv: any;
  let mockSession: Session;
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
        delete: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
      },
    };

    mockGetDatabaseForRegion.mockReturnValue(mockDb);
    mockCreatePrisma.mockReturnValue(mockDb);

    mockEnv = {
      DATABASE_URL: "postgres://test",
      DEFAULT_REGION: "US",
      ENVIRONMENT: "dev",
    };

    mockSession = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: Date.now() + 3600000,
    } as any;

    mockIsEnabled.mockResolvedValue(true);
    mockValidateEntityProfile.mockReturnValue({
      valid: true,
      data: { name: "Test Dog", entityType: "dog", metadata: {} },
    });
  });

  describe("deleteEntityProfile", () => {
    it("should delete entity profile successfully", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Buddy",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockDb.entity.delete.mockResolvedValue({ id: "entity-123" });

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe("Entity deleted successfully");
    });

    it("should return 404 when entity not found in any region", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue(null);

      const response = await handler.deleteEntityProfile("nonexistent", mockSession, mockEnv);

      expect(response.status).toBe(404);
    });

    it("should return 403 when user does not own the entity", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Buddy",
        owners: [{ userId: "other-user", role: "PRIMARY" }],
      });

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should return 403 when feature is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should handle database error during deletion gracefully", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Buddy",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockDb.entity.delete.mockRejectedValue(new Error("DB error"));

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(500);
    });

    it("should search other regions when user dataRegion lookup fails", async () => {
      mockGetUser.mockRejectedValue(new Error("User lookup failed"));
      // Entity found in EU after US fails
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Buddy",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockDb.entity.delete.mockResolvedValue({ id: "entity-123" });

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should handle user having region but no dataRegion", async () => {
      mockGetUser.mockResolvedValue({ region: "EU", dataRegion: undefined });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Buddy",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
      });
      mockDb.entity.delete.mockResolvedValue({ id: "entity-123" });

      const response = await handler.deleteEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(200);
    });
  });

  describe("getEntityProfile - cross-region search", () => {
    it("should find entity in different region than user dataRegion", async () => {
      const mockDbEU = {
        entity: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      const mockDbUS = {
        entity: {
          findUnique: vi.fn().mockResolvedValue({
            id: "entity-123",
            name: "Buddy",
            entityType: "dog",
            metadata: {},
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            owners: [{ userId: "user-123", role: "PRIMARY" }],
          }),
        },
      };

      // First call returns EU db (user region), second returns US db
      let callCount = 0;
      mockGetDatabaseForRegion.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockDbEU : mockDbUS;
      });

      const sessionWithEU = { ...mockSession, dataRegion: "EU" } as any;
      const response = await handler.getEntityProfile(
        "entity-123",
        sessionWithEU,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.name).toBe("Buddy");
    });

    it("should return 500 when all region searches fail with db errors", async () => {
      mockDb.entity.findUnique.mockRejectedValue(new Error("DB connection failed"));

      const response = await handler.getEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe("Database error retrieving entity");
    });

    it("should return 403 for private entity not owned by user", async () => {
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Secret Dog",
        entityType: "dog",
        metadata: { privacy: "private" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        owners: [{ userId: "other-user", role: "PRIMARY" }],
      });

      const response = await handler.getEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(403);
    });

    it("should allow access to public entity not owned by user", async () => {
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        name: "Public Dog",
        entityType: "dog",
        metadata: { privacy: "public" },
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        owners: [{ userId: "other-user", role: "PRIMARY" }],
      });

      const response = await handler.getEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(200);
    });

    it("should return 403 when feature is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);

      const response = await handler.getEntityProfile("entity-123", mockSession, mockEnv);

      expect(response.status).toBe(403);
    });
  });

  describe("updateEntityProfile - cross-region search and fallback", () => {
    it("should find entity in different region and update", async () => {
      // User found in EU
      mockGetUser.mockResolvedValue({ dataRegion: "EU" });

      const mockDbEU = {
        entity: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
      };
      const mockDbUS = {
        entity: {
          findUnique: vi.fn().mockResolvedValue({
            id: "entity-123",
            owners: [{ userId: "user-123", role: "PRIMARY" }],
            metadata: { breed: "Golden" },
            lifeStage: null,
            lifeStageManualOverride: false,
          }),
          update: vi.fn().mockResolvedValue({
            id: "entity-123",
            name: "Updated Dog",
            entityType: "dog",
            metadata: { breed: "Golden" },
            lifeStage: null,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date(),
          }),
        },
      };

      let callCount = 0;
      mockGetDatabaseForRegion.mockImplementation(() => {
        callCount++;
        // EU search, US search, then US for update
        if (callCount <= 1) return mockDbEU;
        return mockDbUS;
      });

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated Dog", metadata: { breed: "Golden" } }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
    });

    it("should return 404 when entity not found in any region during update", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue(null);

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated", metadata: {} }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
    });

    it("should return 403 when user does not own entity during update", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "other-user", role: "PRIMARY" }],
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      });

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated", metadata: {} }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("OWNERSHIP_MISMATCH");
    });

    it("should return 400 for invalid input during update", async () => {
      mockValidateEntityProfile.mockReturnValue({ valid: false, error: "Name is required" });

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({}),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
    });

    it("should return 403 when public posting is disabled and privacy is public", async () => {
      mockGetUser.mockResolvedValue({ dataRegion: "US" });
      mockDb.entity.findUnique.mockResolvedValue({
        id: "entity-123",
        owners: [{ userId: "user-123", role: "PRIMARY" }],
        metadata: {},
        lifeStage: null,
        lifeStageManualOverride: false,
      });
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Dog", entityType: "dog", metadata: { privacy: "public" } },
      });
      // First call: entity_profiles_enabled = true
      // Second call: global_public_posting_enabled = false
      mockIsEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({ name: "Dog", metadata: { privacy: "public" } }),
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

    it("should return 403 when feature is disabled during update", async () => {
      mockIsEnabled.mockResolvedValue(false);

      const request = new Request("http://test.com/entities/entity-123", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated", metadata: {} }),
      });

      const response = await handler.updateEntityProfile(
        "entity-123",
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("ENTITY_PROFILES_DISABLED");
    });
  });

  describe("createEntityProfile - user upsert failure", () => {
    it("should return 500 when user upsert fails", async () => {
      mockDb.user.upsert.mockRejectedValue(new Error("Unique constraint violation"));

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Dog", metadata: {} }),
      });

      const response = await handler.createEntityProfile(request, mockSession, mockEnv);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toContain("Failed to verify user account");
    });

    it("should use fallback email when session email is missing", async () => {
      const sessionNoEmail = { ...mockSession, email: "" } as any;
      mockDb.user.upsert.mockResolvedValue({ id: "user-123", email: "user-user-123@unknown.local" });
      mockDb.entity.create.mockResolvedValue({
        id: "entity-123",
        name: "Test Dog",
        entityType: "dog",
        metadata: {},
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      });

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Test Dog", entityType: "dog", metadata: {} }),
      });

      const response = await handler.createEntityProfile(request, sessionNoEmail, mockEnv);

      expect(response.status).toBe(201);
    });

    it("should return 403 when public posting disabled and privacy is public on create", async () => {
      mockValidateEntityProfile.mockReturnValue({
        valid: true,
        data: { name: "Dog", entityType: "dog", metadata: { privacy: "public" } },
      });
      // First call: entity_profiles_enabled = true
      // Second call: global_public_posting_enabled = false
      mockIsEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const request = new Request("http://test.com/entities", {
        method: "POST",
        body: JSON.stringify({ name: "Dog", metadata: { privacy: "public" } }),
      });

      const response = await handler.createEntityProfile(request, mockSession, mockEnv);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("PUBLIC_POSTING_DISABLED");
    });
  });

  describe("listEntityProfiles - feature disabled", () => {
    it("should return 200 with empty profiles when feature is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);

      const response = await handler.listEntityProfiles(mockSession, mockEnv);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.profiles).toEqual([]);
      expect(data.error).toContain("disabled");
    });
  });
});
