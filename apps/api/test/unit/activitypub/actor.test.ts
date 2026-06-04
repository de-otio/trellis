/**
 * Unit Tests: Actor Service
 *
 * Tests for ActivityPub actor URI generation and validation.
 */

import { beforeEach, describe, it, expect } from "vitest";
import { ActorService } from "../../../src/lib/activitypub/actor.js";
import type { Env } from "../../../src/env.js";
import type { User } from "@prisma/client";
import { createFedifyTestEnv } from "../../utils/fedify-test-fixtures.js";

describe("ActorService", () => {
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createFedifyTestEnv();
  });

  describe("getBaseUrl", () => {
    it("should use APP_DOMAIN if available", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: "https://www.example.com",
      });
      const result = ActorService.getBaseUrl(env);
      expect(result).toBe("https://www.example.com");
    });

    it("should use ACTIVITYPUB_BASE_URL if APP_DOMAIN not available", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: "https://activitypub.example.com",
      });
      const result = ActorService.getBaseUrl(env);
      expect(result).toBe("https://activitypub.example.com");
    });

    it("should derive from requestUrl if env vars not available", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: undefined,
      });
      const requestUrl = "https://custom.example.com/api/posts";
      const result = ActorService.getBaseUrl(env, requestUrl);
      expect(result).toBe("https://custom.example.com");
    });

    it("should default to https://example.com if no sources available", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: undefined,
      });
      const result = ActorService.getBaseUrl(env);
      expect(result).toBe("https://example.com");
    });

    it("should handle invalid APP_DOMAIN gracefully", () => {
      const env = createFedifyTestEnv({ APP_DOMAIN: "not-a-valid-url" });
      const result = ActorService.getBaseUrl(env);
      // Should fall back to default or ACTIVITYPUB_BASE_URL
      expect(result).toBeTruthy();
    });

    it("should handle invalid requestUrl gracefully", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: undefined,
      });
      const result = ActorService.getBaseUrl(env, "not-a-valid-url");
      expect(result).toBe("https://example.com");
    });

    it("should extract protocol and hostname from APP_DOMAIN", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: "https://www.example.com/path/to/page",
      });
      const result = ActorService.getBaseUrl(env);
      expect(result).toBe("https://www.example.com");
    });
  });

  describe("generateActorUri", () => {
    it("should generate actor URI for username", () => {
      const result = ActorService.generateActorUri("alice", mockEnv);
      expect(result).toBe("https://example.com/users/alice");
    });

    it("should URL-encode username", () => {
      const result = ActorService.generateActorUri("alice smith", mockEnv);
      expect(result).toBe("https://example.com/users/alice%20smith");
    });

    it("should handle special characters in username", () => {
      const result = ActorService.generateActorUri("alice@example", mockEnv);
      expect(result).toBe("https://example.com/users/alice%40example");
    });

    it("should throw error for empty username", () => {
      expect(() => {
        ActorService.generateActorUri("", mockEnv);
      }).toThrow("Username is required to generate actor URI");
    });

    it("should use custom base URL from env", () => {
      const env = createFedifyTestEnv({ APP_DOMAIN: "https://custom.com" });
      const result = ActorService.generateActorUri("alice", env);
      expect(result).toBe("https://custom.com/users/alice");
    });

    it("should use requestUrl for base URL if env vars not set", () => {
      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: undefined,
      });
      const result = ActorService.generateActorUri(
        "alice",
        env,
        "https://custom.example.com/api",
      );
      expect(result).toBe("https://custom.example.com/users/alice");
    });
  });

  describe("getActorUri", () => {
    it("should return existing actorId if present", () => {
      const user = {
        id: "user-123",
        username: "alice",
        actorUri: "https://example.com/users/alice-existing",
      } as User;

      const result = ActorService.getActorUri(user, mockEnv);
      expect(result).toBe("https://example.com/users/alice-existing");
    });

    it("should generate actor URI if actorId missing", () => {
      const user = {
        id: "user-123",
        username: "alice",
        actorUri: null,
      } as any;

      const result = ActorService.getActorUri(user, mockEnv);
      expect(result).toBe("https://example.com/users/alice");
    });

    it("should throw error if user missing username and actorId", () => {
      const user = {
        id: "user-123",
        username: null,
        actorUri: null,
      } as any;

      expect(() => {
        ActorService.getActorUri(user, mockEnv);
      }).toThrow("User must have username to generate actor URI");
    });

    it("should use requestUrl when generating new URI", () => {
      const user = {
        id: "user-123",
        username: "alice",
        actorUri: null,
      } as any;

      const env = createFedifyTestEnv({
        APP_DOMAIN: undefined,
        ACTIVITYPUB_BASE_URL: undefined,
      });
      const result = ActorService.getActorUri(
        user,
        env,
        "https://custom.example.com/api",
      );
      expect(result).toBe("https://custom.example.com/users/alice");
    });
  });

  describe("generateCollectionUrls", () => {
    it("should generate standard collection URLs", () => {
      const actorUri = "https://example.com/users/alice";
      const result = ActorService.generateCollectionUrls(actorUri);

      expect(result).toEqual({
        inbox: "https://example.com/users/alice/inbox",
        outbox: "https://example.com/users/alice/outbox",
        followers: "https://example.com/users/alice/followers",
        following: "https://example.com/users/alice/following",
      });
      expect(result.friends).toBeUndefined();
    });

    it("should include friends URL when requested", () => {
      const actorUri = "https://example.com/users/alice";
      const result = ActorService.generateCollectionUrls(actorUri, true);

      expect(result).toEqual({
        inbox: "https://example.com/users/alice/inbox",
        outbox: "https://example.com/users/alice/outbox",
        followers: "https://example.com/users/alice/followers",
        following: "https://example.com/users/alice/following",
        friends: "https://example.com/users/alice/friends",
      });
    });

    it("should handle different actor URI formats", () => {
      const actorUri = "https://custom.com/users/bob";
      const result = ActorService.generateCollectionUrls(actorUri);

      expect(result.inbox).toBe("https://custom.com/users/bob/inbox");
      expect(result.outbox).toBe("https://custom.com/users/bob/outbox");
      expect(result.followers).toBe("https://custom.com/users/bob/followers");
      expect(result.following).toBe("https://custom.com/users/bob/following");
    });
  });

  describe("isValidActorUri", () => {
    it("should return true for valid actor URI", () => {
      expect(
        ActorService.isValidActorUri("https://example.com/users/alice"),
      ).toBe(true);
      expect(ActorService.isValidActorUri("https://custom.com/users/bob")).toBe(
        true,
      );
    });

    it("should return false for HTTP (non-HTTPS) URI", () => {
      expect(
        ActorService.isValidActorUri("http://example.com/users/alice"),
      ).toBe(false);
    });

    it("should return false for URI without /users/ path", () => {
      expect(ActorService.isValidActorUri("https://example.com/alice")).toBe(
        false,
      );
      expect(
        ActorService.isValidActorUri("https://example.com/posts/123"),
      ).toBe(false);
    });

    it("should return false for invalid URL format", () => {
      expect(ActorService.isValidActorUri("not-a-url")).toBe(false);
      expect(ActorService.isValidActorUri("")).toBe(false);
    });

    it("should return false for null or undefined", () => {
      expect(ActorService.isValidActorUri(null as any)).toBe(false);
      expect(ActorService.isValidActorUri(undefined as any)).toBe(false);
    });

    it("should accept URIs with paths after /users/", () => {
      // Even though this might not be standard, the validation only checks for /users/ prefix
      expect(
        ActorService.isValidActorUri("https://example.com/users/alice/inbox"),
      ).toBe(true);
    });
  });
});
