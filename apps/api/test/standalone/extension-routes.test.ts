/**
 * Standalone — the dummy extension's core-wrapped routes.
 *
 * Proves that a registered TrellisExtension's `extensionRoutes` mount at
 * /api/ext/<id>/<path>, honour the declared `auth` level, and round-trip
 * through the core handler wrapper.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  authenticatedFetch,
  createTestUserWithSession,
  getCsrfToken,
} from "../utils/test-auth.js";
import { getApiUrl } from "../utils/test-config.js";

const API_URL = getApiUrl();

describe("standalone: extension routes (example)", () => {
  it("auth:none ping is public and returns the handler body", async () => {
    const res = await fetch(`${API_URL}/api/ext/example/ping`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pong).toBe(true);
  });

  it("auth:required route returns 401 without a session", async () => {
    const res = await fetch(`${API_URL}/api/ext/example/whoami`);
    expect(res.status).toBe(401);
  });

  describe("with an authenticated session", () => {
    let sessionToken: string;
    let userId: string;

    beforeAll(async () => {
      const { testUser, sessionToken: token } = await createTestUserWithSession();
      sessionToken = token;
      userId = testUser.id;
    });

    it("whoami echoes the authenticated user", async () => {
      const res = await authenticatedFetch(
        `${API_URL}/api/ext/example/whoami`,
        sessionToken,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe(userId);
    });

    it("echo round-trips the posted JSON body (CSRF-protected)", async () => {
      // auth:required extension routes get csrfMiddleware — send a token.
      const { token, updatedSessionToken } = await getCsrfToken(
        API_URL,
        sessionToken,
      );
      const res = await authenticatedFetch(
        `${API_URL}/api/ext/example/echo`,
        updatedSessionToken,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-CSRF-Token": token,
          },
          body: JSON.stringify({ hello: "world" }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.echoed).toEqual({ hello: "world" });
    });
  });

  it("unknown extension id is not mounted (404)", async () => {
    const res = await fetch(`${API_URL}/api/ext/nope/ping`);
    expect(res.status).toBe(404);
  });
});
