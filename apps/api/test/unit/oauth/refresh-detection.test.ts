/**
 * Unit tests: refresh-detection.ts — behavior-comparison suite (WS-1 §3.7).
 *
 * The pre-port suite mocked `@aws-sdk/client-dynamodb` and asserted command
 * shapes. Post-port the status transitions are read(consistent)→compareAndSet,
 * so this suite asserts OUTCOME EQUIVALENCE against injected `MemoryKvStore`s
 * (one for jti rows, one for session rows) — the same observable results the
 * DynamoDB code produced:
 *  - First refresh: jti flips to consumed, new jti issued.
 *  - Replay: same jti seen twice → AdminUserGlobalSignOut + `auth.refresh_replay`.
 *  - Unknown jti: `unknown` outcome.
 *  - listAgentSessions filters by user + status=active.
 *  - revokeAgentSession blocklists only the named session's token, drops its
 *    refresh jti and tombstones its row — and never calls Cognito (D.1).
 *  - adminGlobalSignOutUser is the separately-named deliberate global action.
 *  - the stored jti is derived from the issued refresh token (D.2), so a token
 *    presented later resolves to the row written when it was issued.
 *  - F6: the consume read is strongly consistent (asserted structurally below).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";

import {
  adminGlobalSignOutUser,
  consumeRefreshJti,
  consumeRefreshToken,
  deriveRefreshJti,
  getAgentSession,
  handleRefreshReplay,
  listAgentSessions,
  recordAgentSession,
  revokeAgentSession,
  rotateRefreshJti,
  sessionBlocklistKey,
  _deleteAgentSessionForTest,
  _setRefreshStoresForTest,
  type AgentSessionRecord,
  type CognitoRevoker,
  type RefreshJtiRecord,
} from "../../../src/lib/oauth/refresh-detection.js";

/**
 * Master secret for the jti HMAC sub-key. `deriveSubKey` refuses anything
 * shorter than 32 characters, which is the same floor the real secret has.
 */
const SECRET = "test-agent-refresh-master-secret-0123456789";
const RT_ONE = "cognito-opaque-refresh-token-one";
const RT_TWO = "cognito-opaque-refresh-token-two";
const JTI_ONE = deriveRefreshJti(RT_ONE, SECRET);
const JTI_TWO = deriveRefreshJti(RT_TWO, SECRET);

let jtiStore: MemoryKvStore;
let sessionStore: MemoryKvStore;

beforeEach(() => {
  jtiStore = new MemoryKvStore();
  sessionStore = new MemoryKvStore();
  _setRefreshStoresForTest(jtiStore, sessionStore);
});

function makeSession(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: "s_one",
    userId: "u_alice",
    sub: "sub-alice",
    tenantId: "t_one",
    currentJti: JTI_ONE,
    status: "active",
    agentLabel: "test-agent/1.0",
    sourceIp: "1.2.3.0/24",
    createdAt: 1700000000,
    lastUsedAt: 1700000000,
    ...over,
  };
}

/** Record a session whose jti is derived from `refreshToken`, as production does. */
function record(
  over: Partial<AgentSessionRecord> = {},
  refreshToken = RT_ONE,
): Promise<void> {
  return recordAgentSession({
    session: makeSession({ currentJti: deriveRefreshJti(refreshToken, SECRET), ...over }),
    refreshToken,
    masterSecret: SECRET,
  });
}

describe("recordAgentSession", () => {
  it("writes the session row + initial jti row", async () => {
    await record();
    const session = await getAgentSession("s_one");
    expect(session?.userId).toBe("u_alice");
    expect(session?.currentJti).toBe(JTI_ONE);
  });

  it("rejects a duplicate session create (attribute_not_exists equivalent)", async () => {
    await record();
    await expect(record()).rejects.toThrow(/already exists/);
  });
});

describe("consumeRefreshJti", () => {
  it("returns ok and flips status to consumed on first use", async () => {
    await record();
    const out = await consumeRefreshJti(JTI_ONE);
    expect(out.outcome).toBe("ok");
    expect(out.record?.userId).toBe("u_alice");
    expect(out.record?.status).toBe("consumed");

    // Second consume of the same jti must report replay.
    const replay = await consumeRefreshJti(JTI_ONE);
    expect(replay.outcome).toBe("replay");
  });

  it("returns unknown for an unrecognised jti", async () => {
    const out = await consumeRefreshJti("never-issued");
    expect(out.outcome).toBe("unknown");
  });

  it("F6: the consume read is strongly consistent", async () => {
    await record();
    const spy = vi.spyOn(jtiStore, "get");
    await consumeRefreshJti(JTI_ONE);
    // Every jti read on the consume path must request a consistent read.
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[1]).toMatchObject({ consistent: true });
    }
  });
});

