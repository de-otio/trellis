/**
 * Unit tests: GET /api/app/version-policy and the 426 client-version backstop,
 * exercised through the real Hono app (`buildHonoApp`) so registration,
 * middleware order, and header composition are all covered — the mount-gap
 * defect class this repo already has a parity guard for.
 */

import { describe, expect, it } from "vitest";

import { buildHonoApp } from "../../src/lib/app.js";
import { CORS_ALLOWED_REQUEST_HEADERS } from "../../src/lib/cors-handler.js";
import { clientVersionMiddleware } from "../../src/lib/middleware.js";
import type { MiddlewareContext } from "../../src/lib/middleware.js";
import type { Env } from "../../src/env.js";

const POLICY_PATH = "/api/app/version-policy";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}

async function get(
  env: Env,
  path = POLICY_PATH,
  init: RequestInit = {},
): Promise<Response> {
  const app = buildHonoApp();
  return app.fetch(new Request(`http://localhost${path}`, init), {
    trellisEnv: env,
  });
}

describe("GET /api/app/version-policy", () => {
  it("is mounted and answers 200 unauthenticated", async () => {
    const res = await get(envWith());
    expect(res.status).toBe(200);
  });

  it("returns all-null policy when nothing is configured (dormant default)", async () => {
    const res = await get(envWith());
    expect(await res.json()).toEqual({
      minimumVersion: null,
      recommendedVersion: null,
      storeUrls: { android: null, ios: null },
    });
  });

  it("returns the configured policy", async () => {
    const res = await get(
      envWith({
        CLIENT_MIN_SUPPORTED_VERSION: "1.0.0",
        CLIENT_RECOMMENDED_VERSION: "1.4.2",
        CLIENT_STORE_URL_ANDROID:
          "https://play.google.com/store/apps/details?id=org.example.app",
        CLIENT_STORE_URL_IOS: "https://apps.apple.com/app/id123456789",
      }),
    );
    expect(await res.json()).toEqual({
      minimumVersion: "1.0.0",
      recommendedVersion: "1.4.2",
      storeUrls: {
        android: "https://play.google.com/store/apps/details?id=org.example.app",
        ios: "https://apps.apple.com/app/id123456789",
      },
    });
  });

  it("is publicly cacheable for five minutes", async () => {
    const res = await get(envWith());
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves ACAO:* WITHOUT credentials, and varies on Origin", async () => {
    const res = await get(envWith({ APP_DOMAIN: "https://app.example.com" }), POLICY_PATH, {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Credentialed CORS + a shared cache is the cache-poisoning shape this
    // endpoint deliberately avoids.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("carries the standard security headers", async () => {
    const res = await get(envWith());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("is reachable even from a client the 426 backstop would otherwise block", async () => {
    const res = await get(
      envWith({ CLIENT_MIN_SUPPORTED_VERSION: "9.9.9" }),
      POLICY_PATH,
      { headers: { "X-Client-Version": "0.0.1", "X-Client-Platform": "android" } },
    );
    expect(res.status).toBe(200);
  });
});

describe("426 backstop via the Hono app", () => {
  const armed = envWith({ CLIENT_MIN_SUPPORTED_VERSION: "2.0.0" });

  it("refuses an outdated client with 426 and the UPGRADE_REQUIRED shape", async () => {
    const res = await get(armed, "/api/feature-flags", {
      headers: { "X-Client-Version": "1.9.9", "X-Client-Platform": "ios" },
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "UPGRADE_REQUIRED" });
    expect(typeof body.message).toBe("string");
    expect(typeof body.remediation).toBe("string");
  });

  it("puts NO url in the 426 body", async () => {
    const res = await get(
      envWith({
        CLIENT_MIN_SUPPORTED_VERSION: "2.0.0",
        CLIENT_STORE_URL_IOS: "https://apps.apple.com/app/id123456789",
      }),
      "/api/feature-flags",
      { headers: { "X-Client-Version": "1.0.0" } },
    );
    expect(res.status).toBe(426);
    expect(await res.text()).not.toMatch(/https?:\/\//);
  });

  it("does not intercept OPTIONS preflights (the browser must still learn)", async () => {
    const app = buildHonoApp();
    const res = await app.fetch(
      new Request("http://localhost/api/feature-flags", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "X-Client-Version": "0.0.1",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-client-version",
        },
      }),
      { trellisEnv: envWith({ ...armed, APP_DOMAIN: "https://app.example.com" }) },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      CORS_ALLOWED_REQUEST_HEADERS,
    );
  });

  it("lets a request with no version header through", async () => {
    const res = await get(armed, "/health");
    expect(res.status).toBe(200);
  });

  it.each(["/health", POLICY_PATH, "/.well-known/webfinger"])(
    "never blocks the exempt path %s",
    async (path) => {
      const res = await get(armed, path, {
        headers: { "X-Client-Version": "0.0.1" },
      });
      expect(res.status).not.toBe(426);
    },
  );
});

describe("clientVersionMiddleware (unit)", () => {
  function contextFor(
    headers: Record<string, string>,
    env: Env,
    method = "GET",
    pathname = "/api/posts",
  ): MiddlewareContext {
    const url = new URL(`https://api.example.com${pathname}`);
    return {
      request: new Request(url, { method, headers }),
      env,
      url,
      pathname,
      method,
    };
  }

  const armed = envWith({ CLIENT_MIN_SUPPORTED_VERSION: "3.0.0" });
  const downstream = async () => new Response("ok", { status: 200 });

  it("returns next()'s response untouched when the client is supported", async () => {
    const res = await clientVersionMiddleware()(
      contextFor({ "X-Client-Version": "3.0.0" }, armed),
      downstream,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("never calls next() when it blocks", async () => {
    let called = false;
    const res = await clientVersionMiddleware()(
      contextFor({ "X-Client-Version": "2.9.9" }, armed),
      async () => {
        called = true;
        return new Response("ok");
      },
    );
    expect(res.status).toBe(426);
    expect(called).toBe(false);
  });

  it("marks the 426 no-store and attaches CORS headers so a browser can read it", async () => {
    const res = await clientVersionMiddleware()(
      contextFor(
        { "X-Client-Version": "1.0.0", Origin: "https://app.example.com" },
        envWith({ ...armed, APP_DOMAIN: "https://app.example.com" }),
      ),
      downstream,
    );
    expect(res.status).toBe(426);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
  });

  it("passes an unparseable header through instead of blocking", async () => {
    const res = await clientVersionMiddleware()(
      contextFor({ "X-Client-Version": "<script>" }, armed),
      downstream,
    );
    expect(res.status).toBe(200);
  });

  it("is a no-op when no minimum is configured", async () => {
    const res = await clientVersionMiddleware()(
      contextFor({ "X-Client-Version": "0.0.1" }, envWith()),
      downstream,
    );
    expect(res.status).toBe(200);
  });
});
