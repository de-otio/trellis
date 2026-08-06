/**
 * Unit Tests: getPlatformFlags (the `platform` block resolver used by
 * GET /api/feature-flags — evolvability plan §2.2 / T9).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformFlags } from "../../src/lib/feature-flags.js";

const mockGetToggle = vi.fn();
vi.mock("../../src/lib/feature-toggle-service", () => ({
  FeatureToggleService: class {
    getToggle = mockGetToggle;
    constructor(_db: any) {}
  },
}));

describe("getPlatformFlags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all-false defaults when no db is provided", async () => {
    const flags = await getPlatformFlags(undefined);

    expect(flags).toEqual({
      posts: false,
      comments: false,
      friends: false,
      sentiments: false,
      feeds: false,
      map: false,
      events: false,
      collections: false,
      email_subscriptions: false,
      year_in_review: false,
      entity_profiles: false,
    });
    expect(mockGetToggle).not.toHaveBeenCalled();
  });

  it("resolves each key from its GLOBAL toggle value (tenantId undefined)", async () => {
    mockGetToggle.mockImplementation(async (key: string) => {
      if (key === "posts_enabled") return { key, enabled: true };
      if (key === "map_enabled") return { key, enabled: true };
      return null;
    });

    const flags = await getPlatformFlags({} as any);

    expect(flags.posts).toBe(true);
    expect(flags.map).toBe(true);
    // Toggles not mocked to a truthy value fall back to the default (false).
    expect(flags.comments).toBe(false);
    expect(flags.friends).toBe(false);
    expect(flags.sentiments).toBe(false);
    expect(flags.events).toBe(false);
    expect(flags.collections).toBe(false);
    expect(flags.email_subscriptions).toBe(false);
    expect(flags.year_in_review).toBe(false);
    expect(flags.entity_profiles).toBe(false);

    // Global-only resolution: every call passes tenantId=undefined, never a
    // tenant id (this endpoint is unauthenticated / has no tenant context).
    expect(mockGetToggle).toHaveBeenCalledWith("posts_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("comments_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("friends_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("sentiments_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("feeds_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("map_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("events_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith("collections_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith(
      "email_subscriptions_enabled",
      undefined,
    );
    expect(mockGetToggle).toHaveBeenCalledWith("year_in_review_enabled", undefined);
    expect(mockGetToggle).toHaveBeenCalledWith(
      "entity_profiles_enabled",
      undefined,
    );
  });

  it("defaults missing (null) toggles to false rather than throwing", async () => {
    mockGetToggle.mockResolvedValue(null);

    const flags = await getPlatformFlags({} as any);

    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });

  it("falls back to all-false defaults when the toggle service throws", async () => {
    mockGetToggle.mockRejectedValue(new Error("db unavailable"));

    const flags = await getPlatformFlags({} as any);

    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });
});