describe("rotateRefreshJti", () => {
  it("issues a new jti row and advances the session pointer", async () => {
    await record();
    await consumeRefreshJti(JTI_ONE);
    await rotateRefreshJti({
      sessionId: "s_one",
      userId: "u_alice",
      sub: "sub-alice",
      newRefreshToken: RT_TWO,
      masterSecret: SECRET,
    });
    const session = await getAgentSession("s_one");
    expect(session?.currentJti).toBe(JTI_TWO);

    const out = await consumeRefreshJti(JTI_TWO);
    expect(out.outcome).toBe("ok");
  });
});

describe("handleRefreshReplay", () => {
  it("calls AdminUserGlobalSignOut + emits auth.refresh_replay (sec finding RFC 6819)", async () => {
    await record();
    await consumeRefreshJti(JTI_ONE);
    const replay = await consumeRefreshJti(JTI_ONE);
    expect(replay.outcome).toBe("replay");

    const cognito: CognitoRevoker = { globalSignOut: vi.fn(async () => undefined) };
    const audit = { emit: vi.fn(async () => undefined) };

    await handleRefreshReplay({
      jtiRecord: replay.record as RefreshJtiRecord,
      tenantId: "t_one",
      userPoolId: "us-east-1_pool",
      cognito,
      audit,
      sourceIp: "1.2.3.4",
    });

    expect(cognito.globalSignOut).toHaveBeenCalledTimes(1);
    // CRITICAL-1: cognitoUsername is sourced from the jti record, not callers.
    expect(cognito.globalSignOut).toHaveBeenCalledWith({
      userPoolId: "us-east-1_pool",
      cognitoUsername: "sub-alice",
    });
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const arg = audit.emit.mock.calls[0]![0] as { type: string; payload: Record<string, unknown> };
    expect(arg.type).toBe("auth.refresh_replay");
    expect(arg.payload.refreshJti).toBe(JTI_ONE);
    expect(arg.payload.cognitoUserId).toBe("sub-alice");

    const session = await getAgentSession("s_one");
    expect(session?.status).toBe("revoked");
    expect(session?.currentJti).toBeNull();
  });

  it("CRITICAL-1: sources cognitoUsername from the jti record, ignoring caller-supplied alternates", async () => {
    await record();
    await consumeRefreshJti(JTI_ONE);
    const replay = await consumeRefreshJti(JTI_ONE);

    const cognito: CognitoRevoker = { globalSignOut: vi.fn(async () => undefined) };
    const audit = { emit: vi.fn(async () => undefined) };

    await handleRefreshReplay({
      jtiRecord: replay.record as RefreshJtiRecord,
      tenantId: "t_one",
      userPoolId: "us-east-1_pool",
      cognito,
      audit,
      // @ts-expect-error verifying runtime behaviour against an extra prop
      cognitoUsername: "ATTACKER-VALUE",
    });

    expect(cognito.globalSignOut).toHaveBeenCalledWith({
      userPoolId: "us-east-1_pool",
      cognitoUsername: "sub-alice",
    });
  });

  it("CRITICAL-2: emits the audit event before the Cognito call so failures cannot suppress it", async () => {
    await record();
    await consumeRefreshJti(JTI_ONE);
    const replay = await consumeRefreshJti(JTI_ONE);

    const cognito: CognitoRevoker = {
      globalSignOut: vi.fn(async () => {
        throw new Error("cognito unavailable");
      }),
    };
    const audit = { emit: vi.fn(async () => undefined) };

    await expect(
      handleRefreshReplay({
        jtiRecord: replay.record as RefreshJtiRecord,
        tenantId: "t_one",
        userPoolId: "us-east-1_pool",
        cognito,
        audit,
      }),
    ).rejects.toThrow(/cognito unavailable/);

    // Audit must have been emitted even though Cognito threw.
    expect(audit.emit).toHaveBeenCalledTimes(1);
    // And the local session row must already be tombstoned.
    const session = await getAgentSession("s_one");
    expect(session?.status).toBe("revoked");
  });
});

describe("listAgentSessions", () => {
  it("returns only sessions for the requested user, filtered by status=active", async () => {
    await record({ sessionId: "s_a" });
    await record({ sessionId: "s_b", userId: "u_bob" }, RT_TWO);
    await record({ sessionId: "s_c", status: "revoked" }, "cognito-opaque-refresh-token-three");

    const sessions = await listAgentSessions("u_alice");
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("s_a");
    expect(ids).not.toContain("s_b");
    expect(ids).not.toContain("s_c");
  });
});

/** In-memory stand-in for the `SESSION_BLOCKLIST_KV` write surface. */
function memoryBlocklist() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

