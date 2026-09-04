/**
 * Unit Tests: session revocation, session epoch, and inactivity fail-closed.
 *
 * Covers the security review's:
 *   - **L2 (High)** — "session revocation is write-only". `revokeSession()`
 *     wrote `blocked:{sha256(token)}` to the blocklist KV and **nothing ever
 *     read it**, so a token stayed valid for its full (up to 90-day) lifetime
 *     after logout. Both the cookie path and the Authorization path were
 *     unchecked. Plus the new per-user `sessionEpoch` "revoke all sessions".
 *   - **Phase 8** — the inactivity timeout was skipped entirely when
 *     `lastActivityAt` was absent, and was never applied at all on the
 *     Authorization path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type Session } from "../../src/lib/session-cookie.js";

vi.mock("../../src/lib/auth/cognito-jwt", () => ({
  verifyCognitoJwt: vi.fn(),
  verifyLegacyCognitoClaims: vi.fn(async () => {
    throw new Error("not a JWT");
  }),
}));

vi.mock("../../src/lib/identity/jit-claims", () => ({
  resolveJitClaims: vi.fn(async () => null),
}));

let inactivityTimeoutMinutes = 60;
vi.mock("../../src/lib/session-config", () => ({
  getSessionConfig: () => ({
    userSessionTimeoutDays: 90,
    ssoSessionTimeoutDays: 7,
    dashboardSessionTimeoutHours: 24,
    refreshThresholdHours: 1,
    inactivityTimeoutMinutes,
  }),
  calculateCookieMaxAge: () => 90 * 24 * 60 * 60,
}));

const SECRET = "test-secret-key-32-characters-long!!";
const SALT = "test-session-salt-for-unit-tests";

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

/** A KV whose reads always fail — models an unreachable backend. */
function brokenKv() {
  return {
    get: vi.fn(async () => {
      throw new Error("KV unreachable");
    }),
    put: vi.fn(async () => {
      throw new Error("KV unreachable");
    }),
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: "user-abc",
    email: "user@example.com",
    expiresAt: Date.now() + 3_600_000,
    profileContext: "primary",
    dataRegion: "EU",
    lastActivityAt: Date.now(),
    ...overrides,
  } as Session;
}

/**
 * Advance real wall-clock past a millisecond boundary. The epoch comparison is
 * `sealEpoch < storedEpoch`, so a seal and a revoke landing in the SAME
 * millisecond would (correctly) not invalidate — this keeps the tests
 * deterministic rather than racing the clock.
 */
async function tick(): Promise<void> {
  const start = Date.now();
  while (Date.now() <= start) await new Promise((r) => setTimeout(r, 2));
}

function cookieRequest(token: string): Request {
  return new Request("https://example.com/api/test", {
    headers: { Cookie: `trellis_session=${token}` },
  });
}

