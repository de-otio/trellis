/**
 * RFC 8628 device authorization grant adapter (T9b-d), on the
 * `@de-otio/saas-foundation` `KvStore` port (WS-1 §3.8).
 *
 * Three flows:
 *   1. POST /oauth2/device_authorization — issue a device_code/user_code pair.
 *   2. GET/POST /agents/authorize — interactive admin approval (separate file).
 *   3. POST /oauth2/token (grant_type=device_code) — agent polls for tokens.
 *
 * Storage: the device-auth table, addressed through TWO namespaced `KvStore`s
 * (byte-compat two-row layout preserved, §3.8 default):
 *   - `device` store: pk `dc#{deviceCode}`, sk `rec`, ttl attr `ttl` — the
 *     DeviceAuthRecord (envelope kept as a JSON STRING field, `failedLookups`
 *     a native counter).
 *   - `index`  store: pk `uc#{userCodeHash}`, sk `idx`, ttl attr `ttl` — the
 *     manual secondary-index row `{ deviceCode, createdAt }` (NOT a GSI, so no
 *     schema change). `lookupDeviceCodeByUserCode` reads it directly.
 * The defaults are DynamoKvStore over these layouts, so AWS behavior is
 * unchanged (only the additive `_v` version attribute differs at rest).
 *
 * Security invariants (unchanged):
 *   - device_code is 256-bit URL-safe random; never echoed in logs.
 *   - user_code uses an unambiguous 20-char alphabet; brute-force is bounded by
 *     the 10-failure lockout enforced by the approval page.
 *   - tokens are envelope-encrypted with a per-record DEK derived from
 *     device_code; a store read alone cannot decrypt. The seal/open path and the
 *     JSON-string envelope storage are preserved verbatim.
 *   - record TTL flips to NOW+60s on approval; a successful poll deletes the row
 *     before returning (read-once strict).
 *
 * Equivalence to the pre-port DynamoDB code is by OUTCOME (approve/poll/lockout
 * results), not command shape: the status-conditioned writes become
 * read(consistent)→compareAndSet(version).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout, type KvStore } from "@de-otio/saas-foundation/kv";
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
  sub?: string;
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

/** The stored device row (envelope is a JSON string at rest, per §3.8). */
type StoredDeviceRow = Record<string, unknown>;
/** The stored manual-index row. */
interface StoredIndexRow {
  deviceCode: string;
  createdAt: number;
}

interface DeviceStores {
  readonly device: KvStore;
  readonly index: KvStore;
}

function tableName(): string {
  return (
    process.env.DEVICE_AUTH_TABLE ||
    `${process.env.STAGE || "dev"}-trellis-device-auth`
  );
}

let _stores: DeviceStores | null = null;

/** Lazily build the default DynamoKvStore-backed stores (byte-compat layouts). */
function stores(): DeviceStores {
  if (_stores !== null) return _stores;
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  });
  const table = tableName();
  const deviceLayout: DynamoKvLayout = {
    tableName: table,
    pkPrefix: "dc",
    pkSeparator: "#",
    skName: "sk",
    skValue: "rec",
    ttlAttr: "ttl",
    versionAttr: "_v",
    nativeNumberFields: ["failedLookups"],
  };
  const indexLayout: DynamoKvLayout = {
    tableName: table,
    pkPrefix: "uc",
    pkSeparator: "#",
    skName: "sk",
    skValue: "idx",
    ttlAttr: "ttl",
    versionAttr: "_v",
  };
  _stores = {
    device: new DynamoKvStore(client, deviceLayout),
    index: new DynamoKvStore(client, indexLayout),
  };
  return _stores;
}

/**
 * Test seam (WS-1 §6.1): inject the device + index `KvStore`s (e.g.
 * `MemoryKvStore`) so the unit suite exercises OUTCOME equivalence without a
 * live DynamoDB.
 */
export function _setDeviceStoresForTest(device: KvStore, index: KvStore): void {
  _stores = { device, index };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
  const now = nowSeconds();
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
    ...(input.agentLabel !== undefined ? { agentLabel: input.agentLabel } : {}),
    ...(input.sourceIp !== undefined ? { sourceIp: input.sourceIp } : {}),
  };

  const { device, index } = stores();

  // Device row: create-once (attribute_not_exists equivalent).
  const created = await device.putIfAbsent<DeviceAuthRecord>(deviceCode, record, {
    ttlSeconds: expiresIn,
  });
  if (!created.applied) {
    throw new Error("device code collision");
  }

  // Manual index row: unconditional overwrite (matches the pre-port PutItem).
  const indexRow: StoredIndexRow = { deviceCode, createdAt: now };
  await index.put<StoredIndexRow>(userCodeHash, indexRow, { ttlSeconds: expiresIn });

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
  const { device } = stores();
  const rec = await device.get<StoredDeviceRow>(deviceCode);
  if (rec === null) return null;
  return rawToRecord(rec.value);
}

