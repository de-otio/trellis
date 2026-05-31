import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFeatureFlags } from "../../src/lib/feature-flags.js";

// Mock FeatureToggleService
const mockGetToggle = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    getToggle = mockGetToggle;
    constructor(db: any) {}
  },
}));

describe("getFeatureFlags (async)", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {}; // Mock Prisma client
  });

  it("should return defaults when no database provided", async () => {
    const flags = await getFeatureFlags(undefined);

    expect(flags.posts).toBe(false);
    expect(flags.comments).toBe(false);
    expect(flags.entities).toBe(false);
    expect(flags.friends).toBe(false);
    expect(flags.sentiments).toBe(false);
    expect(flags.feeds).toBe(false);
    expect(flags.map).toBe(false);
    expect(mockGetToggle).not.toHaveBeenCalled();
  });

  it("should use toggle value when toggle exists", async () => {
    mockGetToggle.mockResolvedValue({
      key: "posts_enabled",
      enabled: false,
    });

    const flags = await getFeatureFlags(undefined, mockDb);

    expect(flags.posts).toBe(false);
    expect(mockGetToggle).toHaveBeenCalledWith("posts_enabled");
  });

  it("should use default value when toggle does not exist", async () => {
    mockGetToggle.mockResolvedValue(null);

    const flags = await getFeatureFlags(undefined, mockDb);

    // Should use defaults (all false for safety)
    expect(flags.posts).toBe(false);
    expect(flags.comments).toBe(false);
    expect(mockGetToggle).toHaveBeenCalled();
  });

  it("should check all feature flags", async () => {
    mockGetToggle.mockResolvedValue(null);

    await getFeatureFlags(undefined, mockDb);

    expect(mockGetToggle).toHaveBeenCalledWith("posts_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("comments_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("entity_profiles_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("friends_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("sentiments_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("feeds_enabled");
    expect(mockGetToggle).toHaveBeenCalledWith("map_enabled");
  });

  it("should fall back to defaults on error", async () => {
    mockGetToggle.mockRejectedValue(new Error("Database error"));

    const flags = await getFeatureFlags(undefined, mockDb);

    // Should return defaults on error (all false for safety)
    expect(flags.posts).toBe(false);
    expect(flags.comments).toBe(false);
  });

  it("should handle mixed toggle states", async () => {
    // Mock all 7 feature flags - some with values, some null (use defaults)
    mockGetToggle
      .mockResolvedValueOnce({ key: "posts_enabled", enabled: false })
      .mockResolvedValueOnce(null) // Use default for comments (false)
      .mockResolvedValueOnce({ key: "entity_profiles_enabled", enabled: true })
      .mockResolvedValueOnce(null) // Use default for friends (false)
      .mockResolvedValueOnce(null) // Use default for sentiments (false)
      .mockResolvedValueOnce(null) // Use default for feeds (false)
      .mockResolvedValueOnce(null); // Use default for map (false)

    const flags = await getFeatureFlags(undefined, mockDb);

    expect(flags.posts).toBe(false);
    expect(flags.comments).toBe(false); // Default
    expect(flags.entities).toBe(true);
    expect(flags.friends).toBe(false); // Default
    expect(flags.sentiments).toBe(false); // Default
    expect(flags.feeds).toBe(false); // Default
    expect(flags.map).toBe(false); // Default
  });
});
