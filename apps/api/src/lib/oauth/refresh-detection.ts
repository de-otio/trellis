/**
 * Refresh-token reuse detection (RFC 6819 §5.2.2.5, T9b-d).
 *
 * Each refresh-token JTI is recorded once. On refresh:
 *   - load the row by jti
 *   - if absent      → unknown token; treat as suspect, deny
 *   - if `consumed`  → REPLAY; revoke all sessions for that user via
 *                      AdminUserGlobalSignOut and emit `auth.refresh_replay`
 *   - if `active`    → mark consumed, issue new refresh with new jti
 *
 * Storage: AGENT_REFRESH_TABLE in DynamoDB. Same table also holds the
 * agent-session metadata listed by `/api/users/me/agent-sessions`.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

export type AgentSessionStatus = "active" | "consumed" | "revoked";

export interface AgentSessionRecord {
  /** Trellis session id (cuid-ish opaque). */
  sessionId: string;
  /** Owning user's trellis user id. */
  userId: string;
  /** Cognito sub bound to the issued refresh token. */
  cognitoSub: string;
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
  cognitoSub: string;
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

const ddb = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
});

function tableName(): string {
  return (
    process.env.AGENT_REFRESH_TABLE ||
    `${process.env.STAGE || "dev"}-trellis-agent-refresh`
  );
}

/** Initial record write at session creation (after approval). */
export async function recordAgentSession(input: {
  session: AgentSessionRecord;
  initialJti: string;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(
        {
          pk: `s#${input.session.sessionId}`,
          sk: "rec",
          ...input.session,
          gsi1pk: `u#${input.session.userId}`,
          gsi1sk: `s#${input.session.sessionId}`,
        },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  await ddb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall({
        pk: `j#${input.initialJti}`,
        sk: "rec",
        jti: input.initialJti,
        sessionId: input.session.sessionId,
        userId: input.session.userId,
        cognitoSub: input.session.cognitoSub,
        status: "active",
        issuedAt: now,
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
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
  try {
    const out = await ddb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: marshall({ pk: `j#${jti}`, sk: "rec" }),
        UpdateExpression: "SET #status = :consumed, consumedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({
          ":active": "active",
          ":consumed": "consumed",
          ":now": Math.floor(Date.now() / 1000),
        }),
        ReturnValues: "ALL_NEW",
      }),
    );
    if (!out.Attributes) return { outcome: "unknown" };
    return { outcome: "ok", record: unmarshall(out.Attributes) as RefreshJtiRecord };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Row exists but wasn't `active` — load to distinguish unknown vs replay.
      const out = await ddb.send(
        new GetItemCommand({
          TableName: tableName(),
          Key: marshall({ pk: `j#${jti}`, sk: "rec" }),
        }),
      );
      if (!out.Item) return { outcome: "unknown" };
      const row = unmarshall(out.Item) as RefreshJtiRecord;
      return { outcome: "replay", record: row };
    }
    throw err;
  }
}

/**
 * On confirmed replay: revoke all sessions for the user, mark the session
 * row revoked, emit `auth.refresh_replay`. The Cognito SDK call uses
 * AdminUserGlobalSignOut to invalidate every refresh-derived token.
 *
 * Hardening (G4 CRITICAL-1, CRITICAL-2):
 *   - The Cognito username used for revocation is read directly from
 *     `jtiRecord.cognitoSub` (the value bound at session-creation time).
 *     Callers may not supply an alternate identity; this prevents the
 *     wrong account from being revoked if a caller forwards a request-
 *     scoped value here.
 *   - The audit event is emitted FIRST so a downstream Cognito or DDB
 *     failure cannot suppress the `auth.refresh_replay` signal. The
 *     mutation steps follow in order; each is wrapped so that audit
 *     emit completes even when a later step throws.
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
  const cognitoUsername = input.jtiRecord.cognitoSub;

  // Step 1: emit the audit event before any mutation. This is the
  // observability anchor — a replay must always produce a record even if
  // the downstream revocation path fails part-way through.
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

  // Step 2: tombstone the session row in DDB. We do this before the
  // Cognito call so a Cognito failure still leaves the local record
  // marked revoked.
  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `s#${input.jtiRecord.sessionId}`, sk: "rec" }),
      UpdateExpression: "SET #status = :revoked, currentJti = :null, lastUsedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":revoked": "revoked",
        ":null": null,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );

  // Step 3: invalidate refresh-derived tokens at the IdP. If this throws
  // the local state is already consistent (audit emitted, row revoked)
  // and the caller can retry the global sign-out idempotently.
  await input.cognito.globalSignOut({
    userPoolId: input.userPoolId,
    cognitoUsername,
  });
}

/**
 * Issue a new refresh JTI for a session. The old JTI must already be
 * consumed (caller flips it before calling). Updates the session row.
 */
export async function rotateRefreshJti(input: {
  sessionId: string;
  userId: string;
  cognitoSub: string;
  newJti: string;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall({
        pk: `j#${input.newJti}`,
        sk: "rec",
        jti: input.newJti,
        sessionId: input.sessionId,
        userId: input.userId,
        cognitoSub: input.cognitoSub,
        status: "active",
        issuedAt: now,
      }),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `s#${input.sessionId}`, sk: "rec" }),
      UpdateExpression: "SET currentJti = :j, lastUsedAt = :n",
      ConditionExpression: "attribute_exists(pk) AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":j": input.newJti,
        ":n": now,
        ":active": "active",
      }),
    }),
  );
}

/** List all active sessions for a user. Used by `/api/users/me/agent-sessions`. */
export async function listAgentSessions(userId: string): Promise<AgentSessionRecord[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :u",
      ExpressionAttributeValues: marshall({ ":u": `u#${userId}` }),
    }),
  );
  return (out.Items ?? [])
    .map((it) => unmarshall(it) as AgentSessionRecord & { gsi1pk?: string; gsi1sk?: string })
    .filter((r) => r.status === "active")
    .map(({ ...rec }) => rec);
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

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `s#${input.sessionId}`, sk: "rec" }),
      UpdateExpression: "SET #status = :revoked, currentJti = :null, lastUsedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":revoked": "revoked",
        ":null": null,
        ":now": Math.floor(Date.now() / 1000),
      }),
    }),
  );

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
  const out = await ddb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `s#${sessionId}`, sk: "rec" }),
    }),
  );
  if (!out.Item) return null;
  return unmarshall(out.Item) as AgentSessionRecord;
}

/** Test-only: helper to clear a session row directly. */
export async function _deleteAgentSessionForTest(sessionId: string): Promise<void> {
  await ddb.send(
    new DeleteItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `s#${sessionId}`, sk: "rec" }),
    }),
  );
}
