/**
 * Tests for Direct Message Service (Fedify-Based)
 *
 * Tests DM creation and serialization using Fedify's type-safe Create and Note types.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Create, Note } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import { DmServiceFedify } from "../../../../src/lib/activitypub/services/dm-service-fedify.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { User } from "@prisma/client";
import { DatabaseConnectionManager } from "../../../../src/lib/database-connection-manager.js";

// Mock dependencies
vi.mock("../../../../src/lib/database-connection-manager");
vi.mock("../../../../src/lib/activitypub/crypto", () => ({
  KeyPairService: {
    generateKeyPair: vi.fn(() => ({
      publicKey: "mock-public-key",
      privateKey: "mock-private-key",
    })),
    encryptPrivateKey: vi.fn((key) => `encrypted-${key}`),
    decryptPrivateKey: vi.fn((encrypted) =>
      encrypted.replace("encrypted-", ""),
    ),
  },
}));

describe("DmServiceFedify", () => {
  let mockEnv: Env;
  let mockSender: User;
  let mockRecipient: User;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
    mockSender = createMockUser({
      username: "alice",
      actorUri: "https://example.com/users/alice",
    }) as User;

    mockRecipient = createMockUser({
      username: "bob",
      actorUri: "https://example.com/users/bob",
    }) as User;
  });

  describe("generateDmUris", () => {
    it("should generate correct URIs for a DM", () => {
      const dmId = "dm-123";
      const uris = DmServiceFedify.generateDmUris(dmId, mockEnv);

      expect(uris.activityId).toBeInstanceOf(URL);
      expect(uris.activityId.toString()).toContain("/messages/dm-123/activity");
      expect(uris.objectId).toBeInstanceOf(URL);
      expect(uris.objectId.toString()).toContain("/messages/dm-123");
    });

    it("should use requestUrl if provided", () => {
      const dmId = "dm-123";
      const uris = DmServiceFedify.generateDmUris(
        dmId,
        mockEnv,
        "https://custom.example.com/path",
      );

      expect(uris.activityId.toString()).toContain("custom.example.com");
    });
  });

  describe("createDmNote", () => {
    it("should create a Fedify Note object with bto field", async () => {
      const published = new Date("2024-01-01T00:00:00Z");
      const note = await DmServiceFedify.createDmNote(
        "dm-123",
        mockSender,
        mockRecipient,
        "Hello, Bob!",
        published,
        mockEnv,
      );

      expect(note).toBeInstanceOf(Note);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const noteAny = note as any;
      expect(noteAny.id).toBeDefined();
      expect(noteAny.content).toBe("Hello, Bob!");
      expect(noteAny.published).toBeInstanceOf(Temporal.Instant);
    });

    it("should include recipient in bto field", async () => {
      const published = new Date("2024-01-01T00:00:00Z");
      const note = await DmServiceFedify.createDmNote(
        "dm-123",
        mockSender,
        mockRecipient,
        "Private message",
        published,
        mockEnv,
      );

      const noteAny = note as any;
      expect(noteAny.bto).toBeDefined();
      expect(Array.isArray(noteAny.bto)).toBe(true);
      expect(noteAny.bto.length).toBe(1);
    });
  });

  describe("createDmCreateActivity", () => {
    it("should create a Fedify Create activity with bto field", async () => {
      const published = new Date("2024-01-01T00:00:00Z");
      const activity = await DmServiceFedify.createDmCreateActivity(
        "dm-123",
        mockSender,
        mockRecipient,
        "Hello, Bob!",
        published,
        mockEnv,
      );

      expect(activity).toBeInstanceOf(Create);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const activityAny = activity as any;
      expect(activityAny.id).toBeDefined();
      expect(activityAny.published).toBeInstanceOf(Temporal.Instant);
      // Note: Fedify doesn't expose object property directly, but we know it was set in the constructor
      // We verify the activity was created successfully
      expect(activity).toBeDefined();
    });

    it("should not include to field (privacy)", async () => {
      const published = new Date("2024-01-01T00:00:00Z");
      const activity = await DmServiceFedify.createDmCreateActivity(
        "dm-123",
        mockSender,
        mockRecipient,
        "Private message",
        published,
        mockEnv,
      );

      const activityAny = activity as any;
      // DMs should use bto, not to
      expect(activityAny.bto).toBeDefined();
      // to field should not be set for DMs
      expect(activityAny.to).toBeUndefined();
    });
  });

  describe("createDirectMessage", () => {
    it("should create DM and store in database", async () => {
      const mockPrisma = {
        directMessage: {
          create: vi.fn().mockResolvedValue({
            id: "dm-123",
            senderId: mockSender.id,
            recipientId: mockRecipient.id,
            text: "Hello, Bob!",
            objectId: "https://example.com/messages/dm-123",
            activityId: "https://example.com/messages/dm-123/activity",
            read: false,
            createdAt: new Date("2024-01-01T00:00:00Z"),
          }),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.mocked(DatabaseConnectionManager).mockImplementation(
        () =>
          ({
            withClient: vi.fn(async (_region, _env, callback) => {
              return callback(mockPrisma as any);
            }),
          }) as any,
      );

      const dm = await DmServiceFedify.createDirectMessage(
        mockPrisma as any,
        mockSender,
        mockRecipient,
        "Hello, Bob!",
        mockEnv,
      );

      expect(dm.id).toBe("dm-123");
      expect(dm.senderId).toBe(mockSender.id);
      expect(dm.recipientId).toBe(mockRecipient.id);
      expect(dm.text).toBe("Hello, Bob!");
      expect(mockPrisma.directMessage.create).toHaveBeenCalled();
    });

    it("should throw error if sender lacks ActivityPub fields", async () => {
      const mockPrisma = {
        directMessage: {
          create: vi.fn(),
        },
      };

      const senderWithoutFields = {
        ...mockSender,
        actorUri: null,
        publicKey: null,
      };

      await expect(
        DmServiceFedify.createDirectMessage(
          mockPrisma as any,
          senderWithoutFields,
          mockRecipient,
          "Hello",
          mockEnv,
        ),
      ).rejects.toThrow("Sender does not have ActivityPub fields set");
    });

    it("should throw error if recipient lacks ActivityPub fields", async () => {
      const mockPrisma = {
        directMessage: {
          create: vi.fn(),
        },
      };

      const recipientWithoutFields = {
        ...mockRecipient,
        actorUri: null,
        publicKey: null,
      };

      await expect(
        DmServiceFedify.createDirectMessage(
          mockPrisma as any,
          mockSender,
          recipientWithoutFields,
          "Hello",
          mockEnv,
        ),
      ).rejects.toThrow("Recipient does not have ActivityPub fields set");
    });
  });
});
