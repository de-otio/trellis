/**
 * RFC 8628 device authorization grant adapter (T9b-d).
 *
 * Three flows:
 *   1. POST /oauth2/device_authorization — issue a device_code/user_code pair.
 *   2. GET/POST /agents/authorize — interactive admin approval (separate file).
 *   3. POST /oauth2/token (grant_type=device_code) — agent polls for tokens.
 *
 * Storage: a single DynamoDB table keyed on `device_code` (the agent's
 * secret) with envelope-encrypted tokens. The user_code is a secondary
 * index entry pointing back at the device_code so the approval page can
 * look up the pending request.
 *
 * Security invariants:
 *   - device_code is 256-bit URL-safe random; never echoed in logs.
 *   - user_code uses an unambiguous 20-char alphabet; brute-force is
 *     bounded by the 10-failure lockout enforced by the approval page.
 *   - tokens are encrypted with a per-record DEK derived from device_code;
 *     a DynamoDB GetItem alone cannot decrypt.
 *   - record TTL flips to NOW+60s on approval. If the agent doesn't poll
 *     within 60s the row evaporates (read-once short-window).
 *   - successful poll deletes the row before returning (read-once strict).
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { randomBytes, createHash } from "node:crypto";
import { open, resolveKek, seal, type SealedEnvelope } from "./envelope-crypto.js";

/** Unambiguous user-code alphabet — no 0/O, 1/I/L, 2/Z, U/V, A/H, S/5, etc. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/** 8-character user codes, displayed as `XXXX-XXXX` to humans. */
export const USER_CODE_LEN = 8;
/** Default RFC 8628 expires_in. */
export const DEFAULT_EXPIRES_IN = 600;
/** Default RFC 8628 polling interval. */
export const DEFAULT_INTERVAL = 5;
/** TTL for the post-approval window — agents must poll within this. */
export const POST_APPROVAL_TTL_SECONDS = 60;
/** Failure lockout threshold for user_code lookups against a single device_code. */
export const USER_CODE_FAILURE_LIMIT = 10;

export interface DeviceAuthRecord {
  /** Primary key: device_code (the agent's secret). */
  deviceCode: string;
  /** SHA-256 hex of the user_code, for indirect lookup (PII-safe). */
  userCodeHash: string;
  /** Display form of the user code; only present until first GET. */
  userCode?: string;
  status: "pending" | "approved" | "denied";
  /** UTC seconds since epoch — DynamoDB TTL trigger. */
  expiresAt: number;
  createdAt: number;
  /** RFC 8628 polling interval (seconds). */
  interval: number;
  /** Track failed user_code lookups against this device_code. */
  failedLookups: number;
  /** Last poll timestamp; used to enforce `slow_down`. */
  lastPolledAt?: number;
  /** When status === approved, ciphertext blob bound to device_code. */
  envelope?: SealedEnvelope;
  /** Cognito user id of the admin who approved, for audit. */
  approvedByUserId?: string;
  /** Cognito sub bound to the issued tokens, used for revocation. */
  cognitoSub?: string;
  /** Tenant id from the admin's session at approval time. */
  tenantId?: string;
  /** Agent label (User-Agent of the polling client). */
  agentLabel?: string;
  /** Source IP of the agent at request time, anonymised. */
  sourceIp?: string;
  /** Session id (for revocation correlation in the refresh table). */
  sessionId?: string;
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: "Bearer";
  expires_in: number;
}

export interface DeviceAuthPollResult {
  /** "ok" — tokens returned; "pending" — keep polling; "slow_down" — back off; "expired" — restart. */
  outcome: "ok" | "pending" | "slow_down" | "expired" | "denied" | "gone";
  tokens?: TokenSet;
}

const ddb = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
});

function tableName(): string {
  return (
    process.env.DEVICE_AUTH_TABLE ||
    `${process.env.STAGE || "dev"}-trellis-device-auth`
  );
}

