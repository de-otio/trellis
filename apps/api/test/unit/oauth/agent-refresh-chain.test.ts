/**
 * End-to-end rotation-chain test (plan 034 lane D, D.2).
 *
 * `refresh-detection.ts`'s replay detection is well-built, strongly consistent
 * and thoroughly unit-tested — and until this lane it could never fire, because
 * the approve step stored `randomBytes(16)` as the jti under a comment claiming
 * it was derived from the refresh token. Every existing test proved the
 * detector works *given a jti*; none proved the issue path and the consume path
 * agree on what that jti is. That gap is exactly how a refresh grant would have
 * shipped with replay detection that passes its unit tests and never fires in
 * production.
 *
 * So this file joins the two halves: it drives the real approve handler with a
 * mocked Cognito issuer, lets the real `recordAgentSession` write to in-memory
 * stores, and then presents the refresh token the issuer handed out. Against
 * `main` the first assertion fails — `consumeRefreshToken` returns "unknown",
 * because the recorded jti has no relationship to the token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";

const {
  mockGetSession,
  mockApplyRateLimitKV,
  mockLookupDeviceCodeByUserCode,
  mockLoadByDeviceCode,
  mockApproveDeviceAuth,
  mockIssueForAgent,
  mockAuditEmit,
  mockFindMember,
  mockFindUser,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockApplyRateLimitKV: vi.fn(),
  mockLookupDeviceCodeByUserCode: vi.fn(),
  mockLoadByDeviceCode: vi.fn(),
  mockApproveDeviceAuth: vi.fn(),
  mockIssueForAgent: vi.fn(),
  mockAuditEmit: vi.fn(),
  mockFindMember: vi.fn(),
  mockFindUser: vi.fn(),
}));

vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
  },
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    constructor(_env: unknown) {}
    createSecureResponse(body: BodyInit, init: ResponseInit) {
      return new Response(body, init);
    }
  },
}));

vi.mock("../../../src/lib/oauth/device-authorization", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/lib/oauth/device-authorization.js")
  >("../../../src/lib/oauth/device-authorization");
  return {
    ...actual,
    lookupDeviceCodeByUserCode: (...a: unknown[]) => mockLookupDeviceCodeByUserCode(...a),
    loadByDeviceCode: (...a: unknown[]) => mockLoadByDeviceCode(...a),
    approveDeviceAuth: (...a: unknown[]) => mockApproveDeviceAuth(...a),
  };
});

// NOTE: refresh-detection is deliberately NOT mocked. It is the other half of
// the chain under test.

vi.mock("../../../src/db", () => ({
  createPrisma: () => ({
    tenantMember: { findFirst: (...a: unknown[]) => mockFindMember(...a) },
    user: { findUnique: (...a: unknown[]) => mockFindUser(...a) },
    securityEvent: { create: vi.fn() },
  }),
}));

import {
  agentAuthorizeRoutes,
  _resetAgentAuthorizeDepsForTest,
  _setAgentAuthorizeDepsForTest,
} from "../../../src/lib/routes/agent-authorize.js";
import {
  consumeRefreshToken,
  getAgentSession,
  rotateRefreshJti,
  _setRefreshStoresForTest,
} from "../../../src/lib/oauth/refresh-detection.js";
import { hashUserCode, normaliseUserCode } from "../../../src/lib/oauth/device-authorization.js";
import type { Env } from "../../../src/env.js";
import type { Session } from "../../../src/lib/session-cookie.js";

const SESSION_SECRET = "test-secret-key-32-characters-long!!";

const ENV = {
  COGNITO_USER_POOL_ID: "us-east-1_pool",
  COGNITO_AGENT_CLIENT_ID: "agent-client",
  AGENT_VERIFICATION_URI_BASE: "https://example.com/agents/authorize",
  SESSION_SECRET,
} as unknown as Env;

const ADMIN_SESSION: Session & { refreshToken: string } = {
  userId: "u_admin",
  email: "admin@example.com",
  role: "B2B_PARTNER",
  expiresAt: Date.now() + 3_600_000,
  dataRegion: "EU",
  profileContext: "primary",
  mfaVerified: true,
  mfaVerifiedAt: Date.now() - 60_000,
  refreshToken: "RT-admin",
} as Session & { refreshToken: string };

/** The refresh token Cognito hands back for the agent session. */
const ISSUED_REFRESH_TOKEN = "cognito-issued-agent-refresh-token";

function approveRoute() {
  const route = agentAuthorizeRoutes.find(
    (r) => r.path === "/agents/authorize/approve" && r.method === "POST",
  )!;
  const request = new Request("http://localhost/agents/authorize/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user_code=BCDF-GHJK",
  });
  return { route, request };
}

