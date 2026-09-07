/**
 * Regression: F8 — the internal-docs fetch took its HOST from a request header.
 *
 * `InternalDocsHandler.handleGetDoc` built the URL it fetched as
 * `request.headers.get("Origin") || env.APP_DOMAIN || <a compiled-in host>`,
 * then called bare `fetch()` and read the answer with an unbounded
 * `await response.text()`. Three things wrong with that, in one line of code:
 *
 *   - the host came from an attacker-controlled header, so a caller past the
 *     INTERNAL/SUPER_ADMIN gate could aim the server at any address it liked;
 *   - `fetch()` auto-follows redirects, so the `/docs/…` suffix contained
 *     nothing — the named host could `302` to any path on any host;
 *   - `.text()` had no ceiling, so the size of the allocation was chosen by
 *     whatever answered.
 *
 * It read as safe because the route IS well gated on role and the filename IS
 * allowlisted — both true, and neither of them is about where the bytes come
 * from. The SSRF model (`plans/link-delivery-hardening/05-ssrf-model-kapsule.md`)
 * found it while inventorying the fetch call sites that bypass the helper.
 *
 * The target now comes from `env.APP_DOMAIN` only, and the fetch goes through
 * `safeFetch` with an explicit byte cap. `safeFetch` is mocked here so the
 * policy this file is about — WHICH URL is requested, and that a cap is asked
 * for — is decided without a network; the guard's own behaviour (IP ranges,
 * per-hop redirect re-validation, the streaming cap) is covered by
 * test/unit/net/safe-fetch.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InternalDocsHandler } from "../../src/lib/internal-docs-handler.js";
import { ResponseTooLargeError } from "../../src/lib/net/safe-fetch.js";
import type { Session } from "../../src/lib/session-cookie.js";

const mockGetSession = vi.fn();
vi.mock("../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
  UserRole: {
    END_USER: "END_USER",
    INTERNAL: "INTERNAL",
    SUPER_ADMIN: "SUPER_ADMIN",
  },
}));

const mockCreateSecureResponse = vi.fn();
vi.mock("../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = mockCreateSecureResponse;
    addSecurityHeaders = vi.fn();
  },
}));

const mockFindUnique = vi.fn();
vi.mock("../../src/db", () => ({
  createPrisma: vi.fn(() => ({ user: { findUnique: mockFindUnique } })),
}));

vi.mock("../../src/lib/internal-docs-navigation.json", () => ({
  default: {
    sections: [
      {
        title: "Test Section",
        items: [{ title: "Test Doc", path: "internal/test.md" }],
      },
    ],
  },
}));

vi.mock("../../src/lib/internal-docs-dashboard.json", () => ({
  default: { sections: [] },
}));

// Only `safeFetch` is replaced; `ResponseTooLargeError` / `SsrfBlockedError`
// stay the real classes, so the handler's `instanceof` branches are the real
// ones too.
const mockSafeFetch = vi.fn();
vi.mock("../../src/lib/net/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/net/safe-fetch.js")>();
  return { ...actual, safeFetch: (...args: any[]) => mockSafeFetch(...args) };
});

const CONFIGURED_HOST = "app.example.com";
const ATTACKER_HOST = "https://attacker.example.net";
/** The allowlist key (the navigation mock maps it to `internal/test.md`). */
const DOC = "test.md";
const DOC_PATH = "internal/test.md";