/** Format a 4-char-grouped human display: `BCDF-GHJK`. */
export function formatUserCode(raw: string): string {
  if (raw.length !== USER_CODE_LEN) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Strip the dash so callers can match the canonical alphabet. */
export function normaliseUserCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/** SHA-256 hex; used as the secondary lookup key for user_code. */
export function hashUserCode(userCode: string): string {
  return createHash("sha256").update(userCode).digest("hex");
}

/**
 * Generate a cryptographically random user_code from the unambiguous alphabet.
 * Uniformly samples by rejecting bytes that would bias the modulo (alphabet
 * length 20 doesn't divide 256 evenly).
 */
export function generateUserCode(rng: (n: number) => Buffer = randomBytes): string {
  const alphaLen = USER_CODE_ALPHABET.length; // 20
  const cutoff = Math.floor(256 / alphaLen) * alphaLen; // 240; reject 240..255
  const out: string[] = [];
  while (out.length < USER_CODE_LEN) {
    const buf = rng(USER_CODE_LEN * 2); // oversample
    for (let i = 0; i < buf.length && out.length < USER_CODE_LEN; i++) {
      const b = buf[i]!;
      if (b >= cutoff) continue;
      out.push(USER_CODE_ALPHABET[b % alphaLen]!);
    }
  }
  return out.join("");
}

/** 256-bit URL-safe random device_code. */
export function generateDeviceCode(rng: (n: number) => Buffer = randomBytes): string {
  return rng(32).toString("base64url");
}

/**
 * Issue a new device-authorization request. Stores a `pending` record with
 * TTL = expires_in seconds, plus a secondary index row keyed by user_code hash.
 */
export async function startDeviceAuthorization(input: {
  expiresIn?: number;
  interval?: number;
  verificationUriBase: string;
  agentLabel?: string;
  sourceIp?: string;
}): Promise<DeviceAuthResponse> {
  const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN;
  const interval = input.interval ?? DEFAULT_INTERVAL;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresIn;

  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const userCodeHash = hashUserCode(userCode);

  const record: DeviceAuthRecord = {
    deviceCode,
    userCodeHash,
    userCode,
    status: "pending",
    expiresAt,
    createdAt: now,
    interval,
    failedLookups: 0,
    agentLabel: input.agentLabel,
    sourceIp: input.sourceIp,
  };

  await ddb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(
        {
          pk: `dc#${deviceCode}`,
          sk: "rec",
          ...record,
          // DynamoDB TTL attribute (seconds since epoch).
          ttl: expiresAt,
        },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  await ddb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: marshall(
        {
          pk: `uc#${userCodeHash}`,
          sk: "idx",
          deviceCode,
          createdAt: now,
          ttl: expiresAt,
        },
        { removeUndefinedValues: true },
      ),
    }),
  );

  return {
    device_code: deviceCode,
    user_code: formatUserCode(userCode),
    verification_uri: input.verificationUriBase,
    verification_uri_complete: `${input.verificationUriBase}?user_code=${formatUserCode(userCode)}`,
    expires_in: expiresIn,
    interval,
  };
}

/** Internal helper — load a record by device_code or return null. */
export async function loadByDeviceCode(deviceCode: string): Promise<DeviceAuthRecord | null> {
  const out = await ddb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `dc#${deviceCode}`, sk: "rec" }),
    }),
  );
  if (!out.Item) return null;
  const raw = unmarshall(out.Item) as Record<string, unknown> & { ttl?: number };
  if (raw.ttl && (raw.ttl as number) < Math.floor(Date.now() / 1000)) return null;
  return rawToRecord(raw);
}

/** Internal helper — resolve user_code to a device_code via the secondary key. */
export async function lookupDeviceCodeByUserCode(userCode: string): Promise<string | null> {
  const userCodeHash = hashUserCode(normaliseUserCode(userCode));
  const out = await ddb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `uc#${userCodeHash}`, sk: "idx" }),
    }),
  );
  if (!out.Item) return null;
  const raw = unmarshall(out.Item) as Record<string, unknown> & { ttl?: number };
  if (raw.ttl && (raw.ttl as number) < Math.floor(Date.now() / 1000)) return null;
  return (raw.deviceCode as string) || null;
}

/**
 * Increment the failed-lookup counter on a device_code. Returns the new count.
 * Once the count exceeds USER_CODE_FAILURE_LIMIT the record is deleted (lockout).
 */
export async function incrementFailedLookup(deviceCode: string): Promise<number> {
  try {
    const out = await ddb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: marshall({ pk: `dc#${deviceCode}`, sk: "rec" }),
        UpdateExpression: "ADD failedLookups :one",
        ExpressionAttributeValues: marshall({ ":one": 1 }),
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      }),
    );
    if (!out.Attributes) return 0;
    const updated = unmarshall(out.Attributes) as { failedLookups?: number };
    const newCount = updated.failedLookups ?? 0;
    if (newCount >= USER_CODE_FAILURE_LIMIT) {
      await invalidateDeviceCode(deviceCode);
    }
    return newCount;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 0;
    throw err;
  }
}

