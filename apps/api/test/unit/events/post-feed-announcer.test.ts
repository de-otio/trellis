/**
 * Unit tests: PostFeedAnnouncer (events primitive, Phase 2 DI seam).
 *
 * Verifies the visibility→radius mapping (SEC-2), the GROUP_ONLY "no companion
 * post" rule, the precision-filtered location→geoData mapping (SEC-6), and the
 * best-effort update/retract no-op + error-swallow contract — all against a
 * mocked PostHandler system-post seam. Also exercises seams.ts's pure
 * `planCompanionPost` / `precisionFilteredLocation` through the announcer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createSystemPost = vi.fn(async () => ({ postId: "post-1" }));
const updateSystemPost = vi.fn(async () => {});
const retractSystemPost = vi.fn(async () => {});
vi.mock("../../../src/lib/post-handler", () => ({
  PostHandler: class {
    createSystemPost = createSystemPost;
    updateSystemPost = updateSystemPost;
    retractSystemPost = retractSystemPost;
  },
}));

import { PostFeedAnnouncer } from "../../../src/lib/events/post-feed-announcer.js";
import type { EventAnnouncementInput } from "../../../src/lib/events/seams.js";

const env = { DEFAULT_REGION: "EU", ACTIVITYPUB_BASE_URL: "https://social.example" } as any;

function input(overrides: Partial<EventAnnouncementInput> = {}): EventAnnouncementInput {
  return {
    eventId: "ev1",
    tenantId: "t1",
    creatorId: "u1",
    visibility: "PUBLIC",
    title: "Cleanup Day",
    description: "Bring gloves",
    startsAt: "2026-08-01T09:00:00.000Z",
    timezone: "Europe/Berlin",
    location: {
      precision: "EXACT",
      locationName: "Riverbank",
      lat: 52.5,
      lng: 13.4,
      displayLat: 52.49,
      displayLng: 13.39,
    },
    announcePostId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("announce", () => {
  it("PUBLIC → creates a companion post at radius SHOUT and returns its id", async () => {
    const id = await new PostFeedAnnouncer().announce(input({ visibility: "PUBLIC" }), env);
    expect(id).toBe("post-1");
    expect(createSystemPost).toHaveBeenCalledOnce();
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.radius).toBe("SHOUT");
    expect(arg.authorId).toBe("u1");
    expect(arg.tenantId).toBe("t1");
    expect(arg.region).toBe("EU");
    // EXACT precision → true coordinates flow into geoData.
    expect(arg.geoData).toEqual({ lat: 52.5, lng: 13.4, place: "Riverbank" });
    expect(arg.text).toContain("Cleanup Day");
    expect(arg.text).toContain("Riverbank");
  });

  it("TENANT_ONLY → radius NORMAL", async () => {
    await new PostFeedAnnouncer().announce(input({ visibility: "TENANT_ONLY" }), env);
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.radius).toBe("NORMAL");
  });

  it("GROUP_ONLY → NO companion post (returns null, seam not called)", async () => {
    const id = await new PostFeedAnnouncer().announce(input({ visibility: "GROUP_ONLY" }), env);
    expect(id).toBeNull();
    expect(createSystemPost).not.toHaveBeenCalled();
  });

  it("NEIGHBORHOOD precision → fuzzed display coords in geoData", async () => {
    await new PostFeedAnnouncer().announce(
      input({
        location: {
          precision: "NEIGHBORHOOD",
          locationName: "Mitte",
          lat: 52.5,
          lng: 13.4,
          displayLat: 52.49,
          displayLng: 13.39,
        },
      }),
      env,
    );
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.geoData).toEqual({ lat: 52.49, lng: 13.39, place: "Mitte" });
  });

  it("CITY precision → label only, no geoData coordinates", async () => {
    await new PostFeedAnnouncer().announce(
      input({
        location: {
          precision: "CITY",
          locationName: "Berlin",
          lat: 52.5,
          lng: 13.4,
          displayLat: null,
          displayLng: null,
        },
      }),
      env,
    );
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.geoData).toBeUndefined();
    expect(arg.text).toContain("Berlin");
  });

  it("HIDDEN precision → no location line, no geoData", async () => {
    await new PostFeedAnnouncer().announce(
      input({
        location: {
          precision: "HIDDEN",
          locationName: "Secret",
          lat: 52.5,
          lng: 13.4,
          displayLat: null,
          displayLng: null,
        },
      }),
      env,
    );
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.geoData).toBeUndefined();
    expect(arg.text).not.toContain("Secret");
  });

  it("no description → body omits the description block", async () => {
    await new PostFeedAnnouncer().announce(input({ description: null }), env);
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.text).toContain("Cleanup Day");
  });

  it("falls back to default region/baseUrl when env omits them", async () => {
    await new PostFeedAnnouncer().announce(input(), {} as any);
    const [arg] = createSystemPost.mock.calls[0] as any[];
    expect(arg.region).toBe("EU");
    expect(arg.baseUrl).toBe("");
  });
});

describe("update", () => {
  it("with an announcePostId → updates the companion post", async () => {
    await new PostFeedAnnouncer().update(input({ announcePostId: "post-1" }), env);
    expect(updateSystemPost).toHaveBeenCalledOnce();
    const [postId, text] = updateSystemPost.mock.calls[0] as any[];
    expect(postId).toBe("post-1");
    expect(text).toContain("Cleanup Day");
  });

  it("no announcePostId → no-op", async () => {
    await new PostFeedAnnouncer().update(input({ announcePostId: null }), env);
    expect(updateSystemPost).not.toHaveBeenCalled();
  });

  it("swallows a seam error (best-effort, never throws)", async () => {
    updateSystemPost.mockRejectedValueOnce(new Error("boom"));
    await expect(
      new PostFeedAnnouncer().update(input({ announcePostId: "post-1" }), env),
    ).resolves.toBeUndefined();
  });
});

describe("retract", () => {
  it("with an announcePostId → retracts the companion post", async () => {
    await new PostFeedAnnouncer().retract(input({ announcePostId: "post-1" }), env);
    expect(retractSystemPost).toHaveBeenCalledWith("post-1", env);
  });

  it("no announcePostId → no-op", async () => {
    await new PostFeedAnnouncer().retract(input({ announcePostId: null }), env);
    expect(retractSystemPost).not.toHaveBeenCalled();
  });

  it("swallows a seam error (best-effort, never throws)", async () => {
    retractSystemPost.mockRejectedValueOnce(new Error("boom"));
    await expect(
      new PostFeedAnnouncer().retract(input({ announcePostId: "post-1" }), env),
    ).resolves.toBeUndefined();
  });
});
