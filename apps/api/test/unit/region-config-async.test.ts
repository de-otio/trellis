import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFeatureFlagsAsync } from "../../src/lib/region-config.js";
import type { Env } from "../../src/lib/region-config.js";

// Mock FeatureToggleService
const mockGetToggle = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    getToggle = mockGetToggle;
    constructor(db: any) {}
  },
}));

describe("getFeatureFlagsAsync", () => {
  let mockEnv: Env;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      DEFAULT_REGION: "US",
      US_API_ENDPOINT: "https://api.example.com",
      US_FRONTEND_ENDPOINT: "https://app.example.com",
      US_CDN_ENDPOINT: "https://cdn.example.com",
    };
    mockDb = {}; // Mock Prisma client
  });

  it("should return base flags when no database provided", async () => {
    const flags = await getFeatureFlagsAsync("US", mockEnv);

    expect(flags.authentication.emailPassword).toBe(false); // Regular users use magic link
    expect(flags.authentication.magicLink).toBe(true);
    expect(flags.authentication.microsoftSSO).toBe(true);
    expect(mockGetToggle).not.toHaveBeenCalled();
  });

  it("should use toggle value when toggle exists", async () => {
    mockGetToggle.mockResolvedValue({
      key: "region_US_auth_magic_link",
      enabled: false,
    });

    const flags = await getFeatureFlagsAsync("US", mockEnv, mockDb);

    expect(flags.authentication.magicLink).toBe(false);
    expect(mockGetToggle).toHaveBeenCalledWith("region_US_auth_magic_link");
  });

  it("should use default value when toggle does not exist", async () => {
    mockGetToggle.mockResolvedValue(null);

    const flags = await getFeatureFlagsAsync("US", mockEnv, mockDb);

    // Should use default (true for magicLink in US)
    expect(flags.authentication.magicLink).toBe(true);
    expect(mockGetToggle).toHaveBeenCalled();
  });

  it("should check all authentication flags for region", async () => {
    mockGetToggle.mockResolvedValue(null);

    await getFeatureFlagsAsync("CN", mockEnv, mockDb);

    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_email_password");
    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_magic_link");
    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_phone");
    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_wechat");
    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_qq");
    expect(mockGetToggle).toHaveBeenCalledWith("region_CN_auth_microsoft_sso");
  });

  it("should check application feature flags", async () => {
    mockGetToggle.mockResolvedValue(null);

    await getFeatureFlagsAsync("US", mockEnv, mockDb);

    expect(mockGetToggle).toHaveBeenCalledWith("region_US_app_offline_mode");
    expect(mockGetToggle).toHaveBeenCalledWith(
      "region_US_app_realtime_updates",
    );
    expect(mockGetToggle).toHaveBeenCalledWith(
      "region_US_app_push_notifications",
    );
  });

  it("should check performance flags", async () => {
    mockGetToggle.mockResolvedValue(null);

    await getFeatureFlagsAsync("US", mockEnv, mockDb);

    expect(mockGetToggle).toHaveBeenCalledWith(
      "region_US_perf_extended_timeouts",
    );
    expect(mockGetToggle).toHaveBeenCalledWith(
      "region_US_perf_aggressive_caching",
    );
    expect(mockGetToggle).toHaveBeenCalledWith(
      "region_US_perf_request_batching",
    );
  });

  it("should always enable security flags", async () => {
    mockGetToggle.mockResolvedValue({ key: "test", enabled: false });

    const flags = await getFeatureFlagsAsync("US", mockEnv, mockDb);

    // Security flags should always be enabled
    expect(flags.security.encryption).toBe(true);
    expect(flags.security.rateLimiting).toBe(true);
    expect(flags.security.auditLogging).toBe(true);
    expect(flags.security.regionValidation).toBe(true);
  });

  it("should fall back to base config on error", async () => {
    mockGetToggle.mockRejectedValue(new Error("Database error"));

    const flags = await getFeatureFlagsAsync("US", mockEnv, mockDb);

    // Should return base config on error
    expect(flags.authentication.emailPassword).toBe(false); // Regular users use magic link
    expect(flags.authentication.magicLink).toBe(true);
  });

  it("should handle mixed toggle states", async () => {
    // Mock all required toggles - some with values, some null (use defaults)
    mockGetToggle
      .mockResolvedValueOnce({
        key: "region_US_auth_email_password",
        enabled: true,
      })
      .mockResolvedValueOnce({
        key: "region_US_auth_magic_link",
        enabled: false,
      })
      .mockResolvedValueOnce(null) // Use default for phoneAuth (false in US)
      .mockResolvedValueOnce(null) // Use default for weChatAuth (false in US)
      .mockResolvedValueOnce(null) // Use default for qqAuth (false in US)
      .mockResolvedValueOnce({
        key: "region_US_auth_microsoft_sso",
        enabled: true,
      })
      .mockResolvedValueOnce(null) // app_offline_mode
      .mockResolvedValueOnce(null) // app_realtime_updates
      .mockResolvedValueOnce(null) // app_push_notifications
      .mockResolvedValueOnce(null) // perf_extended_timeouts
      .mockResolvedValueOnce(null) // perf_aggressive_caching
      .mockResolvedValueOnce(null); // perf_request_batching

    const flags = await getFeatureFlagsAsync("US", mockEnv, mockDb);

    expect(flags.authentication.magicLink).toBe(false);
    expect(flags.authentication.phoneAuth).toBe(false); // Default for US
    expect(flags.authentication.weChatAuth).toBe(false); // Default for US
  });
});