/** Delete a device-auth record (e.g. on lockout or successful poll). */
export async function invalidateDeviceCode(deviceCode: string): Promise<void> {
  await ddb.send(
    new DeleteItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `dc#${deviceCode}`, sk: "rec" }),
    }),
  );
}

export interface ApprovalContext {
  deviceCode: string;
  approvedByUserId: string;
  cognitoSub: string;
  tenantId: string;
  tokens: TokenSet;
  /** A new session id; used as the refresh-table key after first poll. */
  sessionId: string;
}

/**
 * Mark a device-auth record approved and stash the encrypted token blob.
 * Re-keys the record's TTL to NOW + POST_APPROVAL_TTL_SECONDS.
 */
export async function approveDeviceAuth(ctx: ApprovalContext): Promise<void> {
  const kek = await resolveKek();
  const envelope = seal(JSON.stringify(ctx.tokens), ctx.deviceCode, kek);
  const newTtl = Math.floor(Date.now() / 1000) + POST_APPROVAL_TTL_SECONDS;

  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: marshall({ pk: `dc#${ctx.deviceCode}`, sk: "rec" }),
      UpdateExpression:
        "SET #status = :approved, envelope = :env, approvedByUserId = :u, cognitoSub = :s, tenantId = :t, sessionId = :sid, expiresAt = :ttl, #ttlAttr = :ttl REMOVE userCode",
      ConditionExpression: "attribute_exists(pk) AND #status = :pending",
      ExpressionAttributeNames: {
        "#status": "status",
        "#ttlAttr": "ttl",
      },
      ExpressionAttributeValues: marshall({
        ":approved": "approved",
        ":pending": "pending",
        ":env": JSON.stringify(envelope),
        ":u": ctx.approvedByUserId,
        ":s": ctx.cognitoSub,
        ":t": ctx.tenantId,
        ":sid": ctx.sessionId,
        ":ttl": newTtl,
      }),
    }),
  );
}

/**
 * Poll for tokens with a device_code. Implements the RFC 8628 §3.5/3.4
 * outcomes: pending, slow_down, ok, expired, denied. On success the
 * record is deleted before tokens return (read-once).
 */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthPollResult> {
  const record = await loadByDeviceCode(deviceCode);
  if (!record) return { outcome: "gone" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (record.expiresAt < nowSec) return { outcome: "expired" };

  // RFC 8628 §6.1 — enforce per-device polling interval.
  if (record.lastPolledAt && nowSec - record.lastPolledAt < record.interval) {
    return { outcome: "slow_down" };
  }

  if (record.status === "denied") return { outcome: "denied" };
  if (record.status === "pending") {
    // Best-effort lastPolledAt update so subsequent fast polls hit slow_down.
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: tableName(),
          Key: marshall({ pk: `dc#${deviceCode}`, sk: "rec" }),
          UpdateExpression: "SET lastPolledAt = :n",
          ConditionExpression: "attribute_exists(pk) AND #status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({ ":n": nowSec, ":pending": "pending" }),
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
    return { outcome: "pending" };
  }

  // status === approved. Decrypt, then delete the row before returning.
  if (!record.envelope) return { outcome: "expired" };
  const kek = await resolveKek();
  const plaintext = open(record.envelope, deviceCode, kek);
  const tokens = JSON.parse(plaintext) as TokenSet;

  await invalidateDeviceCode(deviceCode);

  return { outcome: "ok", tokens };
}

function rawToRecord(raw: Record<string, unknown>): DeviceAuthRecord {
  return {
    deviceCode: raw.deviceCode as string,
    userCodeHash: raw.userCodeHash as string,
    userCode: raw.userCode as string | undefined,
    status: raw.status as "pending" | "approved" | "denied",
    expiresAt: raw.expiresAt as number,
    createdAt: raw.createdAt as number,
    interval: raw.interval as number,
    failedLookups: (raw.failedLookups as number) ?? 0,
    lastPolledAt: raw.lastPolledAt as number | undefined,
    envelope: raw.envelope ? (JSON.parse(raw.envelope as string) as SealedEnvelope) : undefined,
    approvedByUserId: raw.approvedByUserId as string | undefined,
    cognitoSub: raw.cognitoSub as string | undefined,
    tenantId: raw.tenantId as string | undefined,
    agentLabel: raw.agentLabel as string | undefined,
    sourceIp: raw.sourceIp as string | undefined,
    sessionId: raw.sessionId as string | undefined,
  };
}

