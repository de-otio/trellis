/**
 * Unit Tests: Invitations Routes
 *
 * Tests for invitation route handlers including create, list, validate, delete, and get inviter info.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { invitationsRoutes } from "../../../src/lib/routes/invitations.js";

// Mock InvitationHandler
const mockHandleCreateInvitation = vi.fn();
const mockHandleListInvitations = vi.fn();
const mockHandleGetInviterInfo = vi.fn();
const mockHandleValidateInvitation = vi.fn();
const mockHandleDeleteInvitation = vi.fn();
vi.mock("../../../src/lib/invitation-handler", () => ({
  InvitationHandler: class {
    handleCreateInvitation = mockHandleCreateInvitation;
    handleListInvitations = mockHandleListInvitations;
    handleGetInviterInfo = mockHandleGetInviterInfo;
    handleValidateInvitation = mockHandleValidateInvitation;
    handleDeleteInvitation = mockHandleDeleteInvitation;
  },
}));

// Mock addCorsHeaders
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (...args: any[]) => mockAddCorsHeaders(...args),
}));

describe("Invitations Routes", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret",
    } as any;

    mockRequest = new Request("https://example.com/api/invitations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "test@example.com" }),
    });

    mockAddCorsHeaders.mockImplementation(async (response) => response);
  });

  describe("POST /api/invitations - Create invitation", () => {
    const route = invitationsRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/invitations",
    );

    it("should create invitation successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ id: "inv-123", code: "ABC123" }),
        { status: 201 },
      );
      mockHandleCreateInvitation.mockResolvedValue(mockResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockHandleCreateInvitation).toHaveBeenCalledWith(
        mockRequest,
        mockEnv,
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        mockRequest,
        mockEnv,
      );
      expect(response.status).toBe(201);
    });

    it("should handle errors from InvitationHandler", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Daily limit exceeded" }),
        { status: 429 },
      );
      mockHandleCreateInvitation.mockResolvedValue(errorResponse);

      const response = await route!.handler(mockRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        errorResponse,
        mockRequest,
        mockEnv,
      );
      expect(response.status).toBe(429);
    });
  });

  describe("GET /api/invitations - List invitations", () => {
    const route = invitationsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/invitations",
    );

    it("should list invitations successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ invitations: [{ id: "inv-1" }, { id: "inv-2" }] }),
        { status: 200 },
      );
      mockHandleListInvitations.mockResolvedValue(mockResponse);

      const getRequest = new Request("https://example.com/api/invitations", {
        method: "GET",
      });

      const response = await route!.handler(getRequest, mockEnv);

      expect(mockHandleListInvitations).toHaveBeenCalledWith(
        getRequest,
        mockEnv,
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        getRequest,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should handle errors from InvitationHandler", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401 },
      );
      mockHandleListInvitations.mockResolvedValue(errorResponse);

      const getRequest = new Request("https://example.com/api/invitations", {
        method: "GET",
      });

      const response = await route!.handler(getRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        errorResponse,
        getRequest,
        mockEnv,
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/invitations/inviter-info - Get inviter info", () => {
    const route = invitationsRoutes.find(
      (r) => r.method === "GET" && r.path === "/api/invitations/inviter-info",
    );

    it("should get inviter info successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ inviterId: "user-123", inviterName: "John Doe" }),
        { status: 200 },
      );
      mockHandleGetInviterInfo.mockResolvedValue(mockResponse);

      const getRequest = new Request(
        "https://example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv);

      expect(mockHandleGetInviterInfo).toHaveBeenCalledWith(
        getRequest,
        mockEnv,
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        getRequest,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should handle errors from InvitationHandler", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Inviter not found" }),
        { status: 404 },
      );
      mockHandleGetInviterInfo.mockResolvedValue(errorResponse);

      const getRequest = new Request(
        "https://example.com/api/invitations/inviter-info",
        {
          method: "GET",
        },
      );

      const response = await route!.handler(getRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        errorResponse,
        getRequest,
        mockEnv,
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/invitations/validate - Validate invitation", () => {
    const route = invitationsRoutes.find(
      (r) => r.method === "POST" && r.path === "/api/invitations/validate",
    );

    it("should validate invitation successfully", async () => {
      const mockResponse = new Response(
        JSON.stringify({ valid: true, invitationId: "inv-123" }),
        { status: 200 },
      );
      mockHandleValidateInvitation.mockResolvedValue(mockResponse);

      const postRequest = new Request(
        "https://example.com/api/invitations/validate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: "ABC123" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockHandleValidateInvitation).toHaveBeenCalledWith(
        postRequest,
        mockEnv,
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        postRequest,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should handle invalid invitation", async () => {
      const errorResponse = new Response(
        JSON.stringify({ valid: false, error: "Invalid code" }),
        { status: 400 },
      );
      mockHandleValidateInvitation.mockResolvedValue(errorResponse);

      const postRequest = new Request(
        "https://example.com/api/invitations/validate",
        {
          method: "POST",
          body: JSON.stringify({ code: "INVALID" }),
        },
      );

      const response = await route!.handler(postRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        errorResponse,
        postRequest,
        mockEnv,
      );
      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /api/invitations/:invitationId - Delete invitation", () => {
    const route = invitationsRoutes.find(
      (r) => r.method === "DELETE" && r.path.toString().includes("invitations"),
    );

    it("should delete invitation successfully", async () => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      mockHandleDeleteInvitation.mockResolvedValue(mockResponse);

      const deleteRequest = new Request(
        "https://example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, mockEnv);

      expect(mockHandleDeleteInvitation).toHaveBeenCalledWith(
        deleteRequest,
        mockEnv,
      );
      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        mockResponse,
        deleteRequest,
        mockEnv,
      );
      expect(response.status).toBe(200);
    });

    it("should handle errors from InvitationHandler", async () => {
      const errorResponse = new Response(
        JSON.stringify({ error: "Invitation not found" }),
        { status: 404 },
      );
      mockHandleDeleteInvitation.mockResolvedValue(errorResponse);

      const deleteRequest = new Request(
        "https://example.com/api/invitations/inv-123",
        {
          method: "DELETE",
        },
      );

      const response = await route!.handler(deleteRequest, mockEnv);

      expect(mockAddCorsHeaders).toHaveBeenCalledWith(
        errorResponse,
        deleteRequest,
        mockEnv,
      );
      expect(response.status).toBe(404);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(invitationsRoutes).toHaveLength(5);
      expect(invitationsRoutes.filter((r) => r.method === "POST")).toHaveLength(
        2,
      );
      expect(invitationsRoutes.filter((r) => r.method === "GET")).toHaveLength(
        2,
      );
      expect(
        invitationsRoutes.filter((r) => r.method === "DELETE"),
      ).toHaveLength(1);
    });

    it("should have middleware configured for all routes", () => {
      invitationsRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      invitationsRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });
  });
});
