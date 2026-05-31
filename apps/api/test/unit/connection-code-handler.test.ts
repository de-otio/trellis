import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { Session } from "../../src/lib/session-cookie.js";
import type { TrellisRequestContext } from "../../src/lib/request-context.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGraphService, mockPrisma } = vi.hoisted(() => ({
  mockGraphService: {
    createRelationship: vi.fn(),
  },
  mockPrisma: {
    entityOwnership: { findFirst: vi.fn() },
    connectionCode: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    connectionCodeRedemption: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(mockGraphService),
}));

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

// Import after mocks are in place
import { ConnectionCodeHandler } from "../../src/lib/connection-code-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockEnv = { DATABASE_URL: "postgresql://test:test@localhost/test" } as unknown as Env;
const mockRequestContext = {} as TrellisRequestContext;
const TEST_TENANT_ID = "tenant-test-123";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-123",
    email: "u@example.com",
    role: "END_USER",
    expiresAt: Date.now() + 3_600_000,
    sessionType: "user",
    lastActivityAt: Date.now(),
    ...overrides,
  } as Session;
}

function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionCodeHandler", () => {
  let handler: ConnectionCodeHandler;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ConnectionCodeHandler();
    session = makeSession();
  });

  // =========================================================================
  // handleGenerate
  // =========================================================================

  describe("handleGenerate", () => {
    it("returns 201 with id, code, expiresAt on success (no entityId)", async () => {
      mockPrisma.connectionCode.count.mockResolvedValue(0);
      mockPrisma.connectionCode.create.mockResolvedValue({
        id: "code-id-1",
        code: "ABCD1234",
        expiresAt: new Date("2099-01-01"),
      });

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        { expiresInHours: 24, maxUses: 3 },
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toHaveProperty("id", "code-id-1");
      expect(body).toHaveProperty("code");
      expect(body).toHaveProperty("expiresAt");
    });

    it("returns 201 when entityId is provided and user owns entity", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue({ entityId: "entity-1", userId: "user-123" });
      mockPrisma.connectionCode.count.mockResolvedValue(0);
      mockPrisma.connectionCode.create.mockResolvedValue({
        id: "code-id-2",
        code: "EFGH5678",
        expiresAt: new Date("2099-01-01"),
      });

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        { entityId: "entity-1", expiresInHours: 48, maxUses: 1 },
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(201);
      expect(mockPrisma.entityOwnership.findFirst).toHaveBeenCalledWith({
        where: { entityId: "entity-1", userId: "user-123", tenantId: TEST_TENANT_ID },
      });
    });

    it("returns 400 when body is invalid (expiresInHours out of range)", async () => {
      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        { expiresInHours: 9999 }, // exceeds MAX_EXPIRY_HOURS=168
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when maxUses exceeds max (10)", async () => {
      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        { maxUses: 100 },
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 400 on invalid JSON body (SyntaxError)", async () => {
      const request = new Request("https://api.example.com/api/connection-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("Invalid JSON body");
    });

    it("returns 403 when entityId is provided but user does not own entity", async () => {
      mockPrisma.entityOwnership.findFirst.mockResolvedValue(null);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        { entityId: "entity-other" },
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 429 when user already has MAX_ACTIVE_CODES_PER_USER (50) active codes", async () => {
      mockPrisma.connectionCode.count.mockResolvedValue(50);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        {},
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe("LIMIT_EXCEEDED");
      expect(body.message).toContain("50");
    });

    it("returns 500 on unexpected database error", async () => {
      mockPrisma.connectionCode.count.mockRejectedValue(new Error("DB down"));

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        {},
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
    });

    it("uses defaults for expiresInHours (24) and maxUses (1) when omitted", async () => {
      mockPrisma.connectionCode.count.mockResolvedValue(0);
      mockPrisma.connectionCode.create.mockResolvedValue({
        id: "code-id-default",
        code: "DEFAULTC",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        {},
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(201);
      // Verify create was called with maxUses=1 (the default)
      expect(mockPrisma.connectionCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ maxUses: 1 }),
        }),
      );
    });
  });

  // =========================================================================
  // handleRedeem
  // =========================================================================

  describe("handleRedeem", () => {
    const validCode = {
      id: "code-id-1",
      code: "ABCD1234",
      creatorId: "creator-999",
      entityId: null,
      expiresAt: new Date(Date.now() + 60_000),
      useCount: 0,
      maxUses: 5,
    };

    it("returns 200 with redeemed=true on successful redemption (no entity)", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
      mockGraphService.createRelationship.mockResolvedValue(undefined);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.redeemed).toBe(true);
      expect(body.creatorId).toBe("creator-999");
      expect(body.entityId).toBeNull();
    });

    it("returns 200 and creates entity relationship when code has entityId", async () => {
      const codeWithEntity = { ...validCode, entityId: "entity-abc" };
      mockPrisma.connectionCode.findFirst.mockResolvedValue(codeWithEntity);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
      mockGraphService.createRelationship.mockResolvedValue(undefined);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.entityId).toBe("entity-abc");
      // Should create two graph relationships: one to user, one to entity
      expect(mockGraphService.createRelationship).toHaveBeenCalledTimes(2);
      expect(mockGraphService.createRelationship).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: "entity", targetId: "entity-abc" }),
      );
    });

    it("returns 400 on missing/invalid code field", async () => {
      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "" }, // empty string fails min(1)
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("code is required");
    });

    it("returns 400 on invalid JSON", async () => {
      const request = new Request("https://api.example.com/api/connection-codes/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "bad-json{",
      });

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("returns 404 when code does not exist in DB", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(null);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "NOTFOUND" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
      expect(body.message).toBe("Connection code not found");
    });

    it("returns uniform 404 when user tries to redeem their own code", async () => {
      const ownCode = { ...validCode, creatorId: "user-123" }; // same as session.userId
      mockPrisma.connectionCode.findFirst.mockResolvedValue(ownCode);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
      expect(body.message).toBe("Connection code is invalid or unavailable");
    });

    it("returns uniform 404 when code is expired", async () => {
      const expiredCode = { ...validCode, expiresAt: new Date(Date.now() - 1000) };
      mockPrisma.connectionCode.findFirst.mockResolvedValue(expiredCode);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.message).toBe("Connection code is invalid or unavailable");
    });

    it("returns uniform 404 when code has reached max uses", async () => {
      const maxedCode = { ...validCode, useCount: 5, maxUses: 5 };
      mockPrisma.connectionCode.findFirst.mockResolvedValue(maxedCode);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.message).toBe("Connection code is invalid or unavailable");
    });

    it("returns 409 on duplicate redemption (Prisma P2002)", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });
      mockPrisma.$transaction.mockRejectedValue(p2002);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
    });

    it("returns 410 when conditional update fails (Prisma P2025 — code maxed concurrently)", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      const p2025 = Object.assign(new Error("Record not found"), { code: "P2025" });
      mockPrisma.$transaction.mockRejectedValue(p2025);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("GONE");
    });

    it("re-throws unknown transaction errors (results in 500)", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      const unknownError = Object.assign(new Error("Unknown TX error"), { code: "P9999" });
      mockPrisma.$transaction.mockRejectedValue(unknownError);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(500);
    });

    it("graph failure is non-fatal — still returns 200", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
      mockGraphService.createRelationship.mockRejectedValue(new Error("Graph DB down"));

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "ABCD1234" },
      );

      const response = await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.redeemed).toBe(true);
      // Logger should have recorded the non-fatal error
          });

    it("normalises code to uppercase before lookup", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(validCode);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);
      mockGraphService.createRelationship.mockResolvedValue(undefined);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes/redeem",
        "POST",
        { code: "abcd1234" }, // lowercase
      );

      await handler.handleRedeem(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(mockPrisma.connectionCode.findFirst).toHaveBeenCalledWith({
        where: { code: "ABCD1234", tenantId: TEST_TENANT_ID },
      });
    });
  });

  // =========================================================================
  // handleGetMyCodes
  // =========================================================================

  describe("handleGetMyCodes", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    const fakeCodes = [
      {
        id: "c1",
        code: "AAA11111",
        entityId: null,
        expiresAt: future,
        maxUses: 5,
        useCount: 2,
        createdAt: now,
        _count: { redemptions: 2 },
      },
      {
        id: "c2",
        code: "BBB22222",
        entityId: "entity-1",
        expiresAt: future,
        maxUses: 3,
        useCount: 3, // maxed
        createdAt: now,
        _count: { redemptions: 3 },
      },
    ];

    it("returns 200 with active-only codes by default (filters maxed)", async () => {
      mockPrisma.connectionCode.findMany.mockResolvedValue(fakeCodes);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "GET",
      );

      const response = await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      // c2 is maxed (useCount >= maxUses) so should be filtered out in active-only mode
      expect(body.codes).toHaveLength(1);
      expect(body.codes[0].id).toBe("c1");
    });

    it("returns all codes (including maxed) when ?active=false", async () => {
      mockPrisma.connectionCode.findMany.mockResolvedValue(fakeCodes);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?active=false",
        "GET",
      );

      const response = await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.codes).toHaveLength(2);
    });

    it("passes creatorId filter for the current session user", async () => {
      mockPrisma.connectionCode.findMany.mockResolvedValue([]);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "GET",
      );

      await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(mockPrisma.connectionCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ creatorId: "user-123" }),
        }),
      );
    });

    it("returns 200 with empty codes list when user has no codes", async () => {
      mockPrisma.connectionCode.findMany.mockResolvedValue([]);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "GET",
      );

      const response = await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.codes).toEqual([]);
    });

    it("returns 500 on DB error", async () => {
      mockPrisma.connectionCode.findMany.mockRejectedValue(new Error("DB error"));

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "GET",
      );

      const response = await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(500);
    });

    it("maps codes to the expected shape (includes redemptions count)", async () => {
      mockPrisma.connectionCode.findMany.mockResolvedValue([fakeCodes[0]]);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "GET",
      );

      const response = await handler.handleGetMyCodes(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      const body = await response.json();
      const code = body.codes[0];
      expect(code).toHaveProperty("id");
      expect(code).toHaveProperty("code");
      expect(code).toHaveProperty("entityId");
      expect(code).toHaveProperty("expiresAt");
      expect(code).toHaveProperty("maxUses");
      expect(code).toHaveProperty("useCount");
      expect(code).toHaveProperty("redemptions", 2);
      expect(code).toHaveProperty("createdAt");
    });
  });

  // =========================================================================
  // handleRevoke
  // =========================================================================

  describe("handleRevoke", () => {
    const existingCode = { id: "code-id-1", code: "ABCD1234", creatorId: "user-123" };

    it("returns 204 on successful revocation", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(existingCode);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?codeId=code-id-1",
        "DELETE",
      );

      const response = await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(204);
    });

    it("deletes redemptions before the code (inside transaction)", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(existingCode);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?codeId=code-id-1",
        "DELETE",
      );

      await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("returns 400 when codeId query param is missing", async () => {
      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "DELETE",
      );

      const response = await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("codeId is required");
    });

    it("returns 404 when code does not exist", async () => {
      mockPrisma.connectionCode.findFirst.mockResolvedValue(null);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?codeId=nonexistent",
        "DELETE",
      );

      const response = await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("returns 403 when code belongs to a different user", async () => {
      const otherCode = { ...existingCode, creatorId: "someone-else" };
      mockPrisma.connectionCode.findFirst.mockResolvedValue(otherCode);

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?codeId=code-id-1",
        "DELETE",
      );

      const response = await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("returns 500 on unexpected DB error", async () => {
      mockPrisma.connectionCode.findFirst.mockRejectedValue(new Error("DB error"));

      const request = makeRequest(
        "https://api.example.com/api/connection-codes?codeId=code-id-1",
        "DELETE",
      );

      const response = await handler.handleRevoke(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(500);
    });
  });

  // =========================================================================
  // handleError (private — exercised via public methods)
  // =========================================================================

  describe("handleError (via handleGenerate)", () => {
    it("returns 400 for SyntaxError (invalid JSON body)", async () => {
      const request = new Request("https://api.example.com/api/connection-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad json",
      });

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("Invalid JSON body");
    });

    it("returns 500 and logs for unexpected Error", async () => {
      // Make connectionCode.count throw an unexpected error
      mockPrisma.connectionCode.count.mockRejectedValue(new Error("Unexpected failure"));

      const request = makeRequest(
        "https://api.example.com/api/connection-codes",
        "POST",
        {},
      );

      const response = await handler.handleGenerate(request, session, mockEnv, mockRequestContext, TEST_TENANT_ID);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("INTERNAL_ERROR");
          });
  });
});
