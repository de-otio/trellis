/**
 * Refresh-token reuse detection (RFC 6819 §5.2.2.5, T9b-d), on the
 * `@de-otio/saas-foundation` `KvStore` port (WS-1 §3.7).
 *
 * Each refresh-token JTI is recorded once. On refresh:
 *   - load the row by jti (STRONGLY consistent — F6)
 *   - if absent      → unknown token; treat as suspect, deny
 *   - if `consumed`  → REPLAY; revoke all sessions for that user via
 *                      AdminUserGlobalSignOut and emit `auth.refresh_replay`
 *   - if `active`    → compare-and-set to consumed, issue new refresh with new jti
 *
 * Storage: two namespaced `KvStore`s over the AGENT_REFRESH_TABLE — a `jti`
 * store (keys are the jti; byte-compat pk `j#{jti}`) and a `session` store
 * (keys are the sessionId; byte-compat pk `s#{sessionId}`, indexed by
 * `u#{userId}` on the `gsi1` GSI). Both carry sk `rec`. Zero AWS behavior
 * change: the default stores are DynamoKvStore over these byte-compat layouts;
 * the only at-rest delta is the additive `_v` version attribute.
 *
 * ## F6 (MUST) — strongly-consistent read on the consume path
 * `consumeRefreshJti`'s `get` passes `{ consistent: true }`. Under eventual
 * consistency a stale read of an already-consumed JTI yields a false-positive
 * replay → user global session revocation. The read→CAS pattern is only safe
 * with the consistent read.
 *
 * Equivalence to the pre-port DynamoDB code is at the level of OUTCOME
 * (ok/replay/unknown, revoke/list results), not command shape: the status
 * transitions become read(consistent)→compareAndSet(version) instead of a
 * single conditional UpdateItem (an extra round-trip). Correctness (no
 * double-consume) holds because the write is still atomic on version.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout, type KvStore } from "@de-otio/saas-foundation/kv";

export type AgentSessionStatus = "active" | "consumed" | "revoked";

export interface AgentSessionRecord {
  /** Trellis session id (cuid-ish opaque). */
  sessionId: string;
  /** Owning user's trellis user id. */
  userId: string;
  /** Cognito sub bound to the issued refresh token. */
  sub: string;
  /** Tenant id from the session at approval time. */
  tenantId: string;
  /** Currently-active refresh-token JTI (null after revoke). */
  currentJti: string | null;
  /** Set of all jti's ever issued for this session, for replay detection. */
  /** We track the latest only — older are flipped to consumed individually. */
  status: AgentSessionStatus;
  /** Free-form label set by the device-auth flow (User-Agent excerpt). */
  agentLabel?: string;
  sourceIp?: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface RefreshJtiRecord {
  jti: string;
  sessionId: string;
  userId: string;
  sub: string;
  status: "active" | "consumed";
  issuedAt: number;
  consumedAt?: number;
}

export interface CognitoRevoker {
  globalSignOut(input: { userPoolId: string; cognitoUsername: string }): Promise<void>;
}

export interface AuditEmitter {
  emit(input: {
    type: string;
    tenantId: string;
    actorUserId: string;
    payload: Record<string, unknown>;
    sourceIp?: string;
    agentSessionId?: string;
  }): Promise<void>;
}

/** The two namespaced stores over the agent-refresh table. */
interface RefreshStores {
  readonly jti: KvStore;
  readonly session: KvStore;
}

function tableName(): string {
  return (
    process.env.AGENT_REFRESH_TABLE ||
    `${process.env.STAGE || "dev"}-trellis-agent-refresh`
  );
}

let _stores: RefreshStores | null = null;

/**
 * Lazily build the default DynamoKvStore-backed stores (byte-compat layouts).
 * The jti rows are `j#{jti}` / sk `rec`; the session rows are `s#{sessionId}` /
 * sk `rec`, indexed on the `gsi1` GSI (`gsi1pk`/`gsi1sk`). No TTL on either.
 */
function stores(): RefreshStores {
  if (_stores !== null) return _stores;
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  });
  const table = tableName();
  const jtiLayout: DynamoKvLayout = {
    tableName: table,
    pkPrefix: "j",
    pkSeparator: "#",
    skName: "sk",
    skValue: "rec",
    ttlAttr: "ttl",
    versionAttr: "_v",
  };
  const sessionLayout: DynamoKvLayout = {
    tableName: table,
    pkPrefix: "s",
    pkSeparator: "#",
    skName: "sk",
    skValue: "rec",
    ttlAttr: "ttl",
    versionAttr: "_v",
    index: { name: "gsi1", pkAttr: "gsi1pk", skAttr: "gsi1sk" },
  };
  _stores = {
    jti: new DynamoKvStore(client, jtiLayout),
    session: new DynamoKvStore(client, sessionLayout),
  };
  return _stores;
}

