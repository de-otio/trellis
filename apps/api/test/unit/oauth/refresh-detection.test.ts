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
 *  - revokeAgentSession invokes Cognito + audit + tombstones row.
 *  - F6: the consume read is strongly consistent (asserted structurally below).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";

import {
  consumeRefreshJti,
  getAgentSession,
  handleRefreshReplay,
  listAgentSessions,
  recordAgentSession,
  revokeAgentSession,
  rotateRefreshJti,
  _deleteAgentSessionForTest,
  _setRefreshStoresForTest,
  type AgentSessionRecord,
  type CognitoRevoker,
  type RefreshJtiRecord,
} from "../../../src/lib/oauth/refresh-detection.js";

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
    cognitoSub: "sub-alice",
    tenantId: "t_one",
    currentJti: "j_initial",
    status: "active",
    agentLabel: "test-agent/1.0",
    sourceIp: "1.2.3.0/24",
    createdAt: 1700000000,
    lastUsedAt: 1700000000,
    ...over,
  };
}

describe("recordAgentSession", () => {
  it("writes the session row + initial jti row", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    const session = await getAgentSession("s_one");
    expect(session?.userId).toBe("u_alice");
    expect(session?.currentJti).toBe("j_initial");
  });

  it("rejects a duplicate session create (attribute_not_exists equivalent)", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await expect(
      recordAgentSession({ session: makeSession(), initialJti: "j_other" }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("consumeRefreshJti", () => {
  it("returns ok and flips status to consumed on first use", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    const out = await consumeRefreshJti("j_initial");
    expect(out.outcome).toBe("ok");
    expect(out.record?.userId).toBe("u_alice");
    expect(out.record?.status).toBe("consumed");

    // Second consume of the same jti must report replay.
    const replay = await consumeRefreshJti("j_initial");
    expect(replay.outcome).toBe("replay");
  });

  it("returns unknown for an unrecognised jti", async () => {
    const out = await consumeRefreshJti("never-issued");
    expect(out.outcome).toBe("unknown");
  });

  it("F6: the consume read is strongly consistent", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    const spy = vi.spyOn(jtiStore, "get");
    await consumeRefreshJti("j_initial");
    // Every jti read on the consume path must request a consistent read.
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[1]).toMatchObject({ consistent: true });
    }
  });
});

describe("rotateRefreshJti", () => {
  it("issues a new jti row and advances the session pointer", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await consumeRefreshJti("j_initial");
    await rotateRefreshJti({
      sessionId: "s_one",
      userId: "u_alice",
      cognitoSub: "sub-alice",
      newJti: "j_two",
    });
    const session = await getAgentSession("s_one");
    expect(session?.currentJti).toBe("j_two");

    const out = await consumeRefreshJti("j_two");
    expect(out.outcome).toBe("ok");
  });
});

describe("handleRefreshReplay", () => {
  it("calls AdminUserGlobalSignOut + emits auth.refresh_replay (sec finding RFC 6819)", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await consumeRefreshJti("j_initial");
    const replay = await consumeRefreshJti("j_initial");
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
    expect(arg.payload.refreshJti).toBe("j_initial");
    expect(arg.payload.cognitoUserId).toBe("sub-alice");

    const session = await getAgentSession("s_one");
    expect(session?.status).toBe("revoked");
    expect(session?.currentJti).toBeNull();
  });

  it("CRITICAL-1: sources cognitoUsername from the jti record, ignoring caller-supplied alternates", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await consumeRefreshJti("j_initial");
    const replay = await consumeRefreshJti("j_initial");

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
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await consumeRefreshJti("j_initial");
    const replay = await consumeRefreshJti("j_initial");

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
    await recordAgentSession({ session: makeSession({ sessionId: "s_a" }), initialJti: "j_a" });
    await recordAgentSession({
      session: makeSession({ sessionId: "s_b", userId: "u_bob" }),
      initialJti: "j_b",
    });
    await recordAgentSession({
      session: makeSession({ sessionId: "s_c", status: "revoked" }),
      initialJti: "j_c",
    });

    const sessions = await listAgentSessions("u_alice");
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("s_a");
    expect(ids).not.toContain("s_b");
    expect(ids).not.toContain("s_c");
  });
});

describe("revokeAgentSession", () => {
  it("calls Cognito globalSignOut, marks the row revoked, emits audit", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    const cognito: CognitoRevoker = { globalSignOut: vi.fn(async () => undefined) };
    const audit = { emit: vi.fn(async () => undefined) };

    await revokeAgentSession({
      sessionId: "s_one",
      userPoolId: "us-east-1_pool",
      cognitoUsername: "sub-alice",
      cognito,
      audit,
      tenantId: "t_one",
      actorUserId: "u_alice",
      sourceIp: "1.2.3.4",
    });

    expect(cognito.globalSignOut).toHaveBeenCalledTimes(1);
    const session = await getAgentSession("s_one");
    expect(session?.status).toBe("revoked");
    expect(audit.emit).toHaveBeenCalled();
    const arg = audit.emit.mock.calls[0]![0] as { type: string };
    expect(arg.type).toBe("auth.agent_session.revoked");
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
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await _deleteAgentSessionForTest("s_one");
    expect(await getAgentSession("s_one")).toBeNull();
  });
});
