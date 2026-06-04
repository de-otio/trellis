/**
 * Unit Tests: Parental Link Handler
 *
 * Tests for creating, confirming, revoking, and listing parental links.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { ParentalLinkHandler } from "../../src/lib/parental-link-handler.js";

// Mock Prisma client
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
  },
  parentalLink: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

describe("ParentalLinkHandler", () => {
  let handler: ParentalLinkHandler;
  let mockEnv: Env;
  let mockRequestContext: any;

  const childSession: any = {
    userId: "child-1",
    email: "child@example.com",
    expiresAt: Date.now() + 3600000,
    dataRegion: "US",
    profileContext: "primary",
    ageTier: "CHILD",
  };

  const guardianSession: any = {
    userId: "guardian-1",
    email: "guardian@example.com",
    expiresAt: Date.now() + 3600000,
    dataRegion: "US",
    profileContext: "primary",
    ageTier: "ADULT",
  };

  const otherSession: any = {
    userId: "other-1",
    email: "other@example.com",
    expiresAt: Date.now() + 3600000,
    dataRegion: "US",
    profileContext: "primary",
    ageTier: "ADULT",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ParentalLinkHandler();
    mockEnv = {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    } as Env;
    mockRequestContext = {
      region: "US",
      config: {},
    };
  });

  describe("createLink", () => {
    it("should create a PENDING link and return 201", async () => {
      // Child user exists and is a CHILD
      const childDob = new Date();
      childDob.setUTCFullYear(childDob.getUTCFullYear() - 10);

      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "child-1", dateOfBirth: childDob }) // child lookup
        .mockResolvedValueOnce({ id: "guardian-1" }); // guardian lookup

      mockPrisma.parentalLink.findFirst.mockResolvedValue(null); // no duplicate

      const createdLink = {
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "PENDING",
        createdAt: new Date(),
        confirmedAt: null,
      };
      mockPrisma.parentalLink.create.mockResolvedValue(createdLink);

      const response = await handler.createLink(
        "child-1",
        "guardian@example.com",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe("link-1");
      expect(body.status).toBe("PENDING");
    });

    it("should return 404 when guardian email is not found", async () => {
      const childDob = new Date();
      childDob.setUTCFullYear(childDob.getUTCFullYear() - 10);

      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "child-1", dateOfBirth: childDob })
        .mockResolvedValueOnce(null); // guardian not found

      const response = await handler.createLink(
        "child-1",
        "nonexistent@example.com",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });

    it("should return 409 when a duplicate link exists", async () => {
      const childDob = new Date();
      childDob.setUTCFullYear(childDob.getUTCFullYear() - 10);

      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "child-1", dateOfBirth: childDob })
        .mockResolvedValueOnce({ id: "guardian-1" });

      mockPrisma.parentalLink.findFirst.mockResolvedValue({
        id: "existing-link",
        status: "ACTIVE",
      });

      const response = await handler.createLink(
        "child-1",
        "guardian@example.com",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("CONFLICT");
    });

    it("should return 403 when child is not CHILD tier", async () => {
      // Child DOB makes them a TEEN (age 15)
      const teenDob = new Date();
      teenDob.setUTCFullYear(teenDob.getUTCFullYear() - 15);

      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "child-1",
        dateOfBirth: teenDob,
      });

      const response = await handler.createLink(
        "child-1",
        "guardian@example.com",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should return 403 when session user is not the child", async () => {
      const response = await handler.createLink(
        "child-1",
        "guardian@example.com",
        otherSession, // other-1 is not child-1
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });
  });

  describe("confirmLink", () => {
    it("should confirm a pending link and return 200", async () => {
      const pendingLink = {
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "PENDING",
        createdAt: new Date(),
        confirmedAt: null,
      };
      mockPrisma.parentalLink.findUnique.mockResolvedValue(pendingLink);

      const confirmedLink = {
        ...pendingLink,
        status: "ACTIVE",
        confirmedAt: new Date(),
      };
      mockPrisma.parentalLink.update.mockResolvedValue(confirmedLink);

      const response = await handler.confirmLink(
        "link-1",
        guardianSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("ACTIVE");
      expect(body.confirmedAt).toBeDefined();
    });

    it("should return 403 when caller is not the guardian", async () => {
      mockPrisma.parentalLink.findUnique.mockResolvedValue({
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "PENDING",
      });

      const response = await handler.confirmLink(
        "link-1",
        otherSession, // other-1 is not guardian-1
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should return 404 when link is not found", async () => {
      mockPrisma.parentalLink.findUnique.mockResolvedValue(null);

      const response = await handler.confirmLink(
        "nonexistent",
        guardianSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("NOT_FOUND");
    });
  });

  describe("revokeLink", () => {
    it("should revoke an active link and return 200", async () => {
      const activeLink = {
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "ACTIVE",
      };
      mockPrisma.parentalLink.findUnique.mockResolvedValue(activeLink);

      const revokedLink = { ...activeLink, status: "REVOKED" };
      mockPrisma.parentalLink.update.mockResolvedValue(revokedLink);

      const response = await handler.revokeLink(
        "link-1",
        guardianSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("REVOKED");
    });

    it("should return 403 when caller is neither child nor guardian", async () => {
      mockPrisma.parentalLink.findUnique.mockResolvedValue({
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "ACTIVE",
      });

      const response = await handler.revokeLink(
        "link-1",
        otherSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should allow the child to revoke a link", async () => {
      mockPrisma.parentalLink.findUnique.mockResolvedValue({
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "ACTIVE",
      });

      mockPrisma.parentalLink.update.mockResolvedValue({
        id: "link-1",
        childId: "child-1",
        guardianId: "guardian-1",
        status: "REVOKED",
      });

      const response = await handler.revokeLink(
        "link-1",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("REVOKED");
    });
  });

  describe("getLinksForUser", () => {
    it("should return links where user is child or guardian", async () => {
      const links = [
        {
          id: "link-1",
          childId: "child-1",
          guardianId: "guardian-1",
          status: "ACTIVE",
          createdAt: new Date(),
        },
        {
          id: "link-2",
          childId: "child-1",
          guardianId: "guardian-2",
          status: "PENDING",
          createdAt: new Date(),
        },
      ];
      mockPrisma.parentalLink.findMany.mockResolvedValue(links);

      const response = await handler.getLinksForUser(
        "child-1",
        childSession,
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.links).toHaveLength(2);
    });

    it("should return 403 when requesting another user's links", async () => {
      const response = await handler.getLinksForUser(
        "child-1",
        otherSession, // other-1 is not child-1
        mockEnv,
        mockRequestContext,
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("FORBIDDEN");
    });
  });
});
