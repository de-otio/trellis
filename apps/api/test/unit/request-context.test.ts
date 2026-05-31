import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRequestContext,
  createRequestContextSync,
  addRegionHeaders,
  addRegionHeadersAsync,
  type TrellisRequestContext,
} from "../../src/lib/request-context.js";
import type { TrellisRequestContextEnv } from "../../src/lib/request-context.js";
import type { SessionManager, Session } from "../../src/lib/session-cookie.js";

// Mock region-detection
vi.mock("../../src/lib/region-detection", () => {
  const mockDetectRegion = vi.fn(async (request: Request, env: any) => {
    const country = request.headers.get("CF-IPCountry");
    if (country === "CN") return "CN";
    if (country === "DE") return "EU";
    return "US";
  });
  const mockDetectRegionSync = vi.fn((request: Request, env: any) => {
    const country = request.headers.get("CF-IPCountry");
    if (country === "CN") return "CN";
    if (country === "DE") return "EU";
    return "US";
  });
  const mockIsValidRegion = vi.fn((region: string) =>
    ["US", "EU", "CN"].includes(region),
  );

  return {
    detectRegion: mockDetectRegion,
    detectRegionSync: mockDetectRegionSync,
    isValidRegion: mockIsValidRegion,
    RegionDetector: class RegionDetector {
      constructor(env: any) {}
      detectRegion = mockDetectRegion;
      detectRegionSync = mockDetectRegionSync;
      isValidRegion = mockIsValidRegion;
    },
  };
});

// Mock region-config
vi.mock("../../src/lib/region-config", () => {
  const mockGetRegionConfig = vi.fn((region: string) => ({
    region,
    features: {
      authentication: { emailPassword: true },
      features: { offlineMode: false },
      performance: { extendedTimeouts: false },
      security: {
        encryption: true,
        rateLimiting: true,
        auditLogging: true,
        regionValidation: true,
      },
    },
    endpoints: {
      api: "https://api.example.com",
      frontend: "https://www.example.com",
      cdn: "https://cdn.example.com",
    },
    timeouts: { api: 10000, database: 5000, storage: 5000 },
  }));

  return {
    getRegionConfig: mockGetRegionConfig,
    RegionConfigManager: class RegionConfigManager {
      constructor(env: any) {}
      getRegionConfig = mockGetRegionConfig;
    },
  };
});

describe("Request Context", () => {
  const createMockRequest = (headers: Record<string, string> = {}): Request => {
    const mockHeaders = new Headers(headers);
    return {
      headers: mockHeaders,
      url: "https://api.example.com/test",
      method: "GET",
    } as unknown as Request;
  };

  const createMockEnv = (
    overrides: Partial<TrellisRequestContextEnv> = {},
  ): TrellisRequestContextEnv => ({
    DEFAULT_REGION: "US",
    ...overrides,
  });

  describe("createRequestContextSync", () => {
    it("should create request context synchronously", () => {
      const request = createMockRequest({ "CF-IPCountry": "CN" });
      const env = createMockEnv();
      const context = createRequestContextSync(request, env);

      expect(context.region).toBe("CN");
      expect(context.config).toBeDefined();
      expect(context.config.region).toBe("CN");
    });

    it("should default to US when no country header", () => {
      const request = createMockRequest({});
      const env = createMockEnv();
      const context = createRequestContextSync(request, env);

      expect(context.region).toBe("US");
    });
  });

  describe("createRequestContext", () => {
    it("should create request context asynchronously", async () => {
      const request = createMockRequest({ "CF-IPCountry": "CN" });
      const env = createMockEnv();
      const context = await createRequestContext(request, env);

      expect(context.region).toBe("CN");
      expect(context.config).toBeDefined();
      expect(context.config.region).toBe("CN");
    });

    it("should include session if provided", async () => {
      const request = createMockRequest({ "CF-IPCountry": "US" });
      const env = createMockEnv();
      const session: Session = {
        userId: "user-123",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      };
      const context = await createRequestContext(
        request,
        env,
        undefined,
        session,
      );

      expect(context.region).toBe("US");
      expect(context.session).toBe(session);
    });
  });

  describe("addRegionHeaders", () => {
    it("should add region headers to response", () => {
      const context: TrellisRequestContext = {
        region: "CN",
        config: {
          region: "CN",
          features: {
            authentication: {
              emailPassword: true,
              magicLink: false,
              phoneAuth: true,
              weChatAuth: true,
              qqAuth: false,
              microsoftSSO: false,
            },
            features: {
              offlineMode: true,
              realTimeUpdates: false,
              pushNotifications: false,
            },
            performance: {
              extendedTimeouts: true,
              aggressiveCaching: true,
              requestBatching: true,
            },
            security: {
              encryption: true,
              rateLimiting: true,
              auditLogging: true,
              regionValidation: true,
            },
          },
          endpoints: {
            api: "https://api-cn.example.com",
            frontend: "https://www-cn.example.com",
            cdn: "https://cdn-cn.example.com",
          },
          timeouts: { api: 30000, database: 20000, storage: 20000 },
        },
      };
      const response = new Response("test", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

      const newResponse = addRegionHeaders(response, context);

      expect(newResponse.headers.get("X-Region")).toBe("CN");
      expect(newResponse.headers.get("X-Region-Detected")).toBe("CN");
    });
  });

  describe("addRegionHeadersAsync", () => {
    it("should add region headers to response asynchronously", async () => {
      const context: TrellisRequestContext = {
        region: "EU",
        config: {
          region: "EU",
          features: {
            authentication: {
              emailPassword: true,
              magicLink: true,
              phoneAuth: false,
              weChatAuth: false,
              qqAuth: false,
              microsoftSSO: true,
            },
            features: {
              offlineMode: false,
              realTimeUpdates: true,
              pushNotifications: true,
            },
            performance: {
              extendedTimeouts: false,
              aggressiveCaching: false,
              requestBatching: false,
            },
            security: {
              encryption: true,
              rateLimiting: true,
              auditLogging: true,
              regionValidation: true,
            },
          },
          endpoints: {
            api: "https://api-eu.example.com",
            frontend: "https://www-eu.example.com",
            cdn: "https://cdn-eu.example.com",
          },
          timeouts: { api: 10000, database: 5000, storage: 5000 },
        },
      };
      const response = new Response("test body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

      const newResponse = await addRegionHeadersAsync(response, context);

      expect(newResponse.headers.get("X-Region")).toBe("EU");
      expect(newResponse.headers.get("X-Region-Detected")).toBe("EU");
      const body = await newResponse.text();
      expect(body).toBe("test body");
    });
  });
});
