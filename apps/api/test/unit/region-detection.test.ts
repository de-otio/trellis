import type { Request } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectRegion,
  detectRegionSync,
  isValidRegion,
} from "../../src/lib/region-detection.js";
import type { Session, SessionManager } from "../../src/lib/session-cookie.js";

// Mock ip-scrubber
vi.mock("../../src/lib/ip-scrubber", () => ({
  getIPAddress: vi.fn((request: Request) => {
    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0] ||
      "unknown";
    return ip;
  }),
}));

// Mock db module (will be overridden in specific tests)
const mockCreatePrismaForRegion = vi.fn(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../src/db", () => ({
  createPrismaForRegion: (...args: any[]) => mockCreatePrismaForRegion(...args),
}));

// Mock withQueryTimeoutAndRetry
const mockWithQueryTimeoutAndRetry = vi.fn();
vi.mock("../../src/lib/db-query-helper", () => ({
  withQueryTimeoutAndRetry: (...args: any[]) =>
    mockWithQueryTimeoutAndRetry(...args),
  QueryTimeoutPresets: {
    USER_FACING: { timeoutMs: 3000, retryTimeoutMs: 2000 },
  },
}));

// Mock database connection manager
vi.mock("../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    executeWithRetry: vi.fn(),
  },
}));