/** Internal helper — resolve user_code to a device_code via the secondary key. */
export async function lookupDeviceCodeByUserCode(userCode: string): Promise<string | null> {
  const userCodeHash = hashUserCode(normaliseUserCode(userCode));
  const { index } = stores();
  const rec = await index.get<StoredIndexRow>(userCodeHash);
  if (rec === null) return null;
  return rec.value.deviceCode || null;
}

/**
 * Increment the failed-lookup counter on a device_code. Returns the new count.
 * Once the count reaches USER_CODE_FAILURE_LIMIT the record is deleted (lockout).
 * A missing (or expired) record returns 0 without creating a row — reproducing
 * the pre-port `attribute_exists(pk)` guard's CCFE→0 branch.
 */
export async function incrementFailedLookup(deviceCode: string): Promise<number> {
  const { device } = stores();
  const existing = await device.get<{ expiresAt?: number }>(deviceCode);
  if (existing === null) return 0;
  // Pass the record's expiry so a lost-race phantom row stays TTL-bounded; on the
  // existing row the counter's set-once TTL is preserved (COALESCE/if_not_exists).
  const opts =
    existing.value.expiresAt !== undefined ? { expiresAt: existing.value.expiresAt } : undefined;
  const newCount = await device.increment(deviceCode, "failedLookups", 1, opts);
  if (newCount >= USER_CODE_FAILURE_LIMIT) {
    await invalidateDeviceCode(deviceCode);
  }
  return newCount;
}

/** Delete a device-auth record (e.g. on lockout or successful poll). */
export async function invalidateDeviceCode(deviceCode: string): Promise<void> {
  const { device } = stores();
  await device.delete(deviceCode);
}

export interface ApprovalContext {
  deviceCode: string;
  approvedByUserId: string;
  sub: string;
  tenantId: string;
  tokens: TokenSet;
  /** A new session id; used as the refresh-table key after first poll. */
  sessionId: string;
}

/**
 * Mark a device-auth record approved and stash the encrypted token blob.
 * Re-keys the record's TTL to NOW + POST_APPROVAL_TTL_SECONDS. Reproduces the
 * `attribute_exists(pk) AND #status = :pending` guard by read→branch→CAS; the
 * envelope seal path is unchanged (per-record DEK bound to device_code).
 */
export async function approveDeviceAuth(ctx: ApprovalContext): Promise<void> {
  const kek = await resolveKek();
  const envelope = seal(JSON.stringify(ctx.tokens), ctx.deviceCode, kek);
  const newTtl = nowSeconds() + POST_APPROVAL_TTL_SECONDS;

  const { device } = stores();
  const rec = await device.get<StoredDeviceRow>(ctx.deviceCode, { consistent: true });
  if (rec === null || rec.value.status !== "pending") {
    throw new Error("device authorization not pending");
  }

  // Merge the approval fields; REMOVE userCode (omit it from the new item).
  const rest: StoredDeviceRow = { ...rec.value };
  delete rest.userCode;
  const updated: StoredDeviceRow = {
    ...rest,
    status: "approved",
    envelope: JSON.stringify(envelope),
    approvedByUserId: ctx.approvedByUserId,
    sub: ctx.sub,
    tenantId: ctx.tenantId,
    sessionId: ctx.sessionId,
    expiresAt: newTtl,
  };
  const res = await device.compareAndSet<StoredDeviceRow>(ctx.deviceCode, rec.version, updated, {
    expiresAt: newTtl,
  });
  if (!res.applied) {
    throw new Error("device authorization changed concurrently");
  }
}

/**
 * Poll for tokens with a device_code. Implements the RFC 8628 §3.5/3.4
 * outcomes: pending, slow_down, ok, expired, denied. On success the
 * record is deleted before tokens return (read-once).
 */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthPollResult> {
  const record = await loadByDeviceCode(deviceCode);
  if (!record) return { outcome: "gone" };

  const nowSec = nowSeconds();
  if (record.expiresAt < nowSec) return { outcome: "expired" };

  // RFC 8628 §6.1 — enforce per-device polling interval.
  if (record.lastPolledAt && nowSec - record.lastPolledAt < record.interval) {
    return { outcome: "slow_down" };
  }

  if (record.status === "denied") return { outcome: "denied" };
  if (record.status === "pending") {
    // Best-effort lastPolledAt update so subsequent fast polls hit slow_down.
    // Version-CAS on the still-pending row; a lost race is swallowed (best
    // effort), transient errors propagate (matches the pre-port rethrow).
    const { device } = stores();
    const raw = await device.get<StoredDeviceRow>(deviceCode, { consistent: true });
    if (raw !== null && raw.value.status === "pending") {
      const updated: StoredDeviceRow = { ...raw.value, lastPolledAt: nowSec };
      await device.compareAndSet<StoredDeviceRow>(deviceCode, raw.version, updated, {
        expiresAt: record.expiresAt,
      });
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
    sub: raw.sub as string | undefined,
    tenantId: raw.tenantId as string | undefined,
    agentLabel: raw.agentLabel as string | undefined,
    sourceIp: raw.sourceIp as string | undefined,
    sessionId: raw.sessionId as string | undefined,
  };
}