beforeEach(() => {
  _setRefreshStoresForTest(new MemoryKvStore(), new MemoryKvStore());

  mockGetSession.mockReset().mockResolvedValue(ADMIN_SESSION);
  mockApplyRateLimitKV.mockReset().mockResolvedValue(null);
  mockApproveDeviceAuth.mockReset();
  mockAuditEmit.mockReset();
  mockFindMember.mockReset().mockResolvedValue({
    id: "tm_admin",
    tenantId: "t_one",
    userId: "u_admin",
    role: "ADMIN",
    status: "ACTIVE",
    tenant: { id: "t_one", slug: "demo" },
  });
  mockFindUser.mockReset().mockResolvedValue({ subject: "cognito-sub-admin" });

  mockLookupDeviceCodeByUserCode.mockReset().mockResolvedValue("dc-good");
  mockLoadByDeviceCode.mockReset().mockResolvedValue({
    deviceCode: "dc-good",
    userCodeHash: hashUserCode(normaliseUserCode("BCDF-GHJK")),
    status: "pending",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    createdAt: Math.floor(Date.now() / 1000),
    interval: 5,
    failedLookups: 0,
    agentLabel: "test-agent/1.0",
  });
  mockIssueForAgent.mockReset().mockResolvedValue({
    access_token: "issued-agent-access-token",
    refresh_token: ISSUED_REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
  });

  _resetAgentAuthorizeDepsForTest();
  _setAgentAuthorizeDepsForTest({
    issuer: { issueForAgent: mockIssueForAgent },
    rateLimiter: {
      applyRateLimitKV: mockApplyRateLimitKV,
      checkRateLimit: vi.fn(),
      checkRateLimitKV: vi.fn(),
      applyRateLimit: vi.fn(),
    } as unknown as import("../../../src/lib/rate-limit.js").RateLimiter,
    auditEmitter: {
      emit: mockAuditEmit,
    } as unknown as import("../../../src/lib/audit-composer.js").TenantAuditEmitter,
  });
});

async function approve(): Promise<Response> {
  const { route, request } = approveRoute();
  return route.handler(request, ENV, {
    url: new URL(request.url),
    pathname: "/agents/authorize/approve",
    params: {},
  });
}

describe("D.2 — the approve path and the replay detector agree on the jti", () => {
  it("the token issued at approval is recognised, then detected as a replay", async () => {
    expect((await approve()).status).toBe(200);

    // FAILS AGAINST main: there the stored jti is `randomBytes(16)`, so the
    // presented token resolves to nothing and this is "unknown".
    const first = await consumeRefreshToken(ISSUED_REFRESH_TOKEN, SESSION_SECRET);
    expect(first.outcome).toBe("ok");
    expect(first.record?.sub).toBe("cognito-sub-admin");
    expect(first.record?.userId).toBe("u_admin");

    // Present the same token a second time — the whole point of the detector.
    const replay = await consumeRefreshToken(ISSUED_REFRESH_TOKEN, SESSION_SECRET);
    expect(replay.outcome).toBe("replay");
    expect(replay.record?.sessionId).toBe(first.record?.sessionId);
  });

  it("a token that was never issued stays unknown", async () => {
    expect((await approve()).status).toBe(200);
    const out = await consumeRefreshToken("a-token-we-never-issued", SESSION_SECRET);
    expect(out.outcome).toBe("unknown");
  });

  it("the chain survives a rotation: old token replays, new token is ok", async () => {
    expect((await approve()).status).toBe(200);
    const first = await consumeRefreshToken(ISSUED_REFRESH_TOKEN, SESSION_SECRET);
    expect(first.outcome).toBe("ok");

    const rotated = "cognito-rotated-agent-refresh-token";
    await rotateRefreshJti({
      sessionId: first.record!.sessionId,
      userId: first.record!.userId,
      sub: first.record!.sub,
      newRefreshToken: rotated,
      masterSecret: SESSION_SECRET,
    });

    // The session now points at the rotated token...
    const session = await getAgentSession(first.record!.sessionId);
    expect(session?.currentJti).not.toBe(first.record!.jti);
    // ...the rotated token is accepted once...
    expect((await consumeRefreshToken(rotated, SESSION_SECRET)).outcome).toBe("ok");
    // ...and the superseded one is a replay, not a silent pass.
    expect((await consumeRefreshToken(ISSUED_REFRESH_TOKEN, SESSION_SECRET)).outcome).toBe(
      "replay",
    );
  });

  it("a different master secret does not resolve the token (keys are separated)", async () => {
    expect((await approve()).status).toBe(200);
    const out = await consumeRefreshToken(
      ISSUED_REFRESH_TOKEN,
      "a-completely-different-master-secret-value",
    );
    expect(out.outcome).toBe("unknown");
  });
});
