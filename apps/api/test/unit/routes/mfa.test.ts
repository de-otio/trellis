/**
 * Unit Tests: MFA Routes
 *
 * Tests for MFA route handlers including status, enrollment, and verification.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { __resetRateLimiterForTests } from "../../../src/lib/rate-limit.js";
import { mfaAttemptLimits, mfaRoutes } from "../../../src/lib/routes/mfa.js";

// Mock SessionManager
const mockGetSession = vi.fn();
const mockEncryptSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    encryptSession = mockEncryptSession;
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

// Mock MfaHandler
const mockGetStatus = vi.fn();
const mockBeginEnrollment = vi.fn();
const mockFinalizeEnrollment = vi.fn();
const mockVerifyCode = vi.fn();
const mockVerifyBackupCode = vi.fn();
vi.mock("../../../src/lib/mfa/mfa-handler", () => ({
  MfaHandler: class {
    getStatus = mockGetStatus;
    beginEnrollment = mockBeginEnrollment;
    finalizeEnrollment = mockFinalizeEnrollment;
    verifyCode = mockVerifyCode;
    verifyBackupCode = mockVerifyBackupCode;
    constructor(env: any) {}
  },
}));

// Mock CorsHandler
const mockAddCorsHeaders = vi.fn();
vi.mock("../../../src/lib/cors-handler", () => ({
  CorsHandler: {
    addCorsHeaders: vi.fn((response) => response),
  },
}));


// Mock createPrisma
const mockPrisma = {};
vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

describe("MFA Routes", () => {
  let mockEnv: Env;
  let mockSession: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // The attempt throttle uses the real limiter on its in-memory backend
    // (no KV configured here); its bucket state is module-scoped, so reset it
    // or one test's attempts bleed into the next.
    __resetRateLimiterForTests();

    mockEnv = {
      DATABASE_URL: "postgresql://test",
      SESSION_SECRET: "test-secret-32-characters-long!!",
    } as any;
    mockAddSecurityHeaders.mockImplementation((r: Response) => r);

    mockSession = {
      userId: "user-123",
      email: "user@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
    };

    mockGetSession.mockResolvedValue(mockSession);
    mockCreateSecureResponse.mockImplementation(
      (body, options) => new Response(body, options),
    );
    mockAddSecurityHeaders.mockImplementation((response) => response);
  });

  describe("GET /api/mfa/status - Get MFA enrollment status", () => {
    const route = mfaRoutes.find(
      (r) => r.path === "/api/mfa/status" && r.method === "GET",
    );

    it("should return MFA status for authenticated user", async () => {
      const mockStatus = { enrolled: true, method: "totp" };
      mockGetStatus.mockResolvedValue(mockStatus);

      const request = new Request("https://example.com/api/mfa/status", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/status",
      });

      expect(mockGetSession).toHaveBeenCalled();
      expect(mockGetStatus).toHaveBeenCalledWith(
        mockPrisma,
        "user-123",
        "END_USER",
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.enrolled).toBe(true);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("https://example.com/api/mfa/status", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/status",
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Unauthorized");
      expect(mockGetStatus).not.toHaveBeenCalled();
    });

    it("should return 500 on handler error", async () => {
      mockGetStatus.mockRejectedValue(new Error("DB error"));

      const request = new Request("https://example.com/api/mfa/status", {
        method: "GET",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/status",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
          });
  });

  describe("POST /api/mfa/enroll/begin - Begin MFA enrollment", () => {
    const route = mfaRoutes.find(
      (r) => r.path === "/api/mfa/enroll/begin" && r.method === "POST",
    );

    it("should begin enrollment for authenticated user", async () => {
      const mockEnrollment = {
        otpauthUri: "otpauth://totp/test?secret=ABC",
        secret: "ABC123",
        backupCodes: ["code1", "code2"],
      };
      mockBeginEnrollment.mockResolvedValue(mockEnrollment);

      const request = new Request("https://example.com/api/mfa/enroll/begin", {
        method: "POST",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/begin",
      });

      expect(mockBeginEnrollment).toHaveBeenCalledWith("user@example.com");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.otpauthUri).toBe("otpauth://totp/test?secret=ABC");
      expect(body.secret).toBe("ABC123");
      expect(body.backupCodes).toEqual(["code1", "code2"]);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("https://example.com/api/mfa/enroll/begin", {
        method: "POST",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/begin",
      });

      expect(response.status).toBe(401);
      expect(mockBeginEnrollment).not.toHaveBeenCalled();
    });

    it("should return 500 on handler error", async () => {
      mockBeginEnrollment.mockRejectedValue(new Error("Enrollment failed"));

      const request = new Request("https://example.com/api/mfa/enroll/begin", {
        method: "POST",
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/begin",
      });

      expect(response.status).toBe(500);
          });
  });

  describe("POST /api/mfa/enroll/finalize - Finalize MFA enrollment", () => {
    const route = mfaRoutes.find(
      (r) => r.path === "/api/mfa/enroll/finalize" && r.method === "POST",
    );

    it("should finalize enrollment with valid data", async () => {
      mockFinalizeEnrollment.mockResolvedValue({ success: true });

      const request = new Request(
        "https://example.com/api/mfa/enroll/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: "ABCDEFGHIJKLMNOP",
            backupCodes: ["code1"],
            verificationCode: "123456",
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/finalize",
      });

      expect(mockFinalizeEnrollment).toHaveBeenCalledWith(
        mockPrisma,
        "user-123",
        "ABCDEFGHIJKLMNOP",
        ["code1"],
        "123456",
        expect.objectContaining({ purpose: "mfa" }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request(
        "https://example.com/api/mfa/enroll/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: "ABCDEFGHIJKLMNOP",
            backupCodes: ["code1"],
            verificationCode: "123456",
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/finalize",
      });

      expect(response.status).toBe(401);
      expect(mockFinalizeEnrollment).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid request body", async () => {
      const request = new Request(
        "https://example.com/api/mfa/enroll/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: "short", // Too short
            backupCodes: [],  // Too few
            verificationCode: "12",  // Too short
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/finalize",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
      expect(body.details).toBeDefined();
      expect(mockFinalizeEnrollment).not.toHaveBeenCalled();
    });

    it("should return 400 when finalization fails", async () => {
      mockFinalizeEnrollment.mockResolvedValue({
        success: false,
        error: "Invalid verification code",
      });

      const request = new Request(
        "https://example.com/api/mfa/enroll/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: "ABCDEFGHIJKLMNOP",
            backupCodes: ["code1"],
            verificationCode: "123456",
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/finalize",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid verification code");
    });

    it("should return 500 on handler error", async () => {
      mockFinalizeEnrollment.mockRejectedValue(new Error("DB error"));

      const request = new Request(
        "https://example.com/api/mfa/enroll/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: "ABCDEFGHIJKLMNOP",
            backupCodes: ["code1"],
            verificationCode: "123456",
          }),
        },
      );

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/enroll/finalize",
      });

      expect(response.status).toBe(500);
          });
  });

  describe("POST /api/mfa/verify - Verify MFA code", () => {
    const route = mfaRoutes.find(
      (r) => r.path === "/api/mfa/verify" && r.method === "POST",
    );

    it("should verify TOTP code successfully", async () => {
      mockVerifyCode.mockResolvedValue(true);
      mockEncryptSession.mockResolvedValue("encrypted-session-data");

      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", type: "totp" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(mockVerifyCode).toHaveBeenCalledWith(
        mockPrisma,
        "user-123",
        "123456",
        expect.objectContaining({ purpose: "mfa" }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      // Should set session cookie
      expect(response.headers.get("Set-Cookie")).toContain("trellis_session");
    });

    it("should verify backup code successfully", async () => {
      mockVerifyBackupCode.mockResolvedValue(true);
      mockEncryptSession.mockResolvedValue("encrypted-session-data");

      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "backup-cd", type: "backup" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(mockVerifyBackupCode).toHaveBeenCalledWith(
        mockPrisma,
        "user-123",
        "backup-cd",
        expect.objectContaining({ purpose: "mfa" }),
      );
      expect(mockVerifyCode).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("should return 401 for unauthenticated request", async () => {
      mockGetSession.mockResolvedValue(null);

      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(response.status).toBe(401);
      expect(mockVerifyCode).not.toHaveBeenCalled();
    });

    it("should return 401 for invalid code", async () => {
      mockVerifyCode.mockResolvedValue(false);

      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "000000", type: "totp" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("Invalid code");
    });

    it("should return 400 for invalid request body", async () => {
      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "12", type: "invalid" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid request");
    });

    it("should return 500 on handler error", async () => {
      mockVerifyCode.mockRejectedValue(new Error("DB error"));

      const request = new Request("https://example.com/api/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", type: "totp" }),
      });

      const response = await route!.handler(request, mockEnv, {
        pathname: "/api/mfa/verify",
      });

      expect(response.status).toBe(500);
          });
  });

  describe("verification-attempt throttle (DP-2)", () => {
    const verifyRoute = mfaRoutes.find(
      (r) => r.path === "/api/mfa/verify" && r.method === "POST",
    );
    const finalizeRoute = mfaRoutes.find(
      (r) => r.path === "/api/mfa/enroll/finalize" && r.method === "POST",
    );

    const verifyAttempt = (code = "000000") =>
      verifyRoute!.handler(
        new Request("https://example.com/api/mfa/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, type: "totp" }),
        }),
        mockEnv,
        { pathname: "/api/mfa/verify" },
      );

    it("resolves defaults when nothing is configured, and env overrides them", () => {
      expect(mfaAttemptLimits({} as Env)).toEqual({
        perUser: 5,
        perIp: 20,
        windowSeconds: 300,
      });
      expect(
        mfaAttemptLimits({
          MFA_VERIFY_MAX_ATTEMPTS: "3",
          MFA_VERIFY_MAX_ATTEMPTS_PER_IP: "7",
          MFA_VERIFY_WINDOW_SECONDS: "60",
        } as Env),
      ).toEqual({ perUser: 3, perIp: 7, windowSeconds: 60 });
      // Garbage falls back rather than disabling the throttle.
      expect(mfaAttemptLimits({ MFA_VERIFY_MAX_ATTEMPTS: "0" } as Env).perUser).toBe(5);
      expect(mfaAttemptLimits({ MFA_VERIFY_MAX_ATTEMPTS: "lots" } as Env).perUser).toBe(5);
    });

    it("refuses the attempt after the per-user budget with 429 and stops calling the verifier", async () => {
      mockVerifyCode.mockResolvedValue(false);
      const { perUser } = mfaAttemptLimits(mockEnv);

      for (let i = 0; i < perUser; i++) {
        const res = await verifyAttempt();
        expect(res.status).toBe(401); // wrong code, but still evaluated
      }
      expect(mockVerifyCode).toHaveBeenCalledTimes(perUser);

      const refused = await verifyAttempt();
      expect(refused.status).toBe(429);
      expect(refused.headers.get("Retry-After")).toBeTruthy();
      // The budget is spent BEFORE the code is checked: no sixth evaluation.
      expect(mockVerifyCode).toHaveBeenCalledTimes(perUser);
    });

    it("spends the budget on successful attempts too, so it is not a free oracle", async () => {
      mockVerifyCode.mockResolvedValue(true);
      mockEncryptSession.mockResolvedValue("encrypted-session-data");
      mockEnv.MFA_VERIFY_MAX_ATTEMPTS = "2";

      expect((await verifyAttempt("123456")).status).toBe(200);
      expect((await verifyAttempt("123456")).status).toBe(200);
      expect((await verifyAttempt("123456")).status).toBe(429);
    });

    it("throttles finalize on the same budget", async () => {
      mockFinalizeEnrollment.mockResolvedValue({ success: false, error: "Invalid verification code" });
      mockEnv.MFA_VERIFY_MAX_ATTEMPTS = "1";

      const attempt = () =>
        finalizeRoute!.handler(
          new Request("https://example.com/api/mfa/enroll/finalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secret: "ABCDEFGHIJKLMNOP",
              backupCodes: ["code1"],
              verificationCode: "000000",
            }),
          }),
          mockEnv,
          { pathname: "/api/mfa/enroll/finalize" },
        );

      expect((await attempt()).status).toBe(400);
      expect((await attempt()).status).toBe(429);
      expect(mockFinalizeEnrollment).toHaveBeenCalledTimes(1);
    });

    it("keeps separate per-user budgets", async () => {
      mockVerifyCode.mockResolvedValue(false);
      mockEnv.MFA_VERIFY_MAX_ATTEMPTS = "1";

      expect((await verifyAttempt()).status).toBe(401);
      expect((await verifyAttempt()).status).toBe(429);

      mockGetSession.mockResolvedValue({ ...mockSession, userId: "user-456" });
      // A different user is not punished for user-123's attempts (the shared
      // IP budget is 20 by default, well above what this test spends).
      expect((await verifyAttempt()).status).toBe(401);
    });
  });

  describe("Route configuration", () => {
    it("should have all required routes", () => {
      expect(mfaRoutes).toHaveLength(4);
      expect(mfaRoutes.filter((r) => r.method === "GET")).toHaveLength(1);
      expect(mfaRoutes.filter((r) => r.method === "POST")).toHaveLength(3);
    });

    it("should have middleware configured for all routes", () => {
      mfaRoutes.forEach((route) => {
        expect(route.middleware).toBeDefined();
      });
    });

    it("should have descriptions for all routes", () => {
      mfaRoutes.forEach((route) => {
        expect(route.description).toBeDefined();
        expect(typeof route.description).toBe("string");
      });
    });

    it("should have CSRF middleware on mutation routes", () => {
      const mutationRoutes = mfaRoutes.filter((r) => r.method === "POST");
      mutationRoutes.forEach((route) => {
        // POST routes for enroll/begin, enroll/finalize, verify should have csrf
        if (route.path !== "/api/mfa/status") {
          expect(route.middleware!.length).toBeGreaterThanOrEqual(2);
        }
      });
    });
  });
});