function bearerRequest(token: string): Request {
  return new Request("https://example.com/api/test", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("SEC L2 — session revocation blocklist is READ, not just written", () => {
  let sm: SessionManager;
  let kv: ReturnType<typeof memoryKv>;
  let env: any;

  beforeEach(() => {
    inactivityTimeoutMinutes = 60;
    sm = new SessionManager();
    kv = memoryKv();
    env = { SESSION_SALT: SALT, SESSION_BLOCKLIST_KV: kv };
  });

  it("cookie path: a session is valid before revocation", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const session = await sm.getSession(cookieRequest(token), SECRET, env);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-abc");
  });

  it("cookie path: after revokeSession, the SAME token no longer authenticates", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const req = cookieRequest(token);

    expect(await sm.getSession(req, SECRET, env)).not.toBeNull();

    await sm.revokeSession(req, env);

    expect(await sm.getSession(cookieRequest(token), SECRET, env)).toBeNull();
  });

  it("Authorization path: after revokeSession, the SAME token no longer authenticates", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const req = bearerRequest(token);

    expect(await sm.getSession(req, SECRET, env)).not.toBeNull();

    await sm.revokeSession(req, env);

    expect(await sm.getSession(bearerRequest(token), SECRET, env)).toBeNull();
  });

  it("reads the EXACT key format revokeSession writes (`blocked:{sha256}`)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    await sm.revokeSession(cookieRequest(token), env);

    const writtenKeys = [...kv.store.keys()];
    expect(writtenKeys).toHaveLength(1);
    expect(writtenKeys[0]).toMatch(/^blocked:[0-9a-f]{64}$/);

    // And the reader asks for that same key.
    kv.get.mockClear();
    await sm.getSession(cookieRequest(token), SECRET, env);
    expect(kv.get).toHaveBeenCalledWith(writtenKeys[0]);
  });

  it("revoking ONE token does not revoke another user's token", async () => {
    const tokenA = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "a" })),
      SECRET,
      SALT,
    );
    const tokenB = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "b" })),
      SECRET,
      SALT,
    );

    await sm.revokeSession(cookieRequest(tokenA), env);

    expect(await sm.getSession(cookieRequest(tokenA), SECRET, env)).toBeNull();
    expect(
      await sm.getSession(cookieRequest(tokenB), SECRET, env),
    ).not.toBeNull();
  });

  it("FAILS CLOSED when the blocklist KV read throws (cookie path)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const brokenEnv = {
      SESSION_SALT: SALT,
      SESSION_BLOCKLIST_KV: brokenKv(),
    };

    expect(
      await sm.getSession(cookieRequest(token), SECRET, brokenEnv),
    ).toBeNull();
  });

  it("FAILS CLOSED when the blocklist KV read throws (Authorization path)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const brokenEnv = {
      SESSION_SALT: SALT,
      SESSION_BLOCKLIST_KV: brokenKv(),
    };

    expect(
      await sm.getSession(bearerRequest(token), SECRET, brokenEnv),
    ).toBeNull();
  });

  it("no KV bound: sessions still work (deployment shape, not an outage)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const noKvEnv = { SESSION_SALT: SALT };
    expect(
      await sm.getSession(cookieRequest(token), SECRET, noKvEnv),
    ).not.toBeNull();
  });

  it("no KV bound + SESSION_BLOCKLIST_REQUIRED=true: denies", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const strictEnv = {
      SESSION_SALT: SALT,
      SESSION_BLOCKLIST_REQUIRED: "true",
    };
    expect(
      await sm.getSession(cookieRequest(token), SECRET, strictEnv),
    ).toBeNull();
  });
});

describe("SEC L2 — sessionEpoch ('revoke all sessions')", () => {
  let sm: SessionManager;
  let kv: ReturnType<typeof memoryKv>;
  let env: any;

  beforeEach(() => {
    inactivityTimeoutMinutes = 60;
    sm = new SessionManager();
    kv = memoryKv();
    env = { SESSION_SALT: SALT, SESSION_BLOCKLIST_KV: kv };
  });

  it("every sealed session carries a sessionEpoch (stamped at the seal chokepoint)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    const decrypted = await sm.decryptSession(token, SECRET, SALT);
    expect(typeof JSON.parse(decrypted!).sessionEpoch).toBe("number");
  });

  it("revokeAllSessions invalidates EVERY existing session for that user", async () => {
    const t1 = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim" })),
      SECRET,
      SALT,
    );
    const t2 = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim" })),
      SECRET,
      SALT,
    );
    expect(await sm.getSession(cookieRequest(t1), SECRET, env)).not.toBeNull();
    expect(await sm.getSession(cookieRequest(t2), SECRET, env)).not.toBeNull();

    // Bump the epoch strictly past both seal times.
    await tick();
    await sm.revokeAllSessions("victim", env);

    expect(await sm.getSession(cookieRequest(t1), SECRET, env)).toBeNull();
    expect(await sm.getSession(cookieRequest(t2), SECRET, env)).toBeNull();
  });

  it("revokeAllSessions is scoped to one user", async () => {
    const victim = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim" })),
      SECRET,
      SALT,
    );
    const bystander = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "bystander" })),
      SECRET,
      SALT,
    );

    await tick();
    await sm.revokeAllSessions("victim", env);

    expect(await sm.getSession(cookieRequest(victim), SECRET, env)).toBeNull();
    expect(
      await sm.getSession(cookieRequest(bystander), SECRET, env),
    ).not.toBeNull();
  });

  it("a session sealed AFTER the bump is accepted (re-login works)", async () => {
    await sm.revokeAllSessions("victim", env);

    // Seal strictly after the recorded epoch.
    await tick();
    const fresh = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim" })),
      SECRET,
      SALT,
    );

    expect(await sm.getSession(cookieRequest(fresh), SECRET, env)).not.toBeNull();
  });

  it("a legacy session with NO sessionEpoch is killed by any stored epoch", async () => {
    // Seal a payload that already declares sessionEpoch 0 — the same treatment
    // `isEpochStale` gives a payload sealed before this field existed.
    const legacy = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim", sessionEpoch: 0 })),
      SECRET,
      SALT,
    );
    await sm.revokeAllSessions("victim", env);

    expect(await sm.getSession(cookieRequest(legacy), SECRET, env)).toBeNull();
  });

  it("the epoch check applies on the Authorization path too", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession({ userId: "victim" })),
      SECRET,
      SALT,
    );
    await tick();
    await sm.revokeAllSessions("victim", env);

    expect(await sm.getSession(bearerRequest(token), SECRET, env)).toBeNull();
  });

  it("revokeAllSessions refuses silently-succeeding when no KV is configured", async () => {
    await expect(sm.revokeAllSessions("victim", {})).rejects.toThrow(
      /SESSION_BLOCKLIST_KV/,
    );
  });

  it("a corrupt stored epoch does not lock everyone out", async () => {
    kv.store.set("sessionepoch:user-abc", "not-a-number");
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).not.toBeNull();
  });
});