/**
 * Test seam (WS-1 §6.1): inject the two `KvStore`s (e.g. `MemoryKvStore`) so the
 * unit suite exercises OUTCOME equivalence without a live DynamoDB.
 */
export function _setRefreshStoresForTest(jti: KvStore, session: KvStore): void {
  _stores = { jti, session };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function indexKeyFor(userId: string): string {
  return `u#${userId}`;
}

/** Initial record write at session creation (after approval). */
export async function recordAgentSession(input: {
  session: AgentSessionRecord;
  initialJti: string;
}): Promise<void> {
  const { session, jti: jtiStore } = stores();

  const sessionCreated = await session.putIfAbsent<AgentSessionRecord>(
    input.session.sessionId,
    input.session,
    { indexedKey: indexKeyFor(input.session.userId) },
  );
  if (!sessionCreated.applied) {
    throw new Error("agent session already exists");
  }

  const jtiRecord: RefreshJtiRecord = {
    jti: input.initialJti,
    sessionId: input.session.sessionId,
    userId: input.session.userId,
    sub: input.session.sub,
    status: "active",
    issuedAt: nowSeconds(),
  };
  const jtiCreated = await jtiStore.putIfAbsent<RefreshJtiRecord>(input.initialJti, jtiRecord);
  if (!jtiCreated.applied) {
    throw new Error("refresh jti already exists");
  }
}

/**
 * Validate a refresh-token JTI. Three outcomes:
 *   - "ok"      → the jti was active; row is now flipped to consumed.
 *   - "replay"  → jti was already consumed → caller must revoke session globally.
 *   - "unknown" → jti not present (foreign or expired); deny.
 */
export async function consumeRefreshJti(jti: string): Promise<{
  outcome: "ok" | "replay" | "unknown";
  record?: RefreshJtiRecord;
}> {
  const { jti: jtiStore } = stores();
  // F6: strongly-consistent read — a stale read here false-positives replay and
  // revokes the user's global session.
  const rec = await jtiStore.get<RefreshJtiRecord>(jti, { consistent: true });
  if (rec === null) return { outcome: "unknown" };

  if (rec.value.status === "active") {
    const consumed: RefreshJtiRecord = {
      ...rec.value,
      status: "consumed",
      consumedAt: nowSeconds(),
    };
    const res = await jtiStore.compareAndSet<RefreshJtiRecord>(jti, rec.version, consumed);
    if (res.applied) return { outcome: "ok", record: consumed };
    // Lost the race to a concurrent consumer — re-read (consistent) to classify.
    const after = await jtiStore.get<RefreshJtiRecord>(jti, { consistent: true });
    if (after === null) return { outcome: "unknown" };
    return { outcome: "replay", record: after.value };
  }

  // Present but not active → already consumed → replay.
  return { outcome: "replay", record: rec.value };
}

/**
 * On confirmed replay: revoke all sessions for the user, mark the session
 * row revoked, emit `auth.refresh_replay`. The Cognito SDK call uses
 * AdminUserGlobalSignOut to invalidate every refresh-derived token.
 *
 * Hardening (G4 CRITICAL-1, CRITICAL-2):
 *   - The Cognito username used for revocation is read directly from
 *     `jtiRecord.sub` (the value bound at session-creation time).
 *     Callers may not supply an alternate identity.
 *   - The audit event is emitted FIRST so a downstream Cognito or store
 *     failure cannot suppress the `auth.refresh_replay` signal.
 */
export async function handleRefreshReplay(input: {
  jtiRecord: RefreshJtiRecord;
  tenantId: string;
  userPoolId: string;
  cognito: CognitoRevoker;
  audit: AuditEmitter;
  sourceIp?: string;
}): Promise<void> {
  // Source the Cognito username from the stored jti record only.
  const cognitoUsername = input.jtiRecord.sub;

  // Step 1: emit the audit event before any mutation.
  await input.audit.emit({
    type: "auth.refresh_replay",
    tenantId: input.tenantId,
    actorUserId: input.jtiRecord.userId,
    payload: {
      refreshJti: input.jtiRecord.jti,
      cognitoUserId: cognitoUsername,
    },
    sourceIp: input.sourceIp,
    agentSessionId: input.jtiRecord.sessionId,
  });

  // Step 2: tombstone the session row (before the Cognito call so a Cognito
  // failure still leaves the local record revoked). Unconditional upsert,
  // matching the pre-port UpdateItem with no condition.
  await tombstoneSession(input.jtiRecord.sessionId, input.jtiRecord.userId);

  // Step 3: invalidate refresh-derived tokens at the IdP.
  await input.cognito.globalSignOut({
    userPoolId: input.userPoolId,
    cognitoUsername,
  });
}

/**
 * Set a session row to `revoked` with `currentJti=null`. Reads the current
 * record and writes the merged tombstone (upsert), preserving the `u#{userId}`
 * index value so `listAgentSessions` still scopes correctly.
 */
async function tombstoneSession(sessionId: string, fallbackUserId: string): Promise<void> {
  const { session } = stores();
  const current = await session.get<AgentSessionRecord>(sessionId, { consistent: true });
  const base = current?.value;
  const userId = base?.userId ?? fallbackUserId;
  const merged: AgentSessionRecord = {
    sessionId,
    userId,
    sub: base?.sub ?? "",
    tenantId: base?.tenantId ?? "",
    currentJti: null,
    status: "revoked",
    ...(base?.agentLabel !== undefined ? { agentLabel: base.agentLabel } : {}),
    ...(base?.sourceIp !== undefined ? { sourceIp: base.sourceIp } : {}),
    createdAt: base?.createdAt ?? nowSeconds(),
    lastUsedAt: nowSeconds(),
  };
  await session.put<AgentSessionRecord>(sessionId, merged, { indexedKey: indexKeyFor(userId) });
}

/**
 * Issue a new refresh JTI for a session. The old JTI must already be
 * consumed (caller flips it before calling). Updates the session row.
 */
export async function rotateRefreshJti(input: {
  sessionId: string;
  userId: string;
  sub: string;
  newJti: string;
}): Promise<void> {
  const { jti: jtiStore, session } = stores();

  const jtiRecord: RefreshJtiRecord = {
    jti: input.newJti,
    sessionId: input.sessionId,
    userId: input.userId,
    sub: input.sub,
    status: "active",
    issuedAt: nowSeconds(),
  };
  const created = await jtiStore.putIfAbsent<RefreshJtiRecord>(input.newJti, jtiRecord);
  if (!created.applied) {
    throw new Error("refresh jti already exists");
  }

  // Original condition: attribute_exists(pk) AND #status = :active. Reproduce
  // by read→branch→CAS; a missing/non-active/raced session is rejected.
  const current = await session.get<AgentSessionRecord>(input.sessionId, { consistent: true });
  if (current === null || current.value.status !== "active") {
    throw new Error("agent session not active");
  }
  const updated: AgentSessionRecord = {
    ...current.value,
    currentJti: input.newJti,
    lastUsedAt: nowSeconds(),
  };
  const res = await session.compareAndSet<AgentSessionRecord>(
    input.sessionId,
    current.version,
    updated,
    { indexedKey: indexKeyFor(current.value.userId) },
  );
  if (!res.applied) {
    throw new Error("agent session changed concurrently");
  }
}

/** List all active sessions for a user. Used by `/api/users/me/agent-sessions`. */
export async function listAgentSessions(userId: string): Promise<AgentSessionRecord[]> {
  const { session } = stores();
  const rows = await session.queryByIndex<AgentSessionRecord>(indexKeyFor(userId));
  return rows.filter((r) => r.value.status === "active").map((r) => r.value);
}

/** Revoke a session by id; caller must verify the session belongs to the user. */
export async function revokeAgentSession(input: {
  sessionId: string;
  userPoolId: string;
  cognitoUsername: string;
  cognito: CognitoRevoker;
  audit: AuditEmitter;
  tenantId: string;
  actorUserId: string;
  sourceIp?: string;
}): Promise<void> {
  await input.cognito.globalSignOut({
    userPoolId: input.userPoolId,
    cognitoUsername: input.cognitoUsername,
  });

  await tombstoneSession(input.sessionId, input.actorUserId);

  await input.audit.emit({
    type: "auth.agent_session.revoked",
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    payload: { cognitoUserId: input.cognitoUsername },
    sourceIp: input.sourceIp,
    agentSessionId: input.sessionId,
  });
}

/** Look up a session by id (auth check helper). */
export async function getAgentSession(sessionId: string): Promise<AgentSessionRecord | null> {
  const { session } = stores();
  const rec = await session.get<AgentSessionRecord>(sessionId);
  return rec === null ? null : rec.value;
}

/** Test-only: helper to clear a session row directly. */
export async function _deleteAgentSessionForTest(sessionId: string): Promise<void> {
  const { session } = stores();
  await session.delete(sessionId);
}