describe("revokeAgentSession — D.1, session-scoped", () => {
  it("blocklists only this session's token, drops its jti, tombstones its row", async () => {
    const hash = "a".repeat(64);
    await record({ accessTokenHash: hash });
    const audit = { emit: vi.fn(async () => undefined) };
    const blocklist = memoryBlocklist();

    const out = await revokeAgentSession({
      sessionId: "s_one",
      audit,
      tenantId: "t_one",
      actorUserId: "u_alice",
      sourceIp: "1.2.3.4",
      blocklist,
    });

    expect(out.tokenBlocklisted).toBe(true);
    expect(blocklist.store.get(sessionBlocklistKey(hash))).toBe("1");
    // TTL must be supplied — a blocklist entry with no expiry is a leak, one
    // with a short expiry is a bypass.
    expect(blocklist.put.mock.calls[0]![2]).toMatchObject({
      expirationTtl: expect.any(Number),
    });

    const session = await getAgentSession("s_one");
    expect(session?.status).toBe("revoked");
    expect(session?.currentJti).toBeNull();

    // The refresh jti is GONE, not "consumed" — a later presentation must be
    // denied as unknown, never classified as a replay (which escalates to a
    // global sign-out and would reintroduce the blast radius by the back door).
    expect((await consumeRefreshJti(JTI_ONE)).outcome).toBe("unknown");

    const arg = audit.emit.mock.calls[0]![0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(arg.type).toBe("auth.agent_session.revoked");
    expect(arg.payload.scope).toBe("session");
  });

  it("leaves the user's OTHER agent sessions authenticating (the whole finding)", async () => {
    await record({ sessionId: "s_keep", accessTokenHash: "b".repeat(64) }, RT_TWO);
    await record({ sessionId: "s_kill", accessTokenHash: "c".repeat(64) }, RT_ONE);
    const blocklist = memoryBlocklist();

    await revokeAgentSession({
      sessionId: "s_kill",
      audit: { emit: vi.fn(async () => undefined) },
      tenantId: "t_one",
      actorUserId: "u_alice",
      blocklist,
    });

    // The surviving session is still listed, still active...
    const remaining = await listAgentSessions("u_alice");
    expect(remaining.map((s) => s.sessionId)).toEqual(["s_keep"]);
    // ...its refresh token still consumes cleanly...
    expect((await consumeRefreshToken(RT_TWO, SECRET)).outcome).toBe("ok");
    // ...and its access token was never blocklisted.
    expect(blocklist.store.has(sessionBlocklistKey("b".repeat(64)))).toBe(false);
    expect(blocklist.store.has(sessionBlocklistKey("c".repeat(64)))).toBe(true);
  });

  it("reports tokenBlocklisted=false for a row written before accessTokenHash existed", async () => {
    await record();
    const out = await revokeAgentSession({
      sessionId: "s_one",
      audit: { emit: vi.fn(async () => undefined) },
      tenantId: "t_one",
      actorUserId: "u_alice",
      blocklist: memoryBlocklist(),
    });
    expect(out.tokenBlocklisted).toBe(false);
    expect((await getAgentSession("s_one"))?.status).toBe("revoked");
  });

  it("propagates a failed blocklist write instead of reporting success", async () => {
    await record({ accessTokenHash: "d".repeat(64) });
    await expect(
      revokeAgentSession({
        sessionId: "s_one",
        audit: { emit: vi.fn(async () => undefined) },
        tenantId: "t_one",
        actorUserId: "u_alice",
        blocklist: {
          put: vi.fn(async () => {
            throw new Error("KV unreachable");
          }),
        },
      }),
    ).rejects.toThrow(/KV unreachable/);
    // The session must NOT be tombstoned by a revocation that did not persist.
    expect((await getAgentSession("s_one"))?.status).toBe("active");
  });
});

describe("adminGlobalSignOutUser — D.1, the deliberate global action", () => {
  it("signs the subject out at the IdP and tombstones every agent session", async () => {
    await record({ sessionId: "s_a" }, RT_ONE);
    await record({ sessionId: "s_b" }, RT_TWO);
    const cognito: CognitoRevoker = { globalSignOut: vi.fn(async () => undefined) };
    const audit = { emit: vi.fn(async () => undefined) };

    const out = await adminGlobalSignOutUser({
      userId: "u_alice",
      cognitoUsername: "sub-alice",
      userPoolId: "us-east-1_pool",
      cognito,
      audit,
      tenantId: "t_one",
      actorUserId: "u_alice",
      reason: "credential compromise",
      sourceIp: "1.2.3.4",
    });

    expect(out.agentSessionsRevoked).toBe(2);
    expect(cognito.globalSignOut).toHaveBeenCalledWith({
      userPoolId: "us-east-1_pool",
      cognitoUsername: "sub-alice",
    });
    expect(await listAgentSessions("u_alice")).toHaveLength(0);

    const arg = audit.emit.mock.calls[0]![0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(arg.type).toBe("auth.global_sign_out");
    expect(arg.payload.scope).toBe("global");
    expect(arg.payload.reason).toBe("credential compromise");
  });

  it("CRITICAL-2 shape: emits the audit event before the Cognito call", async () => {
    await record();
    const cognito: CognitoRevoker = {
      globalSignOut: vi.fn(async () => {
        throw new Error("cognito unavailable");
      }),
    };
    const audit = { emit: vi.fn(async () => undefined) };

    await expect(
      adminGlobalSignOutUser({
        userId: "u_alice",
        cognitoUsername: "sub-alice",
        userPoolId: "us-east-1_pool",
        cognito,
        audit,
        tenantId: "t_one",
        actorUserId: "u_alice",
        reason: "credential compromise",
      }),
    ).rejects.toThrow(/cognito unavailable/);
    expect(audit.emit).toHaveBeenCalledTimes(1);
  });
});

describe("D.2 — the stored jti is derived from the issued refresh token", () => {
  it("a token presented later resolves to the row written when it was issued", async () => {
    await record({}, RT_ONE);

    // The end-to-end property the old `randomBytes(16)` jti made impossible:
    // present the token itself, not a jti the caller happens to remember.
    const first = await consumeRefreshToken(RT_ONE, SECRET);
    expect(first.outcome).toBe("ok");

    // Presenting the SAME token again is a replay, detected.
    const second = await consumeRefreshToken(RT_ONE, SECRET);
    expect(second.outcome).toBe("replay");
    expect(second.record?.sessionId).toBe("s_one");
  });

  it("a foreign token is unknown, not silently accepted", async () => {
    await record({}, RT_ONE);
    expect((await consumeRefreshToken("some-other-token", SECRET)).outcome).toBe(
      "unknown",
    );
  });

  it("derivation is deterministic, token-specific and secret-specific", () => {
    expect(deriveRefreshJti(RT_ONE, SECRET)).toBe(deriveRefreshJti(RT_ONE, SECRET));
    expect(deriveRefreshJti(RT_ONE, SECRET)).not.toBe(deriveRefreshJti(RT_TWO, SECRET));
    expect(deriveRefreshJti(RT_ONE, SECRET)).not.toBe(
      deriveRefreshJti(RT_ONE, "a-completely-different-master-secret-value"),
    );
    // The jti must not be the token, nor a bare digest an attacker with the
    // table could recompute without the secret.
    expect(deriveRefreshJti(RT_ONE, SECRET)).not.toContain(RT_ONE);
  });

  it("assertion at the write site: a session whose currentJti is not the token's is refused", async () => {
    await expect(
      recordAgentSession({
        session: makeSession({ currentJti: "j_hand-rolled-random-value" }),
        refreshToken: RT_ONE,
        masterSecret: SECRET,
      }),
    ).rejects.toThrow(/does not match the jti derived/);
    // Nothing was written — the session row must not exist.
    expect(await getAgentSession("s_one")).toBeNull();
  });

  it("rotation stores the jti of the NEW token, keeping the chain intact", async () => {
    await record({}, RT_ONE);
    await consumeRefreshToken(RT_ONE, SECRET);
    await rotateRefreshJti({
      sessionId: "s_one",
      userId: "u_alice",
      sub: "sub-alice",
      newRefreshToken: RT_TWO,
      masterSecret: SECRET,
    });
    expect((await consumeRefreshToken(RT_TWO, SECRET)).outcome).toBe("ok");
    expect((await consumeRefreshToken(RT_TWO, SECRET)).outcome).toBe("replay");
  });
});

describe("consumeRefreshJti error rethrow", () => {
  it("rethrows non-conditional store errors", async () => {
    const failing: KvStore = {
      ...new MemoryKvStore(),
      get: () => Promise.reject(new Error("dynamodb network failure")),
    } as unknown as KvStore;
    _setRefreshStoresForTest(failing, sessionStore);
    await expect(consumeRefreshJti("anything")).rejects.toThrow(/dynamodb network/);
  });
});

describe("getAgentSession + helpers", () => {
  it("returns null for unknown session id", async () => {
    const s = await getAgentSession("missing");
    expect(s).toBeNull();
  });

  it("_deleteAgentSessionForTest removes the row", async () => {
    await record();
    await _deleteAgentSessionForTest("s_one");
    expect(await getAgentSession("s_one")).toBeNull();
  });
});
