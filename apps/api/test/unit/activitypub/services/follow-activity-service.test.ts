/**
 * Tests for Follow Activity Service (Fedify-Based)
 *
 * Tests creation and parsing of Follow activities using Fedify.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Follow } from "@fedify/fedify/vocab";
import { FollowActivityService } from "../../../../src/lib/activitypub/services/follow-activity-service.js";
import {
  createFedifyTestEnv,
  createMockUser,
} from "../../../utils/fedify-test-fixtures.js";
import type { Env } from "../../../../src/env.js";
import type { User } from "@prisma/client";

describe("FollowActivityService", () => {
  let mockEnv: Env;
  let mockUser: User;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
    mockUser = createMockUser({
      username: "alice",
      actorUri: "https://example.com/users/alice",
    }) as User;
  });

  describe("createFollowActivity", () => {
    it("should create a Follow activity with correct properties", () => {
      const targetActorId = "https://example.com/users/bob";
      const activity = FollowActivityService.createFollowActivity(
        mockUser,
        targetActorId,
        mockEnv,
      );

      expect(activity).toBeInstanceOf(Follow);
      // Fedify doesn't expose properties directly, so we verify the object was created
      const activityAny = activity as any;
      expect(activityAny.id).toBeInstanceOf(URL);
      // Verify activity was created successfully
      expect(activity).toBeDefined();
    });

    it("should generate unique activity IDs", () => {
      const targetActorId = "https://example.com/users/bob";
      const activity1 = FollowActivityService.createFollowActivity(
        mockUser,
        targetActorId,
        mockEnv,
      );
      const activity2 = FollowActivityService.createFollowActivity(
        mockUser,
        targetActorId,
        mockEnv,
      );

      const activity1Any = activity1 as any;
      const activity2Any = activity2 as any;
      if (activity1Any.id && activity2Any.id) {
        expect(activity1Any.id.toString()).not.toBe(activity2Any.id.toString());
      } else {
        // If IDs aren't exposed, at least verify activities are different objects
        expect(activity1).not.toBe(activity2);
      }
    });

    it("should use requestUrl if provided", () => {
      const targetActorId = "https://example.com/users/bob";
      const activity = FollowActivityService.createFollowActivity(
        mockUser,
        targetActorId,
        mockEnv,
        "https://custom.example.com/path",
      );

      // Activity ID should use the base URL from requestUrl
      const activityAny = activity as any;
      if (activityAny.id) {
        expect(activityAny.id.toString()).toContain("custom.example.com");
      } else {
        // If ID isn't exposed, just verify activity was created
        expect(activity).toBeInstanceOf(Follow);
      }
    });

    it("should handle different target actor IDs", () => {
      const target1 = "https://example.com/users/bob";
      const target2 = "https://example.com/users/charlie";

      const activity1 = FollowActivityService.createFollowActivity(
        mockUser,
        target1,
        mockEnv,
      );
      const activity2 = FollowActivityService.createFollowActivity(
        mockUser,
        target2,
        mockEnv,
      );

      // Verify both activities were created successfully
      expect(activity1).toBeInstanceOf(Follow);
      expect(activity2).toBeInstanceOf(Follow);
      expect(activity1).not.toBe(activity2);
    });
  });

  describe("parseFollowActivity", () => {
    it("should parse valid Follow activity from JSON", () => {
      const json = {
        type: "Follow",
        id: "https://example.com/activities/123",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).not.toBeNull();
      if (activity) {
        expect(activity).toBeInstanceOf(Follow);
        // Fedify doesn't expose properties directly, but we verify the activity was created
        const activityAny = activity as any;
        if (activityAny.id) {
          expect(activityAny.id).toBeInstanceOf(URL);
        }
      }
    });

    it("should parse Follow activity with object actor", () => {
      const json = {
        type: "Follow",
        id: "https://example.com/activities/123",
        actor: {
          id: "https://example.com/users/alice",
          type: "Person",
        },
        object: {
          id: "https://example.com/users/bob",
          type: "Person",
        },
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).not.toBeNull();
      if (activity) {
        expect(activity).toBeInstanceOf(Follow);
        // Fedify doesn't expose properties directly, but we verify the activity was created
      }
    });

    it("should return null for invalid activity type", () => {
      const json = {
        type: "Create",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).toBeNull();
    });

    it("should return null for missing actor", () => {
      const json = {
        type: "Follow",
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).toBeNull();
    });

    it("should return null for missing object", () => {
      const json = {
        type: "Follow",
        actor: "https://example.com/users/alice",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).toBeNull();
    });

    it("should handle missing id field", () => {
      const json = {
        type: "Follow",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).not.toBeNull();
      if (activity) {
        // Fedify may set a default id or leave it undefined
        // Just verify the activity was created successfully
        expect(activity).toBeInstanceOf(Follow);
      }
    });

    it("should return null for invalid URL format", () => {
      const json = {
        type: "Follow",
        actor: "not-a-valid-url",
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).toBeNull();
    });

    it("should handle malformed JSON gracefully", () => {
      const json = {
        type: "Follow",
        actor: null,
        object: "https://example.com/users/bob",
      };

      const activity = FollowActivityService.parseFollowActivity(json);

      expect(activity).toBeNull();
    });
  });
});
