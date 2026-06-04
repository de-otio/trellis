/**
 * Unit tests: refresh-detection.ts
 *
 * Coverage floor: 100% lines.
 *
 * Covers:
 *  - First refresh: jti flips to consumed, new jti issued.
 *  - Replay: same jti seen twice → AdminUserGlobalSignOut called +
 *    `auth.refresh_replay` audit event emitted.
 *  - Unknown jti: returns `unknown` outcome.
 *  - listAgentSessions filters by user.
 *  - revokeAgentSession invokes Cognito + audit + tombstones row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, store } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  store: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class FakeCmd {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return {
    DynamoDBClient: class {
      send = mockSend;
    },
    GetItemCommand: class extends FakeCmd {},
    PutItemCommand: class extends FakeCmd {},
    DeleteItemCommand: class extends FakeCmd {},
    UpdateItemCommand: class extends FakeCmd {},
    QueryCommand: class extends FakeCmd {},
    ConditionalCheckFailedException: class extends Error {
      constructor(msg = "cond-failed") {
        super(msg);
        this.name = "ConditionalCheckFailedException";
      }
    },
  };
});

vi.mock("@aws-sdk/util-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/util-dynamodb")>("@aws-sdk/util-dynamodb");
  return actual;
});

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

import {
  consumeRefreshJti,
  getAgentSession,
  handleRefreshReplay,
  listAgentSessions,
  recordAgentSession,
  revokeAgentSession,
  rotateRefreshJti,
  _deleteAgentSessionForTest,
  type AgentSessionRecord,
  type CognitoRevoker,
  type RefreshJtiRecord,
} from "../../../src/lib/oauth/refresh-detection.js";

function key(input: Record<string, unknown>): string {
  const obj = input.Key as Record<string, { S?: string; N?: string }>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    parts.push(`${k}=${obj[k]?.S ?? obj[k]?.N ?? ""}`);
  }
  return parts.join("|");
}

beforeEach(() => {
  store.clear();
  mockSend.mockReset();

  mockSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    const input = cmd.input;

    if (name.includes("PutItemCommand")) {
      const item = input.Item as Record<string, { S?: string; N?: string }>;
      const pk = (item.pk as { S?: string }).S ?? "";
      const sk = (item.sk as { S?: string }).S ?? "";
      const k = `pk=${pk}|sk=${sk}`;
      const cond = input.ConditionExpression as string | undefined;
      if (cond?.includes("attribute_not_exists") && store.has(k)) {
        throw new ConditionalCheckFailedException();
      }
      store.set(k, item);
      return { Attributes: item };
    }
    if (name.includes("GetItemCommand")) {
      const k = key(input);
      const item = store.get(k);
      return item ? { Item: item } : {};
    }
    if (name.includes("DeleteItemCommand")) {
      store.delete(key(input));
      return {};
    }
    if (name.includes("UpdateItemCommand")) {
      const k = key(input);
      const existing = store.get(k);
      const cond = input.ConditionExpression as string | undefined;
      if (cond?.includes("attribute_exists") && !existing) {
        throw new ConditionalCheckFailedException();
      }
      // Conditional status check: jti must be active.
      if (cond?.includes("#status = :active")) {
        const status = (existing?.status as { S?: string } | undefined)?.S;
        if (status !== "active") throw new ConditionalCheckFailedException();
      }
      const expr = (input.UpdateExpression as string) ?? "";
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, { S?: string; N?: string; NULL?: boolean }>;
      const names = ((input.ExpressionAttributeNames ?? {}) as Record<string, string>) || {};
      const obj = existing ? { ...existing } : {};

      const setMatch = expr.match(/SET\s+(.+?)(?:\s+ADD|\s+REMOVE|$)/);
      if (setMatch) {
        const parts = setMatch[1]!.split(",").map((s) => s.trim());
        for (const p of parts) {
          const [lhs, rhs] = p.split("=").map((s) => s.trim());
          const attr = lhs!.startsWith("#") ? names[lhs!] ?? lhs : lhs!;
          obj[attr] = values[rhs!];
        }
      }
      store.set(k, obj as Record<string, { S?: string; N?: string }>);
      return { Attributes: obj };
    }
    if (name.includes("QueryCommand")) {
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, { S?: string }>;
      const target = values[":u"]?.S;
      const items: Record<string, unknown>[] = [];
      for (const v of store.values()) {
        const gsi1pk = (v.gsi1pk as { S?: string } | undefined)?.S;
        if (gsi1pk === target) items.push(v);
      }
      return { Items: items };
    }
    return {};
  });
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
});

describe("consumeRefreshJti", () => {
  it("returns ok and flips status to consumed on first use", async () => {
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    const out = await consumeRefreshJti("j_initial");
    expect(out.outcome).toBe("ok");
    expect(out.record?.userId).toBe("u_alice");

    // Second consume of the same jti must report replay.
    const replay = await consumeRefreshJti("j_initial");
    expect(replay.outcome).toBe("replay");
  });

  it("returns unknown for an unrecognised jti", async () => {
    const out = await consumeRefreshJti("never-issued");
    expect(out.outcome).toBe("unknown");
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
    // First consume → ok; second → replay.
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
  });

  it("CRITICAL-1: sources cognitoUsername from the jti record, ignoring caller-supplied alternates", async () => {
    // Even if a caller forwards a request-scoped value via a `cognitoUsername`
    // property, the function must not honour it. The signature itself no
    // longer accepts that field; this test pins the contract by passing
    // an extra property and asserting Cognito sees only the record value.
    await recordAgentSession({ session: makeSession(), initialJti: "j_initial" });
    await consumeRefreshJti("j_initial");
    const replay = await consumeRefreshJti("j_initial");

    const cognito: CognitoRevoker = { globalSignOut: vi.fn(async () => undefined) };
    const audit = { emit: vi.fn(async () => undefined) };

    // TypeScript would block the extra prop directly; cast to bypass and
    // simulate a caller mistake forwarding a stale identity value.
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
  it("rethrows non-conditional-check errors", async () => {
    mockSend.mockImplementationOnce(async () => {
      throw new Error("dynamodb network failure");
    });
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
