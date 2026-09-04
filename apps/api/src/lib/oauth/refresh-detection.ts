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

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout, type KvStore } from "@de-otio/saas-foundation/kv";
import { deriveSubKey, hmacHex } from "../field-encryption.js";

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
  /**
   * `sha256(access_token)` (hex) of the access token issued for THIS session,
   * so revoking this session can blocklist exactly this token instead of
   * signing the human out of every session they hold (D.1). Written by the
   * approve step; absent on rows created before that change.
   *
   * Storing the hash — never the token — keeps the row useless to a reader of
   * the table, and matches the format `SessionManager` already blocklists
   * under (see `hashSessionToken` / `sessionBlocklistKey`).
   */
  accessTokenHash?: string;
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

/**
 * The write surface of `SESSION_BLOCKLIST_KV` this module needs (D.1). Same
 * binding `SessionManager` reads on all three session read paths; only `put`
 * is required here because revocation never reads the blocklist back.
 */
export interface SessionTokenBlocklist {
  put(key: string, value: string, opts: { expirationTtl: number }): Promise<unknown>;
}

/**
 * HKDF `info` for the refresh-jti sub-key. Domain-separated from every other
 * use of the master secret, so the jti HMAC key is not the session-seal key.
 */
const REFRESH_JTI_SUBKEY_INFO = "trellis-agent-refresh-jti-v1";

/**
 * D.2 — the jti a refresh token is recorded and looked up under.
 *
 * MUST be a deterministic function of the token itself: the whole point of
 * `consumeRefreshJti` is that a *presented* token resolves to the row written
 * when it was *issued*. The previous code stored `randomBytes(16)` here under
 * a comment claiming derivation, so replay detection could never match and
 * had no production caller.
 *
 * HMAC rather than the raw token or a plain digest: Cognito refresh tokens are
 * opaque and long-lived, so nothing token-derived should be stored in a form
 * an attacker who reads the table could brute-force or correlate. Keyed HMAC
 * under a sub-key of the operator's master secret is the same primitive the
 * email-subscription lookup hashes use (`field-encryption.ts`).
 *
 * Pure: the secret is passed in, never read from ambient env.
 */
export function deriveRefreshJti(refreshToken: string, masterSecret: string): string {
  if (!refreshToken) {
    throw new Error("refresh-detection: refresh token is required to derive a jti");
  }
  return `j_${hmacHex(deriveSubKey(masterSecret, REFRESH_JTI_SUBKEY_INFO), refreshToken)}`;
}

/**
 * `sha256(rawToken)` hex — the token-hash format `SessionManager.revokeSession`
 * writes and `isTokenRevoked` reads. Duplicated here rather than exported from
 * `session-cookie.ts` because that module belongs to another lane; the parity
 * is pinned by a cross-module test (`agent-session-revocation.test.ts`), which
 * fails if either side changes.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Blocklist key for a hashed token. MUST match `session-cookie.ts`. */
export function sessionBlocklistKey(tokenHash: string): string {
  return `blocked:${tokenHash}`;
}

/**
 * TTL for a blocklisted agent access token. Matches the blocklist TTL in
 * `session-cookie.ts` (90 days, the maximum cookie lifetime). An agent access
 * token expires far sooner; over-retaining a hash costs one KV row and removes
 * any dependence on the token's actual expiry.
 */
const AGENT_TOKEN_BLOCKLIST_TTL_SECONDS = 90 * 24 * 60 * 60;

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

/**
 * Initial record write at session creation (after approval).
 *
 * D.2 — takes the ISSUED REFRESH TOKEN, not a caller-chosen jti, and derives
 * the jti itself. That makes "the stored jti does not match the token" a shape
 * the type system rules out rather than a comment that can go stale; the
 * assertion below additionally catches a caller whose `session.currentJti`
 * disagrees with the token it is passing.
 */
