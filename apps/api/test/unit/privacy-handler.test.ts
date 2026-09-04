/**
 * Unit Tests: Privacy Handler
 *
 * Tests for GDPR-compliant privacy preferences management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrivacyHandler,
  PrivacyPreferencesUnavailableError,
  type Env,
  type PrivacyPreferences,
} from "../../src/lib/privacy-handler.js";
import type { Session } from "../../src/lib/session-cookie.js";

// Mock UserDeprovisioning
const mockSuspendUser = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/user-deprovisioning", () => ({
  UserDeprovisioning: class {
    suspendUser = mockSuspendUser;
  },
}));


describe("PrivacyHandler", () => {
  let handler: PrivacyHandler;
  let mockEnv: Env;
  let mockSession: Session;
  let mockPrivacyPreferencesKV: any;

  beforeEach(() => {
    vi.clearAllMocks();

    handler = new PrivacyHandler();

    mockSession = {
      userId: "user123",
      email: "test@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3600000,
      sessionType: "user",
      lastActivityAt: Date.now(),
    };

    mockPrivacyPreferencesKV = {
      get: vi.fn(),
      put: vi.fn(),
    };

    mockEnv = {
      PRIVACY_PREFERENCES_KV: mockPrivacyPreferencesKV,
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    };
  });

  describe("getPreferences", () => {
    it("should return preferences from KV", async () => {
      const preferences: PrivacyPreferences = {
        hasOptedOutTracking: true,
        hasOptedOutProcessing: false,
        hasOptedOutEmail: true,
        profilePrivacy: "Private",
        postVisibility: "private",
      };

      mockPrivacyPreferencesKV.get.mockResolvedValue(preferences);

      const result = await handler.getPreferences(mockSession, mockEnv);

      expect(result).toEqual(preferences);
      expect(mockPrivacyPreferencesKV.get).toHaveBeenCalledWith(
        "privacy:user123",
        "json",
      );
    });

    it("should return null if preferences not found", async () => {
      mockPrivacyPreferencesKV.get.mockResolvedValue(null);

      const result = await handler.getPreferences(mockSession, mockEnv);

      expect(result).toBeNull();
    });

    it("should return null if KV not configured", async () => {
      delete mockEnv.PRIVACY_PREFERENCES_KV;

      const result = await handler.getPreferences(mockSession, mockEnv);

      expect(result).toBeNull();
    });

    // REVERSED. This used to assert `null` on a store error — the same value
    // returned when a user genuinely has no preferences. That collapse is the
    // defect: it converts "we cannot tell what you chose" into "you chose
    // nothing", and the client then applies defaults over the user's actual
    // privacy settings.
    it("throws rather than reporting 'no preferences' when the store errors", async () => {
      mockPrivacyPreferencesKV.get.mockRejectedValue(new Error("KV error"));

      await expect(
        handler.getPreferences(mockSession, mockEnv),
      ).rejects.toBeInstanceOf(PrivacyPreferencesUnavailableError);
    });

    it("still reports null when NO store is wired at all", async () => {
      // Absence is a deployment shape, not a malfunction: with no store, no
      // preferences exist and defaults are the correct answer. Only failure
      // is ambiguous.
      const result = await handler.getPreferences(mockSession, {} as any);

      expect(result).toBeNull();
    });
  });

  describe("updatePreferences", () => {
    const validPreferences: PrivacyPreferences = {
      hasOptedOutTracking: true,
      hasOptedOutProcessing: false,
      hasOptedOutEmail: true,
      profilePrivacy: "Private",
      postVisibility: "private",
    };

    it("should update preferences successfully", async () => {
      await handler.updatePreferences(mockSession, validPreferences, mockEnv);

      expect(mockPrivacyPreferencesKV.put).toHaveBeenCalledWith(
        "privacy:user123",
        JSON.stringify(validPreferences),
      );
    });

    it("should throw error for invalid preferences - missing fields", async () => {
      const invalidPreferences = {
        hasOptedOutTracking: true,
        // Missing other required fields
      } as any;

      await expect(
        handler.updatePreferences(mockSession, invalidPreferences, mockEnv),
      ).rejects.toThrow("Invalid privacy preferences");
    });

    it("should throw error for invalid preferences - wrong types", async () => {
      const invalidPreferences = {
        hasOptedOutTracking: "true", // Should be boolean
        hasOptedOutProcessing: false,
        hasOptedOutEmail: true,
        profilePrivacy: "Private",
        postVisibility: "private",
      } as any;

      await expect(
        handler.updatePreferences(mockSession, invalidPreferences, mockEnv),
      ).rejects.toThrow("Invalid privacy preferences");
    });

    it("should throw error for invalid profilePrivacy", async () => {
      const invalidPreferences = {
        ...validPreferences,
        profilePrivacy: "Invalid" as any,
      };

      await expect(
        handler.updatePreferences(mockSession, invalidPreferences, mockEnv),
      ).rejects.toThrow("Invalid privacy preferences");
    });

    it("should throw error for invalid postVisibility", async () => {
      const invalidPreferences = {
        ...validPreferences,
        postVisibility: "invalid" as any,
      };

      await expect(
        handler.updatePreferences(mockSession, invalidPreferences, mockEnv),
      ).rejects.toThrow("Invalid privacy preferences");
    });

    it("should work without KV (graceful degradation)", async () => {
      delete mockEnv.PRIVACY_PREFERENCES_KV;

      // Should not throw, but also won't store
      await handler.updatePreferences(mockSession, validPreferences, mockEnv);
    });

    it("should throw error if KV put fails", async () => {
      mockPrivacyPreferencesKV.put.mockRejectedValue(
        new Error("KV write error"),
      );

      await expect(
        handler.updatePreferences(mockSession, validPreferences, mockEnv),
      ).rejects.toThrow("KV write error");
    });
  });

  describe("handleGetPreferences", () => {
    it("should return preferences as JSON", async () => {
      const preferences: PrivacyPreferences = {
        hasOptedOutTracking: true,
        hasOptedOutProcessing: false,
        hasOptedOutEmail: true,
        profilePrivacy: "Public",
        postVisibility: "public",
      };

      mockPrivacyPreferencesKV.get.mockResolvedValue(preferences);

      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetPreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(preferences);
    });

    it("should return 404 if preferences not found", async () => {
      mockPrivacyPreferencesKV.get.mockResolvedValue(null);

      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetPreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("Preferences not found");
    });

    // REVERSED. The old name and its comment ("getPreferences returns null on
    // error, which causes 404") described the defect precisely and asserted it
    // as correct. A 404 on this endpoint means "you have no preferences", which
    // a client acts on by applying defaults — so a store outage silently
    // overrode every user's privacy settings, with a 404 and no error anywhere.
    it("returns 503, NOT 404, when the store errors", async () => {
      mockPrivacyPreferencesKV.get.mockRejectedValue(new Error("KV error"));

      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "GET",
        },
      );

      const response = await handler.handleGetPreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe("PREFERENCES_UNAVAILABLE");
    });

    it("offers Retry-After on the 503 so clients back off instead of defaulting", async () => {
      mockPrivacyPreferencesKV.get.mockRejectedValue(new Error("KV error"));

      const response = await handler.handleGetPreferences(
        new Request("https://api.example.com/api/privacy/preferences"),
        mockSession,
        mockEnv,
      );

      expect(response.headers.get("retry-after")).toBe("30");
    });

    it("keeps 404 for a user who genuinely has no preferences", async () => {
      // The distinction the 503 exists to preserve — absent must stay 404.
      mockPrivacyPreferencesKV.get.mockResolvedValue(null);

      const response = await handler.handleGetPreferences(
        new Request("https://api.example.com/api/privacy/preferences"),
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(404);
    });
  });

  describe("handleUpdatePreferences", () => {
    const validPreferences: PrivacyPreferences = {
      hasOptedOutTracking: true,
      hasOptedOutProcessing: false,
      hasOptedOutEmail: true,
      profilePrivacy: "Followers",
      postVisibility: "friends-only",
    };

    it("should update preferences successfully", async () => {
      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validPreferences),
        },
      );

      const response = await handler.handleUpdatePreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(mockPrivacyPreferencesKV.put).toHaveBeenCalled();
    });

    it("should return 400 for invalid preferences", async () => {
      const invalidPreferences = {
        hasOptedOutTracking: "invalid",
      };

      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invalidPreferences),
        },
      );

      const response = await handler.handleUpdatePreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Invalid privacy preferences");
    });

    it("should return 400 on error", async () => {
      mockPrivacyPreferencesKV.put.mockRejectedValue(
        new Error("KV write error"),
      );

      const request = new Request(
        "https://api.example.com/api/privacy/preferences",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validPreferences),
        },
      );

      const response = await handler.handleUpdatePreferences(
        request,
        mockSession,
        mockEnv,
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("KV write error");
    });
  });

});
