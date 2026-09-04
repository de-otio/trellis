/**
 * Unit tests: agent-session revocation, end to end against a real session
 * read path (plan 034 lane D, D.1).
 *
 * The lane-D fix rests on one claim that spans two modules: the key
 * `revokeAgentSession` writes into `SESSION_BLOCKLIST_KV` is the key
 * `SessionManager` looks up on every session read. `session-cookie.ts` belongs
 * to another lane and does not export its key builder, so `refresh-detection.ts`
 * restates the format — and this file is the pin that makes the duplication
 * safe: if either side changes, the parity test fails.
 *
 * The second test is the finding itself, asserted rather than argued: two
 * sessions for one user, revoke one, the other still authenticates. Against the
 * old code that was impossible — revoking called `AdminUserGlobalSignOut` on
 * the human's sub, which is a denial of service on their own account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore } from "@de-otio/saas-foundation/kv";
import { SessionManager, type Session } from "../../../src/lib/session-cookie.js";
import {
  deriveRefreshJti,
  hashSessionToken,
  recordAgentSession,
  revokeAgentSession,
  sessionBlocklistKey,
  _setRefreshStoresForTest,
  type AgentSessionRecord,
} from "../../../src/lib/oauth/refresh-detection.js";

vi.mock("../../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: vi.fn(),
  verifyLegacyCognitoClaims: vi.fn(async () => {
    throw new Error("not a JWT");
  }),
}));

vi.mock("../../../src/lib/identity/jit-claims", () => ({
  resolveJitClaims: vi.fn(async () => null),
}));

vi.mock("../../../src/lib/session-config", () => ({
  getSessionConfig: () => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes: 60,
  }),
  calculateCookieMaxAge: () => 90 * 24 * 60 * 60,
}));

const SECRET = "test-secret-key-32-characters-long!!";
const SALT = "test-session-salt-for-unit-tests";
const JTI_MASTER = "test-agent-refresh-master-secret-0123456789";

/** In-memory stand-in for `SESSION_BLOCKLIST_KV`. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "u_alice",
    email: "alice@example.com",
    expiresAt: Date.now() + 3_600_000,
    profileContext: "primary",
    dataRegion: "EU",
    lastActivityAt: Date.now(),
    ...overrides,
  } as Session;
}

function bearerRequest(token: string): Request {
  return new Request("https://example.com/api/test", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function agentRecord(over: Partial<AgentSessionRecord>, refreshToken: string): AgentSessionRecord {
  return {
    sessionId: "s_one",
    userId: "u_alice",
    sub: "sub-alice",
    tenantId: "t_one",
    currentJti: deriveRefreshJti(refreshToken, JTI_MASTER),
    status: "active",
    createdAt: 1700000000,
    lastUsedAt: 1700000000,
    ...over,
  };
}

let sm: SessionManager;
let kv: ReturnType<typeof memoryKv>;
let env: Record<string, unknown>;

beforeEach(() => {
  sm = new SessionManager();
  kv = memoryKv();
  env = { SESSION_SALT: SALT, SESSION_BLOCKLIST_KV: kv };
  // Fresh in-memory agent-refresh stores per test.
  _setRefreshStoresForTest(new MemoryKvStore(), new MemoryKvStore());
});

describe("blocklist key parity between refresh-detection and session-cookie", () => {
  it("revokeAgentSession writes the key SessionManager.revokeSession writes", async () => {
    const token = "an-opaque-agent-access-token";

    // What `session-cookie.ts` writes for this token, observed rather than
    // assumed — it is the module that owns the format.
    await sm.revokeSession(bearerRequest(token), env);
    const keysWrittenBySessionManager = [...kv.store.keys()];
    expect(keysWrittenBySessionManager).toHaveLength(1);

    // What this lane computes for the same token.
    expect(sessionBlocklistKey(hashSessionToken(token))).toBe(
      keysWrittenBySessionManager[0],
    );
  });

  it("the hash is sha256-hex of the raw token, not the token", () => {
    const hash = hashSessionToken("an-opaque-agent-access-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("an-opaque-agent-access-token");
  });
});

describe("D.1 — revoking one agent session leaves the user's others valid", () => {
  it("the revoked session's token is rejected; the other still authenticates", async () => {
    // Two live sessions for the SAME person, as an agent-connected account has:
    // one the partner integration holds, one on their phone.
    const agentToken = await sm.encryptSession(JSON.stringify(baseSession()), SECRET, SALT);
    const phoneToken = await sm.encryptSession(
      JSON.stringify(baseSession({ email: "alice+phone@example.com" })),
      SECRET,
      SALT,
    );

    // Both authenticate before the revoke.
    expect(await sm.getSession(bearerRequest(agentToken), SECRET, env)).not.toBeNull();
    expect(await sm.getSession(bearerRequest(phoneToken), SECRET, env)).not.toBeNull();

    await recordAgentSession({
      session: agentRecord(
        { sessionId: "s_agent", accessTokenHash: hashSessionToken(agentToken) },
        "refresh-token-agent",
      ),
      refreshToken: "refresh-token-agent",
      masterSecret: JTI_MASTER,
    });

    await revokeAgentSession({
      sessionId: "s_agent",
      audit: { emit: vi.fn(async () => undefined) },
      tenantId: "t_one",
      actorUserId: "u_alice",
      blocklist: kv,
    });

    // The named session is dead...
    expect(await sm.getSession(bearerRequest(agentToken), SECRET, env)).toBeNull();
    // ...and the person is still signed in everywhere else. This is the
    // assertion that was impossible to satisfy before the fix.
    const survivor = await sm.getSession(bearerRequest(phoneToken), SECRET, env);
    expect(survivor).not.toBeNull();
    expect(survivor?.userId).toBe("u_alice");
  });

  it("does not bump the per-user session epoch (that is the global instrument)", async () => {
    const token = await sm.encryptSession(JSON.stringify(baseSession()), SECRET, SALT);
    await recordAgentSession({
      session: agentRecord(
        { sessionId: "s_agent", accessTokenHash: hashSessionToken(token) },
        "refresh-token-agent",
      ),
      refreshToken: "refresh-token-agent",
      masterSecret: JTI_MASTER,
    });

    await revokeAgentSession({
      sessionId: "s_agent",
      audit: { emit: vi.fn(async () => undefined) },
      tenantId: "t_one",
      actorUserId: "u_alice",
      blocklist: kv,
    });

    // `sessionepoch:{userId}` is the "revoke everything" switch. A per-session
    // revoke must never touch it, or every other session dies with it.
    expect([...kv.store.keys()].some((k) => k.startsWith("sessionepoch:"))).toBe(false);
  });
});
