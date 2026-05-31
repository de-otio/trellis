/**
 * Unit tests: routes/oauth.ts (T9b-d).
 *
 * Verifies the device-authorization issue and token poll outcomes via
 * the route surface, with the underlying handlers stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStart, mockPoll } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockPoll: vi.fn(),
}));

vi.mock("../../../../src/lib/oauth/device-authorization", () => ({
  startDeviceAuthorization: (...args: unknown[]) => mockStart(...args),
  pollDeviceAuth: (...args: unknown[]) => mockPoll(...args),
}));

vi.mock("../../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(_env: unknown) {}
    createSecureResponse(body: BodyInit, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

import { oauthRoutes } from "../../../../src/lib/routes/oauth.js";
import type { Env } from "../../../../src/env.js";

const ENV: Env = {
  COGNITO_AGENT_CLIENT_ID: "agent-client",
  AGENT_VERIFICATION_URI_BASE: "https://example.com/agents/authorize",
} as Env;

function makeRequest(path: string, init: RequestInit & { body?: string } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    ...init,
  });
}

function findRoute(path: string) {
  return oauthRoutes.find((r) => (r.path as RegExp).test(path));
}

describe("POST /oauth2/device_authorization", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockPoll.mockReset();
  });

  it("returns RFC 8628 issue payload on success", async () => {
    mockStart.mockResolvedValue({
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "https://example.com/agents/authorize",
      verification_uri_complete: "https://example.com/agents/authorize?user_code=BCDF-GHJK",
      expires_in: 600,
      interval: 5,
    });

    const route = findRoute("/oauth2/device_authorization")!;
    const request = makeRequest("/oauth2/device_authorization", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/device_authorization",
      params: {},
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user_code: string };
    expect(body.user_code).toBe("BCDF-GHJK");
  });

  it("rejects missing client_id", async () => {
    const route = findRoute("/oauth2/device_authorization")!;
    const request = makeRequest("/oauth2/device_authorization", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/device_authorization",
      params: {},
    });
    expect(response.status).toBe(400);
  });

  it("rejects unknown client_id when configured", async () => {
    const route = findRoute("/oauth2/device_authorization")!;
    const request = makeRequest("/oauth2/device_authorization", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=wrong-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/device_authorization",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("accepts JSON body as well", async () => {
    mockStart.mockResolvedValue({
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "x",
      verification_uri_complete: "x",
      expires_in: 600,
      interval: 5,
    });
    const route = findRoute("/oauth2/device_authorization")!;
    const request = makeRequest("/oauth2/device_authorization", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "agent-client" }),
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/device_authorization",
      params: {},
    });
    expect(response.status).toBe(200);
  });

  it("HIGH-4: truncates an oversized User-Agent to 256 bytes before persistence", async () => {
    mockStart.mockResolvedValue({
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "x",
      verification_uri_complete: "x",
      expires_in: 600,
      interval: 5,
    });
    const route = findRoute("/oauth2/device_authorization")!;
    const longUa = "A".repeat(1000);
    const request = makeRequest("/oauth2/device_authorization", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": longUa,
      },
      body: "client_id=agent-client",
    });
    await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/device_authorization",
      params: {},
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    const startInput = mockStart.mock.calls[0]![0] as { agentLabel?: string };
    expect(startInput.agentLabel).toBeDefined();
    expect(startInput.agentLabel!.length).toBe(256);
  });
});

describe("POST /oauth2/token", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockPoll.mockReset();
  });

  it("returns 400 authorization_pending while waiting", async () => {
    mockPoll.mockResolvedValue({ outcome: "pending" });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
  });

  it("returns 200 + tokens on success", async () => {
    mockPoll.mockResolvedValue({
      outcome: "ok",
      tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 },
    });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    expect(body.access_token).toBe("AT");
  });

  it("returns 410 gone after read-once consumption", async () => {
    mockPoll.mockResolvedValue({ outcome: "gone" });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(410);
  });

  it("returns 400 slow_down when polled too fast", async () => {
    mockPoll.mockResolvedValue({ outcome: "slow_down" });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("slow_down");
  });

  it("returns 400 expired_token when ttl elapsed", async () => {
    mockPoll.mockResolvedValue({ outcome: "expired" });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("expired_token");
  });

  it("returns 400 access_denied when admin rejected", async () => {
    mockPoll.mockResolvedValue({ outcome: "denied" });
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("access_denied");
  });

  it("rejects unsupported grant_type", async () => {
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&device_code=device-code-very-long-and-unguessable&client_id=agent-client",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("rejects unknown client_id when configured", async () => {
    const route = findRoute("/oauth2/token")!;
    const request = makeRequest("/oauth2/token", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=device-code-very-long-and-unguessable&client_id=wrong",
    });
    const response = await route.handler(request, ENV, {
      url: new URL(request.url),
      pathname: "/oauth2/token",
      params: {},
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });
});