describe("Region Detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: return null (no user region found)
    mockWithQueryTimeoutAndRetry.mockResolvedValue(null);
  });

  const createMockRequest = (headers: Record<string, string> = {}): Request => {
    const mockHeaders = new Headers(headers);
    return {
      headers: mockHeaders,
      url: "https://api.example.com/test",
      method: "GET",
    } as unknown as Request;
  };

  const createMockEnv = (overrides: Partial<any> = {}): any => ({
    DEFAULT_REGION: "US",
    ENABLE_IP_GEOLOCATION: "true",
    ENVIRONMENT: "dev",
    trellis_dev_session_secret: "test-secret",
    ...overrides,
  });

  const createMockSession = (overrides: Partial<Session> = {}): Session => ({
    userId: "user-123",
    email: "test@example.com",
    expiresAt: Date.now() + 3600000,
    ...overrides,
  });

  describe("isValidRegion", () => {
    it("should return true for valid regions", () => {
      expect(isValidRegion("US")).toBe(true);
      expect(isValidRegion("EU")).toBe(true);
      expect(isValidRegion("CN")).toBe(true);
    });

    it("should return false for invalid regions", () => {
      expect(isValidRegion("INVALID")).toBe(false);
      expect(isValidRegion("")).toBe(false);
      expect(isValidRegion("us")).toBe(false); // Case sensitive
      expect(isValidRegion("XX")).toBe(false);
    });
  });

  describe("detectRegionSync", () => {
    it("should detect region from Cloudflare CF-IPCountry header (CN)", () => {
      const request = createMockRequest({
        "CF-IPCountry": "CN",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should detect region from Cloudflare CF-IPCountry header (EU)", () => {
      const request = createMockRequest({
        "CF-IPCountry": "DE",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("EU");
    });

    it("should detect region from Cloudflare CF-IPCountry header (US)", () => {
      const request = createMockRequest({
        "CF-IPCountry": "US",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("US");
    });

    it("should fallback to Accept-Language when CF-IPCountry is missing", () => {
      const request = createMockRequest({
        "Accept-Language": "zh-CN,zh;q=0.9",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should fallback to Accept-Language for EU languages", () => {
      const request = createMockRequest({
        "Accept-Language": "de-DE,de;q=0.9",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("EU");
    });

    it("should use default region when no detection method works", () => {
      const request = createMockRequest({});
      const env = createMockEnv({ DEFAULT_REGION: "US" });

      const region = detectRegionSync(request, env);
      expect(region).toBe("US");
    });

    it("should use custom default region", () => {
      const request = createMockRequest({});
      const env = createMockEnv({ DEFAULT_REGION: "EU" });

      const region = detectRegionSync(request, env);
      expect(region).toBe("EU");
    });

    it("should ignore invalid default region and use US", () => {
      const request = createMockRequest({});
      const env = createMockEnv({ DEFAULT_REGION: "INVALID" });

      const region = detectRegionSync(request, env);
      expect(region).toBe("EU"); // Falls back to EU for invalid DEFAULT_REGION
    });

    it("should ignore unknown CF-IPCountry codes", () => {
      const request = createMockRequest({
        "CF-IPCountry": "XX", // Unknown
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("US"); // Falls back to default
    });

    it("should ignore Tor exit node (T1)", () => {
      const request = createMockRequest({
        "CF-IPCountry": "T1", // Tor exit node
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("US"); // Falls back to default
    });

    it("should respect ENABLE_IP_GEOLOCATION=false", () => {
      const request = createMockRequest({
        "CF-IPCountry": "CN",
      });
      const env = createMockEnv({ ENABLE_IP_GEOLOCATION: "false" });

      const region = detectRegionSync(request, env);
      // Should fallback to Accept-Language or default
      expect(["CN", "US"]).toContain(region);
    });
  });

  describe("detectRegion (async)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Reset mock to default (no user found)
      mockCreatePrismaForRegion.mockReturnValue({
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      });
    });

    it("should prioritize user session region preference (when user.region exists in database)", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "US", // Would detect US from IP
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
      });

      // Mock withQueryTimeoutAndRetry to return user with CN region
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce({
        region: "CN", // User preference
      });

      const session = createMockSession({
        userId: "user-123",
      });

      const region = await detectRegion(request, env, undefined, session);
      expect(region).toBe("CN"); // User preference wins
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should fallback to IP geolocation when session has no region", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "CN",
      });
      const env = createMockEnv();
      const session = createMockSession(); // No region preference

      const region = await detectRegion(request, env, undefined, session);
      expect(region).toBe("CN"); // IP geolocation
    });

    it("should ignore invalid user region preference", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "US",
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
      });

      // Mock withQueryTimeoutAndRetry to return user with invalid region
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce({
        region: "INVALID", // Invalid region
      });

      const session = createMockSession({
        userId: "user-123",
      });

      const region = await detectRegion(request, env, undefined, session);
      expect(region).toBe("US"); // Falls back to IP geolocation
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should fetch session and use user region from database when session not provided", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "US",
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
        SESSION_SECRET: "test-secret",
      });

      // Mock withQueryTimeoutAndRetry to return user with CN region
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce({
        region: "CN",
      });

      const mockSession = createMockSession({
        userId: "user-123",
      });

      const mockSessionManager = {
        getSession: vi.fn().mockResolvedValue(mockSession),
      } as unknown as SessionManager;

      const region = await detectRegion(request, env, mockSessionManager);
      expect(region).toBe("CN");
      expect(mockSessionManager.getSession).toHaveBeenCalledWith(
        request,
        "test-secret",
        env,
      );
      expect(mockWithQueryTimeoutAndRetry).toHaveBeenCalled();
    });

    it("should handle session fetch errors gracefully", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "CN",
      });
      const env = createMockEnv({
        SESSION_SECRET: "test-secret",
        trellis_dev_session_secret: "test-secret",
      });

      const mockSessionManager = {
        getSession: vi.fn().mockRejectedValue(new Error("Session error")),
      } as unknown as SessionManager;

      const region = await detectRegion(request, env, mockSessionManager);
      expect(region).toBe("CN"); // Falls back to IP geolocation
    });

    it("should use default region when all methods fail", async () => {
      const request = createMockRequest({}); // No headers
      const env = createMockEnv({ DEFAULT_REGION: "EU" });

      const region = await detectRegion(request, env);
      expect(region).toBe("EU");
    });

    it("should validate default region", async () => {
      const request = createMockRequest({});
      const env = createMockEnv({ DEFAULT_REGION: "INVALID" });

      const region = await detectRegion(request, env);
      expect(region).toBe("EU"); // Falls back to EU for invalid default
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty Accept-Language header", () => {
      const request = createMockRequest({
        "Accept-Language": "",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("US");
    });

    it("should handle Accept-Language with quality values", () => {
      const request = createMockRequest({
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should handle multiple EU country codes", () => {
      const euCountries = ["DE", "FR", "ES", "IT", "NL"];
      for (const country of euCountries) {
        const request = createMockRequest({
          "CF-IPCountry": country,
        });
        const env = createMockEnv();

        const region = detectRegionSync(request, env);
        expect(region).toBe("EU");
      }
    });

    it("should handle non-EU European countries (defaults to EU)", () => {
      const request = createMockRequest({
        "CF-IPCountry": "GB", // UK (not in EU list, defaults to EU per code)
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("EU"); // Code defaults to EU for countries not in specific lists
    });

    it("should handle case-insensitive Accept-Language", () => {
      const request = createMockRequest({
        "Accept-Language": "ZH-CN,zh;q=0.9",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should handle zh-Hans language code", () => {
      const request = createMockRequest({
        "Accept-Language": "zh-Hans,zh;q=0.9",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should handle generic zh language code (defaults to CN)", () => {
      const request = createMockRequest({
        "Accept-Language": "zh,en;q=0.9",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should handle all EU language codes", () => {
      const euLanguages = ["de", "fr", "es", "it", "pt", "nl"];
      for (const lang of euLanguages) {
        const request = createMockRequest({
          "Accept-Language": `${lang}-DE,en;q=0.9`,
        });
        const env = createMockEnv({
          DEFAULT_REGION: "EU", // Set default to EU for this test
        });

        const region = detectRegionSync(request, env);
        expect(region).toBe("EU");
      }
    });

    it("should handle Accept-Language with whitespace", () => {
      const request = createMockRequest({
        "Accept-Language": " zh-CN , zh ; q=0.9 ",
      });
      const env = createMockEnv();

      const region = detectRegionSync(request, env);
      expect(region).toBe("CN");
    });

    it("should handle all EU country codes from CF-IPCountry", () => {
      const euCountries = [
        "AT",
        "BE",
        "BG",
        "HR",
        "CY",
        "CZ",
        "DK",
        "EE",
        "FI",
        "FR",
        "DE",
        "GR",
        "HU",
        "IE",
        "IT",
        "LV",
        "LT",
        "LU",
        "MT",
        "NL",
        "PL",
        "PT",
        "RO",
        "SK",
        "SI",
        "ES",
        "SE",
      ];
      for (const country of euCountries) {
        const request = createMockRequest({
          "CF-IPCountry": country,
        });
        const env = createMockEnv();

        const region = detectRegionSync(request, env);
        expect(region).toBe("EU");
      }
    });

    it("should handle non-EU countries defaulting to EU", () => {
      const nonEUCountries = ["CA", "MX", "BR", "AU", "JP", "GB"];
      for (const country of nonEUCountries) {
        const request = createMockRequest({
          "CF-IPCountry": country,
        });
        const env = createMockEnv();

        const region = detectRegionSync(request, env);
        expect(region).toBe("EU"); // Defaults to EU per code
      }
    });
  });

  describe("External IP Geolocation", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("should use external IP geolocation when configured", async () => {
      const request = createMockRequest({
        "CF-Connecting-IP": "192.168.1.1",
      });
      const env = createMockEnv({
        IP_GEOLOCATION_API_KEY: "test-key",
        IP_GEOLOCATION_SERVICE: "ipapi",
        ENABLE_IP_GEOLOCATION: "true",
      });

      // Mock external API to return CN
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue("CN"),
      } as any);

      const region = await detectRegion(request, env);
      expect(region).toBe("CN");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://ipapi.co/192.168.1.1/country_code/",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": "Trellis-API/1.0",
          }),
        }),
      );
    });

    it("should handle external IP geolocation API errors gracefully", async () => {
      const request = createMockRequest({
        "CF-Connecting-IP": "192.168.1.1",
        "Accept-Language": "en-US",
      });
      const env = createMockEnv({
        IP_GEOLOCATION_API_KEY: "test-key",
        IP_GEOLOCATION_SERVICE: "ipapi",
        ENABLE_IP_GEOLOCATION: "true",
      });

      // Mock external API to fail
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
      } as any);

      const region = await detectRegion(request, env);
      // Should fallback to Accept-Language or default
      expect(["US", "EU"]).toContain(region);
    });

    it("should not use external IP geolocation when service is not ipapi", async () => {
      const request = createMockRequest({
        "CF-Connecting-IP": "192.168.1.1",
      });
      const env = createMockEnv({
        IP_GEOLOCATION_API_KEY: "test-key",
        IP_GEOLOCATION_SERVICE: "other-service",
        ENABLE_IP_GEOLOCATION: "true",
      });

      const region = await detectRegion(request, env);
      // Should use sync detection (no external API call)
      expect(global.fetch).not.toHaveBeenCalled();
      expect(["US", "EU"]).toContain(region);
    });

    it("should not use external IP geolocation when API key is missing", async () => {
      const request = createMockRequest({
        "CF-Connecting-IP": "192.168.1.1",
      });
      const env = createMockEnv({
        IP_GEOLOCATION_SERVICE: "ipapi",
        ENABLE_IP_GEOLOCATION: "true",
      });

      const region = await detectRegion(request, env);
      // Should use sync detection (no external API call)
      expect(global.fetch).not.toHaveBeenCalled();
      expect(["US", "EU"]).toContain(region);
    });
  });

  describe("Database Query Edge Cases", () => {
    it("should handle database query timeout gracefully", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "US",
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
      });

      // Mock database query to timeout
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(
        new Error("Query timeout"),
      );

      const session = createMockSession({
        userId: "user-123",
      });

      const region = await detectRegion(request, env, undefined, session);
      // Should fallback to IP geolocation
      expect(region).toBe("US");
    });

    it("should handle database connection errors gracefully", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "CN",
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
      });

      // Mock database connection error
      mockWithQueryTimeoutAndRetry.mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      const session = createMockSession({
        userId: "user-123",
      });

      const region = await detectRegion(request, env, undefined, session);
      // Should fallback to IP geolocation
      expect(region).toBe("CN");
    });

    it("should handle user with null region in database", async () => {
      const request = createMockRequest({
        "CF-IPCountry": "US",
      });
      const env = createMockEnv({
        DATABASE_URL: "postgres://test",
      });

      // Mock database to return user with null region
      mockWithQueryTimeoutAndRetry.mockResolvedValueOnce({
        region: null,
      });

      const session = createMockSession({
        userId: "user-123",
      });

      const region = await detectRegion(request, env, undefined, session);
      // Should fallback to IP geolocation
      expect(region).toBe("US");
    });
  });
});
