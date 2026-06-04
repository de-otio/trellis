/**
 * Unit Tests: Entity Relationship Routes
 *
 * Tests for entity relationship CRUD endpoints: create, confirm, reject, remove, get, and get pending.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import type { TrellisRequestContext } from "../../../src/lib/request-context.js";
import { entityRelationshipRoutes } from "../../../src/lib/routes/entity-relationships.js";
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
    constructor(_env: any) {}
  },
}));

// Mock EntityRelationshipHandler
const mockHandleCreate = vi.fn();
const mockHandleConfirm = vi.fn();
const mockHandleReject = vi.fn();
const mockHandleRemove = vi.fn();
const mockHandleGetForEntity = vi.fn();
const mockHandleGetPending = vi.fn();
vi.mock("../../../src/lib/entity-relationship-handler", () => ({
  EntityRelationshipHandler: class {
    handleCreate = mockHandleCreate;
    handleConfirm = mockHandleConfirm;
    handleReject = mockHandleReject;
    handleRemove = mockHandleRemove;
    handleGetForEntity = mockHandleGetForEntity;
    handleGetPending = mockHandleGetPending;
  },
}));


describe("Entity Relationship Routes", () => {
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

    mockRequest = new Request("https://example.com/api/entity-relationships", {
      method: "POST",
    });

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation((body, options) => {
      return new Response(body, options);
    });
    mockAddSecurityHeaders.mockImplementation((response) => response);

    mockHandleCreate.mockResolvedValue(new Response("{}", { status: 201 }));
    mockHandleConfirm.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleReject.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleRemove.mockResolvedValue(new Response(null, { status: 204 }));
    mockHandleGetForEntity.mockResolvedValue(new Response("{}", { status: 200 }));
    mockHandleGetPending.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  describe("POST /api/entity-relationships", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find((r) => r.method === "POST" && r.path === "/api/entity-relationships");

    it("should call handleCreate when session exists", async () => {
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(mockRequest, "test-secret", mockEnv);
      expect(mockHandleCreate).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      await route!.handler(mockRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleCreate).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/entity-relationships/confirm", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find(
        (r) => r.method === "POST" && r.path === "/api/entity-relationships/confirm",
      );

    it("should call handleConfirm when session exists", async () => {
      const route = getRoute();
      const confirmRequest = new Request("https://example.com/api/entity-relationships/confirm", {
        method: "POST",
      });
      await route!.handler(confirmRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(confirmRequest, "test-secret", mockEnv);
      expect(mockHandleConfirm).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const confirmRequest = new Request("https://example.com/api/entity-relationships/confirm", {
        method: "POST",
      });
      await route!.handler(confirmRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleConfirm).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/entity-relationships/reject", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find(
        (r) => r.method === "POST" && r.path === "/api/entity-relationships/reject",
      );

    it("should call handleReject when session exists", async () => {
      const route = getRoute();
      const rejectRequest = new Request("https://example.com/api/entity-relationships/reject", {
        method: "POST",
      });
      await route!.handler(rejectRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(rejectRequest, "test-secret", mockEnv);
      expect(mockHandleReject).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const rejectRequest = new Request("https://example.com/api/entity-relationships/reject", {
        method: "POST",
      });
      await route!.handler(rejectRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleReject).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/entity-relationships", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find((r) => r.method === "DELETE" && r.path === "/api/entity-relationships");

    it("should call handleRemove when session exists", async () => {
      const route = getRoute();
      const deleteRequest = new Request("https://example.com/api/entity-relationships", {
        method: "DELETE",
      });
      await route!.handler(deleteRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(deleteRequest, "test-secret", mockEnv);
      expect(mockHandleRemove).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const deleteRequest = new Request("https://example.com/api/entity-relationships", {
        method: "DELETE",
      });
      await route!.handler(deleteRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleRemove).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/entity-relationships", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find((r) => r.method === "GET" && r.path === "/api/entity-relationships");

    it("should call handleGetForEntity when session exists", async () => {
      const route = getRoute();
      const getRequest = new Request("https://example.com/api/entity-relationships", { method: "GET" });
      await route!.handler(getRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(getRequest, "test-secret", mockEnv);
      expect(mockHandleGetForEntity).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const getRequest = new Request("https://example.com/api/entity-relationships", { method: "GET" });
      await route!.handler(getRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetForEntity).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/entity-relationships/pending", () => {
    const getRoute = () =>
      entityRelationshipRoutes.find(
        (r) => r.method === "GET" && r.path === "/api/entity-relationships/pending",
      );

    it("should call handleGetPending when session exists", async () => {
      const route = getRoute();
      const pendingRequest = new Request("https://example.com/api/entity-relationships/pending", {
        method: "GET",
      });
      await route!.handler(pendingRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockGetSession).toHaveBeenCalledWith(pendingRequest, "test-secret", mockEnv);
      expect(mockHandleGetPending).toHaveBeenCalledOnce();
      expect(mockAddSecurityHeaders).toHaveBeenCalledOnce();
    });

    it("should return 401 when session is null", async () => {
      mockGetSession.mockResolvedValue(null);
      const route = getRoute();
      const pendingRequest = new Request("https://example.com/api/entity-relationships/pending", {
        method: "GET",
      });
      await route!.handler(pendingRequest, mockEnv, { requestContext: mockRequestContext });

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      expect(mockHandleGetPending).not.toHaveBeenCalled();
    });
  });

  describe("Route configuration", () => {
    it("should have 6 entity relationship routes", () => {
      expect(entityRelationshipRoutes).toHaveLength(6);
    });

    it("should have correct HTTP methods", () => {
      const postRoutes = entityRelationshipRoutes.filter((r) => r.method === "POST");
      const getRoutes = entityRelationshipRoutes.filter((r) => r.method === "GET");
      const deleteRoutes = entityRelationshipRoutes.filter((r) => r.method === "DELETE");
      expect(postRoutes).toHaveLength(3);
      expect(getRoutes).toHaveLength(2);
      expect(deleteRoutes).toHaveLength(1);
    });
  });
});
