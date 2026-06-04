/**
 * Unit Tests: MFA Handler
 *
 * Tests MFA enrollment, verification, backup codes, and status checks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

// Hoist mocks
const { mockVerifyTOTP, mockEncryptSecret, mockDecryptSecret, mockHashBackupCode } =
  vi.hoisted(() => ({
    mockVerifyTOTP: vi.fn(),
    mockEncryptSecret: vi.fn(),
    mockDecryptSecret: vi.fn(),
    mockHashBackupCode: vi.fn(),
  }));

vi.mock("../../../src/lib/mfa/totp-service", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    verifyTOTP: mockVerifyTOTP,
    encryptSecret: mockEncryptSecret,
    decryptSecret: mockDecryptSecret,
    hashBackupCode: mockHashBackupCode,
  };
});

import { MfaHandler } from "../../../src/lib/mfa/mfa-handler.js";

const mockPrisma = {
  mfaEnrollment: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
} as any;

describe("MfaHandler", () => {
  let handler: MfaHandler;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      LOG_LEVEL: "ERROR",
      NODE_ENV: "test",
    } as unknown as Env;
    handler = new MfaHandler(mockEnv);
  });

  describe("isMfaRequired", () => {
    it("should return true for SUPER_ADMIN", () => {
      expect(handler.isMfaRequired("SUPER_ADMIN")).toBe(true);
    });

    it("should return true for PARTNER_ADMIN", () => {
      expect(handler.isMfaRequired("PARTNER_ADMIN")).toBe(true);
    });

    it("should return false for END_USER", () => {
      expect(handler.isMfaRequired("END_USER")).toBe(false);
    });

    it("should return false for undefined role", () => {
      expect(handler.isMfaRequired(undefined)).toBe(false);
    });

    it("should return false for empty string role", () => {
      expect(handler.isMfaRequired("")).toBe(false);
    });
  });

  describe("isEnrolled", () => {
    it("should return true when enrollment exists", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({ id: "enr-1" });
      const result = await handler.isEnrolled(mockPrisma, "user-1");
      expect(result).toBe(true);
      expect(mockPrisma.mfaEnrollment.findUnique).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        select: { id: true },
      });
    });

    it("should return false when no enrollment exists", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue(null);
      const result = await handler.isEnrolled(mockPrisma, "user-2");
      expect(result).toBe(false);
    });
  });

  describe("beginEnrollment", () => {
    it("should return secret, otpauthUri, and backup codes", async () => {
      const result = await handler.beginEnrollment("user@example.com");
      expect(result.secret).toBeDefined();
      expect(result.secret.length).toBeGreaterThan(0);
      expect(result.otpauthUri).toContain("otpauth://totp/");
      expect(result.otpauthUri).toContain("user%40example.com");
      expect(result.backupCodes).toHaveLength(10);
    });

    it("should generate unique secrets per call", async () => {
      const r1 = await handler.beginEnrollment("a@b.com");
      const r2 = await handler.beginEnrollment("a@b.com");
      expect(r1.secret).not.toBe(r2.secret);
    });
  });

  describe("finalizeEnrollment", () => {
    it("should succeed when verification code is valid", async () => {
      mockVerifyTOTP.mockResolvedValue(true);
      mockEncryptSecret.mockResolvedValue("encrypted-secret");
      mockHashBackupCode.mockResolvedValue("hashed-code");
      mockPrisma.mfaEnrollment.upsert.mockResolvedValue({});

      const result = await handler.finalizeEnrollment(
        mockPrisma,
        "user-1",
        "SECRET",
        ["CODE1", "CODE2"],
        "123456",
        "enc-key",
      );

      expect(result).toEqual({ success: true });
      expect(mockVerifyTOTP).toHaveBeenCalledWith("SECRET", "123456");
      expect(mockEncryptSecret).toHaveBeenCalledWith("SECRET", "enc-key");
      expect(mockPrisma.mfaEnrollment.upsert).toHaveBeenCalled();
    });

    it("should fail when verification code is invalid", async () => {
      mockVerifyTOTP.mockResolvedValue(false);

      const result = await handler.finalizeEnrollment(
        mockPrisma,
        "user-1",
        "SECRET",
        ["CODE1"],
        "000000",
        "enc-key",
      );

      expect(result).toEqual({
        success: false,
        error: "Invalid verification code",
      });
      expect(mockPrisma.mfaEnrollment.upsert).not.toHaveBeenCalled();
    });

    it("should hash all backup codes before storing", async () => {
      mockVerifyTOTP.mockResolvedValue(true);
      mockEncryptSecret.mockResolvedValue("encrypted");
      mockHashBackupCode
        .mockResolvedValueOnce("hash-a")
        .mockResolvedValueOnce("hash-b")
        .mockResolvedValueOnce("hash-c");
      mockPrisma.mfaEnrollment.upsert.mockResolvedValue({});

      await handler.finalizeEnrollment(
        mockPrisma,
        "user-1",
        "SECRET",
        ["A", "B", "C"],
        "123456",
        "key",
      );

      expect(mockHashBackupCode).toHaveBeenCalledTimes(3);
      const upsertCall = mockPrisma.mfaEnrollment.upsert.mock.calls[0][0];
      expect(upsertCall.create.backupCodes).toEqual([
        "hash-a",
        "hash-b",
        "hash-c",
      ]);
    });
  });

  describe("verifyCode", () => {
    it("should return true for valid TOTP code and update lastUsedAt", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({
        encryptedSecret: "enc-secret",
      });
      mockDecryptSecret.mockResolvedValue("PLAIN_SECRET");
      mockVerifyTOTP.mockResolvedValue(true);
      mockPrisma.mfaEnrollment.update.mockResolvedValue({});

      const result = await handler.verifyCode(
        mockPrisma,
        "user-1",
        "123456",
        "enc-key",
      );

      expect(result).toBe(true);
      expect(mockDecryptSecret).toHaveBeenCalledWith("enc-secret", "enc-key");
      expect(mockVerifyTOTP).toHaveBeenCalledWith("PLAIN_SECRET", "123456");
      expect(mockPrisma.mfaEnrollment.update).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        data: { lastUsedAt: expect.any(Date) },
      });
    });

    it("should return false for invalid TOTP code", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({
        encryptedSecret: "enc-secret",
      });
      mockDecryptSecret.mockResolvedValue("PLAIN_SECRET");
      mockVerifyTOTP.mockResolvedValue(false);

      const result = await handler.verifyCode(
        mockPrisma,
        "user-1",
        "000000",
        "enc-key",
      );

      expect(result).toBe(false);
      expect(mockPrisma.mfaEnrollment.update).not.toHaveBeenCalled();
    });

    it("should return false when user is not enrolled", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue(null);

      const result = await handler.verifyCode(
        mockPrisma,
        "user-x",
        "123456",
        "enc-key",
      );

      expect(result).toBe(false);
      expect(mockDecryptSecret).not.toHaveBeenCalled();
    });
  });

  describe("verifyBackupCode", () => {
    it("should return true and remove used backup code", async () => {
      mockHashBackupCode.mockResolvedValue("hash-a");
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({
        backupCodes: ["hash-a", "hash-b", "hash-c"],
      });
      mockPrisma.mfaEnrollment.update.mockResolvedValue({});

      const result = await handler.verifyBackupCode(
        mockPrisma,
        "user-1",
        "ABCD-EFGH",
      );

      expect(result).toBe(true);
      const updateCall = mockPrisma.mfaEnrollment.update.mock.calls[0][0];
      expect(updateCall.data.backupCodes).toEqual(["hash-b", "hash-c"]);
      expect(updateCall.data.lastUsedAt).toBeInstanceOf(Date);
    });

    it("should return false for invalid backup code", async () => {
      mockHashBackupCode.mockResolvedValue("hash-wrong");
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({
        backupCodes: ["hash-a", "hash-b"],
      });

      const result = await handler.verifyBackupCode(
        mockPrisma,
        "user-1",
        "XXXX-YYYY",
      );

      expect(result).toBe(false);
      expect(mockPrisma.mfaEnrollment.update).not.toHaveBeenCalled();
    });

    it("should return false when user is not enrolled", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue(null);

      const result = await handler.verifyBackupCode(
        mockPrisma,
        "user-x",
        "ABCD-EFGH",
      );

      expect(result).toBe(false);
    });
  });

  describe("removeEnrollment", () => {
    it("should delete enrollment for user", async () => {
      mockPrisma.mfaEnrollment.deleteMany.mockResolvedValue({ count: 1 });

      await handler.removeEnrollment(mockPrisma, "user-1");

      expect(mockPrisma.mfaEnrollment.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });
  });

  describe("getStatus", () => {
    it("should return enrolled status with backup code count", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue({
        backupCodes: ["a", "b", "c"],
      });

      const status = await handler.getStatus(mockPrisma, "user-1", "SUPER_ADMIN");

      expect(status).toEqual({
        enrolled: true,
        required: true,
        backupCodesRemaining: 3,
      });
    });

    it("should return not enrolled status", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue(null);

      const status = await handler.getStatus(mockPrisma, "user-1", "END_USER");

      expect(status).toEqual({
        enrolled: false,
        required: false,
        backupCodesRemaining: undefined,
      });
    });

    it("should indicate MFA required for admin roles", async () => {
      mockPrisma.mfaEnrollment.findUnique.mockResolvedValue(null);

      const status = await handler.getStatus(
        mockPrisma,
        "user-1",
        "PARTNER_ADMIN",
      );

      expect(status.required).toBe(true);
    });
  });
});