describe("Phase 8 — inactivity timeout fails CLOSED", () => {
  let sm: SessionManager;
  let env: any;

  beforeEach(() => {
    inactivityTimeoutMinutes = 60;
    sm = new SessionManager();
    env = { SESSION_SALT: SALT };
  });

  it("cookie path: an idle session past the timeout is rejected", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(
        baseSession({ lastActivityAt: Date.now() - 61 * 60 * 1000 }),
      ),
      SECRET,
      SALT,
    );
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).toBeNull();
  });

  it("cookie path: a session with NO lastActivityAt falls back to the seal-time epoch", async () => {
    // Freshly sealed: no lastActivityAt, but sessionEpoch == now ⇒ active.
    const s = baseSession();
    delete (s as any).lastActivityAt;
    const token = await sm.encryptSession(JSON.stringify(s), SECRET, SALT);
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).not.toBeNull();
  });

  it("cookie path: NO lastActivityAt and a stale seal epoch ⇒ rejected (was: check skipped)", async () => {
    const s = baseSession({ sessionEpoch: Date.now() - 61 * 60 * 1000 });
    delete (s as any).lastActivityAt;
    const token = await sm.encryptSession(JSON.stringify(s), SECRET, SALT);
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).toBeNull();
  });

  it("cookie path: NEITHER timestamp ⇒ rejected, not silently allowed", async () => {
    // A payload sealed before this change: no lastActivityAt AND no epoch.
    // `encryptSession` would stamp one, so build the sealed blob by hand via a
    // non-session-shaped key trick is not possible — instead assert the
    // equivalent through the public surface: epoch 0 + no activity is treated
    // as "no evidence of recent activity".
    const s = baseSession({ sessionEpoch: 0 });
    delete (s as any).lastActivityAt;
    const token = await sm.encryptSession(JSON.stringify(s), SECRET, SALT);
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).toBeNull();
  });

  it("Authorization path: the inactivity timeout is now ENFORCED (was: expiresAt only)", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(
        baseSession({
          // Still well within expiresAt, but idle far past the timeout.
          expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
          lastActivityAt: Date.now() - 61 * 60 * 1000,
        }),
      ),
      SECRET,
      SALT,
    );
    expect(await sm.getSession(bearerRequest(token), SECRET, env)).toBeNull();
  });

  it("Authorization path: an active session still passes", async () => {
    const token = await sm.encryptSession(
      JSON.stringify(baseSession()),
      SECRET,
      SALT,
    );
    expect(await sm.getSession(bearerRequest(token), SECRET, env)).not.toBeNull();
  });

  it("a zero/disabled inactivity timeout skips the check entirely", async () => {
    inactivityTimeoutMinutes = 0;
    const s = baseSession({ sessionEpoch: 0 });
    delete (s as any).lastActivityAt;
    const token = await sm.encryptSession(JSON.stringify(s), SECRET, SALT);
    expect(await sm.getSession(cookieRequest(token), SECRET, env)).not.toBeNull();
  });
});
