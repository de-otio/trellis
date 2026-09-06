/**
 * PushDeviceHandler (T8) — registration/deletion business logic.
 *
 * - Upsert keyed on the deterministic SHA-256 tokenHash; token stored AES-GCM
 *   encrypted (round-trips via decryptSecret) and never returned raw.
 * - Reassignment on account switch (update sets userId).
 * - Per-user cap enforced by evicting the stalest rows.
 * - deleteDevice is owner-scoped and reports false for foreign/unknown ids.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    pushDevice: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    release: vi.fn(),
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: vi.fn(() => mockPrisma),
}));

import {
  PushDeviceHandler,
  wireToPlatform,
} from "../../../src/lib/push/push-device-handler.js";
import {
  hashDeviceToken,
  openSecret,
  resolveKeyring,
} from "../../../src/lib/push/token-crypto.js";

const KEY = "test-secret-32-characters-long!!";
const USER = "user-1";
const NOW = new Date("2026-07-05T12:00:00.000Z");

const env = {
  DATABASE_URL: "postgresql://t:t@localhost:5432/t",
  SESSION_SECRET: KEY,
} as unknown as Env;

describe("PushDeviceHandler", () => {
  let handler: PushDeviceHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PushDeviceHandler();
    mockPrisma.release.mockResolvedValue(undefined);
    mockPrisma.pushDevice.findMany.mockResolvedValue([]);
    mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.pushDevice.upsert.mockImplementation(async (args: any) => ({
      id: "dev-1",
      userId: args.create.userId,
      platform: args.create.platform,
      tokenHash: args.create.tokenHash,
      tokenCiphertext: args.create.tokenCiphertext,
      createdAt: NOW,
      lastSeenAt: NOW,
    }));
  });

  describe("registerDevice", () => {
    it("upserts on the deterministic tokenHash and stores the token encrypted", async () => {
      const dto = await handler.registerDevice(USER, "raw-token", "apns", env);

      expect(mockPrisma.pushDevice.upsert).toHaveBeenCalledTimes(1);
      const args = mockPrisma.pushDevice.upsert.mock.calls[0][0];

      // Dedupe key: SHA-256 hex of the raw token, same on every call.
      const expectedHash = await hashDeviceToken("raw-token");
      expect(args.where).toEqual({ tokenHash: expectedHash });
      expect(args.create.tokenHash).toBe(expectedHash);
      expect(args.create.userId).toBe(USER);
      expect(args.create.platform).toBe("APNS");

      // At rest: NOT the raw token; opens back to it under the push keyring
      // (session-derived here — no PUSH_TOKEN_ENC_KEY in this env), and is in
      // the current sealed format, not the legacy raw-key wrap.
      expect(args.create.tokenCiphertext).not.toContain("raw-token");
      expect(args.create.tokenCiphertext.startsWith("h1:")).toBe(true);
      await expect(
        openSecret(args.create.tokenCiphertext, resolveKeyring(env, "push")),
      ).resolves.toBe("raw-token");

      // Reassignment path: the update clause moves ownership + refreshes.
      expect(args.update.userId).toBe(USER);
      expect(args.update.platform).toBe("APNS");
      expect(args.update.lastSeenAt).toBeInstanceOf(Date);

      // DTO shape (contract §2.1) — never echoes the token.
      expect(dto).toEqual({
        id: "dev-1",
        platform: "apns",
        createdAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
      });
      expect(JSON.stringify(dto)).not.toContain("raw-token");
      expect(mockPrisma.release).toHaveBeenCalled();
    });

    it("evicts the stalest rows beyond the per-user cap", async () => {
      mockPrisma.pushDevice.findMany.mockResolvedValue([
        { id: "stale-1" },
        { id: "stale-2" },
      ]);

      await handler.registerDevice(USER, "raw-token", "fcm", env);

      expect(mockPrisma.pushDevice.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["stale-1", "stale-2"] }, userId: USER },
      });
    });

    it("does not delete anything while under the cap", async () => {
      await handler.registerDevice(USER, "raw-token", "web", env);
      expect(mockPrisma.pushDevice.deleteMany).not.toHaveBeenCalled();
    });

    it("releases the client even when the upsert throws", async () => {
      mockPrisma.pushDevice.upsert.mockRejectedValue(new Error("DB error"));
      await expect(
        handler.registerDevice(USER, "raw-token", "apns", env),
      ).rejects.toThrow("DB error");
      expect(mockPrisma.release).toHaveBeenCalled();
    });
  });

  describe("deleteDevice", () => {
    it("deletes an owned device (owner-scoped predicate) and reports true", async () => {
      mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 1 });

      const deleted = await handler.deleteDevice(USER, "dev-1", env);

      expect(deleted).toBe(true);
      expect(mockPrisma.pushDevice.deleteMany).toHaveBeenCalledWith({
        where: { id: "dev-1", userId: USER },
      });
    });

    it("reports false for a foreign or unknown id (route answers 404)", async () => {
      mockPrisma.pushDevice.deleteMany.mockResolvedValue({ count: 0 });
      const deleted = await handler.deleteDevice(USER, "someone-elses", env);
      expect(deleted).toBe(false);
    });
  });

  it("maps every wire platform to its Prisma enum", () => {
    expect(wireToPlatform("apns")).toBe("APNS");
    expect(wireToPlatform("fcm")).toBe("FCM");
    expect(wireToPlatform("web")).toBe("WEB");
  });
});
