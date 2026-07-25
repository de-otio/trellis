/**
 * POST /auth/magic-link route tests (WS-3.3).
 *
 * Load-bearing:
 *  - the per-email 5/900s limit lives in this API caller (G2 inherited S-6),
 *    fails CLOSED when the limiter is unreachable, and 429s over the cap;
 *  - unknown email is indistinguishable from success (C-13/F10 enumeration
 *    stance) and the link is NEVER echoed in any response;
 *  - the app-owned S-8 email is sent when the provider returns a link
 *    (Keycloak path) and NOT sent when the provider delivered (Cognito path);
 *  - a foreign redirect_uri is rejected before reaching the IdP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IdentityProviderError,
  type IdentityProviderPort,
  type MagicLinkInitiation,
} from "@de-otio/saas-foundation/identity";

import type { Env } from "../../../src/env.js";
import { handleMagicLinkInitiate, __setMagicLinkEmailSenderForTest } from "../../../src/lib/identity/magic-link-initiate.js";
import { __setIdentityProviderForTest } from "../../../src/lib/identity/identity-provider.js";
import { RateLimiter, __resetRateLimiterForTests } from "../../../src/lib/rate-limit.js";
import type { EmailSendOptions } from "../../../src/lib/email-provider.js";

const LINK = "https://id.example.test/realms/r/login-actions/action-token?key=tok-1";

function makeEnv(): Env {
  return { APP_DOMAIN: "app.example.test" } as unknown as Env;
}

function makeRequest(body: unknown): Request {
  return new Request("https://api.example.test/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function keycloakLikeProvider(
  result: MagicLinkInitiation = { userId: "u-1", link: LINK, emailSent: false },
): { provider: IdentityProviderPort; calls: Array<{ email: string; opts: object }> } {
  const calls: Array<{ email: string; opts: object }> = [];
  return {
    calls,
    provider: {
      initiateMagicLink: async (email, opts) => {
        calls.push({ email, opts });
        return result;
      },
      deleteUser: async () => {},
    },
  };
}

describe("handleMagicLinkInitiate", () => {
  let sentEmails: EmailSendOptions[];

  beforeEach(() => {
    process.env.IDENTITY_PROVIDER = "keycloak"; // provider comes from the seam
    sentEmails = [];
    __setMagicLinkEmailSenderForTest(async (opts) => {
      sentEmails.push(opts);
      return { messageId: "m1" };
    });
    __resetRateLimiterForTests();
  });

  afterEach(() => {
    delete process.env.IDENTITY_PROVIDER;
    __setMagicLinkEmailSenderForTest(null);
    __setIdentityProviderForTest(null);
    __resetRateLimiterForTests();
    vi.restoreAllMocks();
  });

  it("initiates through the port and sends the app-owned S-8 email (link path)", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);

    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "User1@Example.test" }),
      makeEnv(),
      new RateLimiter(),
      {},
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "sent" });
    // never echo the link
    expect(JSON.stringify(body)).not.toContain("action-token");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.email).toBe("user1@example.test"); // normalized
    expect(calls[0]!.opts).toMatchObject({
      expirationSeconds: 300,
      redirectUri: "https://app.example.test/auth/verify",
    });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe("user1@example.test");
    expect(sentEmails[0]!.subject).toBe("Sign in to Trellis");
    expect(sentEmails[0]!.text).toContain(LINK);
    expect(sentEmails[0]!.from).toBe("Trellis <noreply@app.example.test>");
  });

  it("does NOT send an email when the provider already delivered (Cognito path) and returns the session handle", async () => {
    const { provider } = keycloakLikeProvider({ handle: "sess-1", emailSent: true });
    __setIdentityProviderForTest(provider);

    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test" }),
      makeEnv(),
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent", session: "sess-1" });
    expect(sentEmails).toHaveLength(0);
  });

  it("returns the SAME 200 shape for an unknown email (C-13/F10 enumeration stance)", async () => {
    __setIdentityProviderForTest({
      initiateMagicLink: async () => {
        throw new IdentityProviderError("unknown_user", "no user", 404);
      },
      deleteUser: async () => {},
    });

    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "nobody@example.test" }),
      makeEnv(),
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(sentEmails).toHaveLength(0);
  });

  it("enforces the per-email 5/900s limit in the caller (G2 S-6) with a 429 after the cap", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);
    const limiter = new RateLimiter();
    const env = makeEnv();

    for (let i = 0; i < 5; i++) {
      const res = await handleMagicLinkInitiate(
        makeRequest({ email: "user1@example.test" }),
        env,
        limiter,
        {},
      );
      expect(res.status).toBe(200);
    }
    const sixth = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test" }),
      env,
      limiter,
      {},
    );
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    expect(calls).toHaveLength(5); // the 6th never reached the port

    // a DIFFERENT email is not affected (per-email key)
    const other = await handleMagicLinkInitiate(
      makeRequest({ email: "other@example.test" }),
      env,
      limiter,
      {},
    );
    expect(other.status).toBe(200);
  });

  it("fails CLOSED (503) when the rate limiter is unreachable", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);
    const limiter = new RateLimiter();
    vi.spyOn(limiter, "checkRateLimitKVStrict").mockRejectedValue(new Error("backend down"));

    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test" }),
      makeEnv(),
      limiter,
      {},
    );
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("rejects a redirect_uri off the app domain before reaching the IdP", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);

    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test", redirect_uri: "https://evil.example.com/grab" }),
      makeEnv(),
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("accepts an app-domain redirect_uri and passes the OAuth params through", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);

    const res = await handleMagicLinkInitiate(
      makeRequest({
        email: "user1@example.test",
        redirect_uri: "https://app.example.test/auth/verify",
        state: "st-1",
        nonce: "no-1",
        code_challenge: "ch-1",
      }),
      makeEnv(),
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.opts).toMatchObject({
      redirectUri: "https://app.example.test/auth/verify",
      state: "st-1",
      nonce: "no-1",
      codeChallenge: "ch-1",
    });
  });

  it("[F4] fails CLOSED (503) when APP_DOMAIN is unset and no redirect_uri was supplied", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);

    // Env WITHOUT APP_DOMAIN and a request with no redirect_uri → the default
    // path would otherwise send an empty redirect_uri to the IdP. Refuse.
    const envNoDomain = {} as unknown as Env;
    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test" }),
      envNoDomain,
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(503);
    // The provider must never be reached with an empty redirect_uri.
    expect(calls).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("rejects malformed input (missing/invalid email, bad JSON)", async () => {
    const { provider, calls } = keycloakLikeProvider();
    __setIdentityProviderForTest(provider);
    const env = makeEnv();
    const limiter = new RateLimiter();

    expect(
      (await handleMagicLinkInitiate(makeRequest({}), env, limiter, {})).status,
    ).toBe(400);
    expect(
      (await handleMagicLinkInitiate(makeRequest({ email: "not-an-email" }), env, limiter, {})).status,
    ).toBe(400);
    const badJson = new Request("https://api.example.test/auth/magic-link", {
      method: "POST",
      body: "{nope",
    });
    expect((await handleMagicLinkInitiate(badJson, env, limiter, {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 503 (no detail leak) on provider errors", async () => {
    __setIdentityProviderForTest({
      initiateMagicLink: async () => {
        throw new IdentityProviderError("unauthorized", "service token rejected", 403);
      },
      deleteUser: async () => {},
    });
    const res = await handleMagicLinkInitiate(
      makeRequest({ email: "user1@example.test" }),
      makeEnv(),
      new RateLimiter(),
      {},
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("token");
  });
});