describe("internal docs fetch target — F8", () => {
  let handler: InternalDocsHandler;
  let mockEnv: any;

  const internalSession: Session = {
    userId: "user-123",
    email: "internal@example.com",
    role: "INTERNAL",
    expiresAt: Date.now() + 3600000,
  } as Session;

  const requestWithOrigin = (origin?: string) =>
    new Request(`https://api.example.com/api/internal/docs/${DOC_PATH}`, {
      method: "GET",
      headers: origin
        ? { Cookie: "trellis_session=test", Origin: origin }
        : { Cookie: "trellis_session=test" },
    });

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = { DATABASE_URL: "postgres://test", APP_DOMAIN: CONFIGURED_HOST };
    mockCreateSecureResponse.mockImplementation(
      (body: string, options?: any) => new Response(body, options),
    );
    // A recording stand-in for the bare `fetch` the old code used. Nothing in
    // this handler may reach it any more; asserting that directly is what makes
    // the Origin test below fail on the OLD code for the right reason (it
    // fetched the attacker's host through exactly this) rather than incidentally.
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("# Test Document", { status: 200 })) as any;

    mockGetSession.mockResolvedValue(internalSession);
    mockFindUnique.mockResolvedValue({ role: "INTERNAL" });
    mockSafeFetch.mockResolvedValue({
      status: 200,
      headers: {},
      body: Buffer.from("# Test Document\n\nContent here"),
      url: `https://${CONFIGURED_HOST}/docs/${DOC_PATH}`,
      redirectChain: [],
    });

    handler = new InternalDocsHandler(mockEnv);
  });

  /** The URL the handler asked for, minus the cache-busting query. */
  const requestedUrl = () => String(mockSafeFetch.mock.calls[0][0]).split("?")[0];

  it("fetches the configured host", async () => {
    const response = await handler.handleGetDoc(requestWithOrigin(), mockEnv, DOC);

    expect(response.status).toBe(200);
    expect((await response.json()).content).toContain("# Test Document");
    expect(requestedUrl()).toBe(`https://${CONFIGURED_HOST}/docs/${DOC_PATH}`);
  });

  // The discriminating case: on the old code this fetched the attacker's host.
  it("an Origin header naming another host does not change the fetch target", async () => {
    await handler.handleGetDoc(requestWithOrigin(ATTACKER_HOST), mockEnv, DOC);

    // Nothing was fetched outside the SSRF-safe helper at all …
    expect(global.fetch).not.toHaveBeenCalled();
    // … and what the helper was asked for is the CONFIGURED host.
    expect(requestedUrl()).toBe(`https://${CONFIGURED_HOST}/docs/${DOC_PATH}`);
    expect(String(mockSafeFetch.mock.calls[0][0])).not.toContain("attacker.example.net");
  });

  it("accepts an APP_DOMAIN that already carries a scheme", async () => {
    await handler.handleGetDoc(
      requestWithOrigin(ATTACKER_HOST),
      { ...mockEnv, APP_DOMAIN: `https://${CONFIGURED_HOST}/` },
      DOC,
    );

    expect(requestedUrl()).toBe(`https://${CONFIGURED_HOST}/docs/${DOC_PATH}`);
  });

  // Fail CLOSED, rather than falling back to the request header or to a
  // compiled-in host as the old code did.
  it("refuses when APP_DOMAIN is unset instead of trusting the Origin", async () => {
    const response = await handler.handleGetDoc(
      requestWithOrigin(ATTACKER_HOST),
      { DATABASE_URL: "postgres://test" },
      DOC,
    );

    expect(response.status).toBe(503);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("asks for a byte cap", async () => {
    await handler.handleGetDoc(requestWithOrigin(), mockEnv, DOC);

    const options = mockSafeFetch.mock.calls[0][1];
    expect(options.maxBytes).toBeGreaterThan(0);
    expect(options.maxBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(options.timeoutMs).toBeGreaterThan(0);
  });

  it("refuses an oversize body rather than returning it", async () => {
    mockSafeFetch.mockRejectedValue(
      new ResponseTooLargeError(1024, `https://${CONFIGURED_HOST}/docs/${DOC_PATH}`),
    );

    const response = await handler.handleGetDoc(requestWithOrigin(), mockEnv, DOC);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Document too large");
    expect(body.content).toBeUndefined();
  });

  it("still maps an upstream 404 to a 404", async () => {
    mockSafeFetch.mockResolvedValue({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
      url: `https://${CONFIGURED_HOST}/docs/${DOC_PATH}`,
      redirectChain: [],
    });

    const response = await handler.handleGetDoc(requestWithOrigin(), mockEnv, DOC);

    expect(response.status).toBe(404);
  });
});