export async function recordAgentSession(input: {
  session: AgentSessionRecord;
  /** The refresh token actually issued for this session. */
  refreshToken: string;
  /** Master secret the jti HMAC sub-key is derived from. */
  masterSecret: string;
}): Promise<void> {
  const { session, jti: jtiStore } = stores();

  const initialJti = deriveRefreshJti(input.refreshToken, input.masterSecret);
  if (input.session.currentJti !== initialJti) {
    // Fail closed at the write site: a session row whose currentJti is not the
    // token's derived jti silently disables replay detection for that session.
    throw new Error(
      "refresh-detection: session.currentJti does not match the jti derived " +
        "from the issued refresh token — refusing to write a session whose " +
        "replay detection could never fire",
    );
  }

  const sessionCreated = await session.putIfAbsent<AgentSessionRecord>(
    input.session.sessionId,
    input.session,
    { indexedKey: indexKeyFor(input.session.userId) },
  );
  if (!sessionCreated.applied) {
    throw new Error("agent session already exists");
  }

  const jtiRecord: RefreshJtiRecord = {
    jti: initialJti,
    sessionId: input.session.sessionId,
    userId: input.session.userId,
    sub: input.session.sub,
    status: "active",
    issuedAt: nowSeconds(),
  };
  const jtiCreated = await jtiStore.putIfAbsent<RefreshJtiRecord>(initialJti, jtiRecord);
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
 * D.2 — the caller-facing form of `consumeRefreshJti`: hand it the refresh
 * token a client presented and it resolves the same jti the issue path stored.
 * A refresh grant MUST go through this rather than inventing a jti, which is
 * how the two sides drifted apart in the first place.
 */
export async function consumeRefreshToken(
  refreshToken: string,
  masterSecret: string,
): Promise<{ outcome: "ok" | "replay" | "unknown"; record?: RefreshJtiRecord }> {
  return consumeRefreshJti(deriveRefreshJti(refreshToken, masterSecret));
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
 *
 * D.2 — takes the NEW REFRESH TOKEN, not a caller-chosen jti, for the same
 * reason `recordAgentSession` does: a rotation that stores an unrelated jti
 * silently ends the session's replay-detection chain.
 */
export async function rotateRefreshJti(input: {
  sessionId: string;
  userId: string;
  sub: string;
  /** The newly-issued refresh token this rotation hands the client. */
  newRefreshToken: string;
  /** Master secret the jti HMAC sub-key is derived from. */
  masterSecret: string;
}): Promise<void> {
  const { jti: jtiStore, session } = stores();

  const newJti = deriveRefreshJti(input.newRefreshToken, input.masterSecret);
  const jtiRecord: RefreshJtiRecord = {
    jti: newJti,
    sessionId: input.sessionId,
    userId: input.userId,
    sub: input.sub,
    status: "active",
    issuedAt: nowSeconds(),
  };
  const created = await jtiStore.putIfAbsent<RefreshJtiRecord>(newJti, jtiRecord);
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
    currentJti: newJti,
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

/**
 * D.1 — revoke ONE agent session. Caller must verify the session belongs to
 * the user.
 *
 * This used to call `AdminUserGlobalSignOut` on the human's Cognito sub, which
 * signed them out of every session they held anywhere — phone, web, other
 * agents. Handed to a partner integration, a "disconnect this app" button was
 * a denial of service on the user's own account. It now touches only the named
 * session, using mechanisms that already existed:
 *
 *   1. the session's access token goes on the `SESSION_BLOCKLIST_KV` blocklist,
 *      which `SessionManager` checks on all three read paths (bearer JWT,
 *      sealed Authorization token, cookie);
 *   2. the session's current refresh jti row is DELETED, so a later refresh
 *      resolves to `unknown` (deny) rather than `consumed` (which would be
 *      classified as a replay and trip a global sign-out);
 *   3. the session row is tombstoned `status: "revoked"`, `currentJti: null`.
 *
 * Returns whether the access token was actually blocklisted. It is `false`
 * only for a row written before `accessTokenHash` existed, or a deployment
 * with no blocklist binding — the caller reports that honestly rather than
 * claiming a complete revocation. A blocklist write that FAILS throws: a
 * revocation that did not persist must not be reported as success.
 *
 * For the genuine "sign me out everywhere" case see `adminGlobalSignOutUser`.
 */
export async function revokeAgentSession(input: {
  sessionId: string;
  audit: AuditEmitter;
  tenantId: string;
  actorUserId: string;
  sourceIp?: string;
  /** `env.SESSION_BLOCKLIST_KV`; absent in deployments that bind no KV. */
  blocklist?: SessionTokenBlocklist;
}): Promise<{ tokenBlocklisted: boolean }> {
  const { session: sessionStore, jti: jtiStore } = stores();

  const current = await sessionStore.get<AgentSessionRecord>(input.sessionId, {
    consistent: true,
  });
  const record = current?.value;

  // 1. Blocklist this session's access token — and only this one.
  let tokenBlocklisted = false;
  if (record?.accessTokenHash && input.blocklist) {
    await input.blocklist.put(sessionBlocklistKey(record.accessTokenHash), "1", {
      expirationTtl: AGENT_TOKEN_BLOCKLIST_TTL_SECONDS,
    });
    tokenBlocklisted = true;
  }

  // 2. Drop the live refresh jti so a refresh grant denies rather than
  //    reporting a replay (which would escalate to a global sign-out).
  if (record?.currentJti) {
    await jtiStore.delete(record.currentJti);
  }

  // 3. Tombstone the session row.
  await tombstoneSession(input.sessionId, input.actorUserId);

  await input.audit.emit({
    type: "auth.agent_session.revoked",
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    payload: { scope: "session", tokenBlocklisted },
    sourceIp: input.sourceIp,
    agentSessionId: input.sessionId,
  });

  return { tokenBlocklisted };
}

/**
 * D.1 — the DELIBERATE global sign-out, kept as a separate, clearly-named
 * administrative action because account compromise is a real case for it.
 *
 * Signs the human out of every Cognito-derived session and tombstones every
 * agent session they hold. Never call this to service "revoke this session":
 * that is `revokeAgentSession`.
 *
 * Ordering mirrors `handleRefreshReplay` (G4 CRITICAL-2): the audit event is
 * emitted FIRST so a downstream Cognito or store failure cannot suppress the
 * record that a global sign-out was performed.
 */
export async function adminGlobalSignOutUser(input: {
  /** Trellis user id whose agent sessions are tombstoned. */
  userId: string;
  /** Cognito username/sub to sign out. */
  cognitoUsername: string;
  userPoolId: string;
  cognito: CognitoRevoker;
  audit: AuditEmitter;
  tenantId: string;
  actorUserId: string;
  /** Free-form operator reason, recorded in the audit payload. */
  reason: string;
  sourceIp?: string;
}): Promise<{ agentSessionsRevoked: number }> {
  const sessions = await listAgentSessions(input.userId);

  await input.audit.emit({
    type: "auth.global_sign_out",
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    payload: {
      scope: "global",
      cognitoUserId: input.cognitoUsername,
      reason: input.reason,
      agentSessionCount: sessions.length,
    },
    sourceIp: input.sourceIp,
  });

  for (const session of sessions) {
    await tombstoneSession(session.sessionId, input.userId);
  }

  await input.cognito.globalSignOut({
    userPoolId: input.userPoolId,
    cognitoUsername: input.cognitoUsername,
  });

  return { agentSessionsRevoked: sessions.length };
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
