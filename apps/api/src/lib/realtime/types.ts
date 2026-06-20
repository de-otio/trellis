// CONTRACT: stable — coordinate changes.
//
// This file is the FROZEN WS1 contract for the Trellis RealtimeTransport seam.
// Every other workstream (WS2 AppSync infra, WS3 authorizer, WS4 push, WS5
// settings-sync, WS7 conformance) and the Skybber Flutter client bind to the
// exact signatures below. Any change after WS1 merges is a BREAKING change
// requiring a coordinated version bump and re-fan-out. See
// plans/appsync-skybber/00b-integration-and-frozen-contract.md §2.
//
// HARD RULE: nothing in apps/api/src/lib/realtime/** may import an AWS SDK
// (`@aws-sdk/*`, `aws-appsync`, `aws-amplify`) or a socket library. Enforced by
// test/unit/realtime/no-aws-import.test.ts.

import type { NotificationType, AgeTier } from "@prisma/client";

// ---------------------------------------------------------------------------
// 2.1 Channel taxonomy
// ---------------------------------------------------------------------------

/**
 * Coarse class of realtime traffic. Lets policy/transport route and rate-shape.
 * v1 ships ONLY the user-scoped kinds (`wakeup`, `setting_sync`, `safety`);
 * `message` and `thread` are taxonomy-reserved but unused (DEFERRED).
 */
export type ChannelKind =
  | "wakeup" // content-free "fetch me" ping (consumer A)
  | "setting_sync" // "your <namespace> setting changed; pull it" (consumer B)
  | "safety" // SAFETY_ALERT / PARENTAL_LINK / security — floor, always
  | "message" // E2E DM arrival (DEFERRED — taxonomy reserved, unused in v1)
  | "thread"; // reply/mention in a thread you participate in (DEFERRED)

/** The scope a channel addresses. v1 ships only `"user"`. */
export type ScopeType = "user" | "conversation" | "thread";

/**
 * A push-delivery channel — a content-free routing address, ALWAYS tenant- and
 * scope-bound and server-verified. The canonical string form is produced ONLY
 * by `channelName()` and parsed ONLY by `parseChannel()` (and the Skybber
 * `@skybber/realtime-channels` parser, which must round-trip them).
 *
 * FROZEN kind→scopeType map (v1 ships ONLY user-scoped kinds):
 *   wakeup | setting_sync | safety  -> scopeType "user",  scopeId = recipient userId
 *   message                         -> scopeType "conversation" (DEFERRED)
 *   thread                          -> scopeType "thread"        (DEFERRED)
 */
export interface Channel {
  kind: ChannelKind;
  /** Server-resolved tenant scope. */
  tenantId: string;
  scopeType: ScopeType;
  /** userId (v1) | conversationId | threadId (deferred). */
  scopeId: string;
}

// ---------------------------------------------------------------------------
// 2.2 Authorization — explicit identity, never ambient Session
// ---------------------------------------------------------------------------

/**
 * Verified identity. Derived ONLY from Cognito claims (custom:userId,
 * custom:activeTenantId) — by the in-core handler AND the Skybber authorizer
 * Lambda — so both call the SAME function. Never an ambient Session, never a
 * client-asserted path.
 */
export interface VerifiedIdentity {
  userId: string;
  tenantId: string;
}

// ---------------------------------------------------------------------------
// 2.3 Delivery — best-effort semantics + policy context
// ---------------------------------------------------------------------------

/** Recipient address for `deliver()`. Both fields server-resolved. */
export interface DeliveryTarget {
  userId: string;
  tenantId: string;
}

/**
 * Result of a `deliver()` attempt. `deliver()` is BEST-EFFORT: it NEVER rejects
 * in a way that rolls back a persisted write. It resolves with this result;
 * transports catch their own errors. The policy fence runs INSIDE every
 * transport's `deliver()`.
 */
export type DeliveryResult =
  | { delivered: true }
  | {
      delivered: false;
      reason: "policy_denied" | "no_transport" | "transport_error";
    };

/**
 * Input the policy resolver sees. Built by the caller from its own args
 * (`createNotification` has no Session), enriched with recipient ageTier /
 * blocked-sender as needed for the floor.
 */
export interface DeliveryContext {
  type: NotificationType;
  recipientUserId: string;
  tenantId: string;
  /** blocked-sender floor input. */
  senderUserId?: string;
  /** minor-protection floor input. */
  recipientAgeTier?: AgeTier;
  now: Date;
  quietHours?: QuietHoursConfig | null;
}

/** What the resolver decided for ONE delivery attempt. */
export type DeliveryDecision =
  | { deliver: true }
  | {
      deliver: false;
      reason: "preference" | "quiet_hours" | "blocked_sender" | "floor";
    };

/**
 * Quiet-hours window. `start`/`end` are opaque to the contract; the resolver
 * that produced the context owns their interpretation. (The core resolver
 * encodes minutes-since-midnight as decimal strings to reproduce the existing
 * `User.quietHoursStart/End` integer behavior byte-identically.)
 */
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// 2.4 Wakeup envelope — structural content-free guarantee
// ---------------------------------------------------------------------------

/**
 * The ONLY shape push payloads for wakeup/setting_sync may take. It has NO
 * free-form field — content-free is a property of the TYPE, not a test
 * heuristic. WS4/WS5 are FORBIDDEN from constructing arbitrary Uint8Array for
 * these kinds; they must use `encodeWakeup()`.
 */
export interface WakeupEnvelope {
  v: 1;
  kind: ChannelKind;
  /** opaque version pointer for setting_sync (NOT ciphertext). */
  changeToken?: string;
}

/** Encode a wakeup envelope to its canonical content-free byte form. */
export function encodeWakeup(e: WakeupEnvelope): Uint8Array {
  if (e.v !== 1) {
    throw new Error(`encodeWakeup: unsupported version ${String(e.v)}`);
  }
  // Canonical, field-ordered JSON — no free-form passthrough.
  const canonical: Record<string, unknown> = { v: 1, kind: e.kind };
  if (e.changeToken !== undefined) canonical.changeToken = e.changeToken;
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/** Decode a wakeup envelope. Throws on unknown fields or malformed input. */
export function decodeWakeup(b: Uint8Array): WakeupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b));
  } catch {
    throw new Error("decodeWakeup: not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("decodeWakeup: not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "changeToken"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`decodeWakeup: unknown field "${key}"`);
    }
  }
  if (obj.v !== 1) {
    throw new Error("decodeWakeup: unsupported version");
  }
  if (typeof obj.kind !== "string") {
    throw new Error("decodeWakeup: missing/invalid kind");
  }
  if (obj.changeToken !== undefined && typeof obj.changeToken !== "string") {
    throw new Error("decodeWakeup: invalid changeToken");
  }
  const env: WakeupEnvelope = { v: 1, kind: obj.kind as ChannelKind };
  if (obj.changeToken !== undefined) env.changeToken = obj.changeToken;
  return env;
}

// ---------------------------------------------------------------------------
// 2.5 Settings sync
// ---------------------------------------------------------------------------

/**
 * Opaque AEAD ciphertext + plaintext sync metadata. The server NEVER reads
 * `ciphertext`. `version`/`updatedAt` are deliberately plaintext (they leak
 * only THAT/WHEN a setting changed, not WHAT).
 */
export interface EncryptedBlob {
  /** Base64url AEAD ciphertext of the client's JSON document. */
  ciphertext: string;
  /** Monotonic per (userId, namespace). Drives optimistic concurrency. */
  version: number;
  /** ISO-8601; server-assigned on write. */
  updatedAt: string;
}

/**
 * Result of `putSetting` — optimistic-concurrency outcome. Never throws on
 * conflict; the caller (and ultimately the client) reconciles against
 * `current`.
 */
export type PutResult =
  | { ok: true; stored: EncryptedBlob }
  | { ok: false; reason: "version_conflict"; current: EncryptedBlob }
  | { ok: false; reason: "not_found"; current: null };

/**
 * Minimal store port the transports use for blob sync. WS5 supplies
 * `PrismaEncryptedSettingsStore`; WS1 ships `InMemorySettingStore` so core
 * runs/tests with zero infra. Holds CIPHERTEXT ONLY.
 *
 * FROZEN (§2.5): do NOT add methods here. Offline-backfill (Track C) is layered
 * as the SEPARATE optional `ChangeCursorStore` capability below so this contract
 * stays byte-stable for every consumer bound to it.
 */
export interface SettingStore {
  get(userId: string, namespace: string): Promise<EncryptedBlob | null>;
  put(
    userId: string,
    namespace: string,
    blob: EncryptedBlob,
    expectVersion: number,
  ): Promise<PutResult>;
}

/**
 * Metadata for ONE namespace whose version advanced past a client's cursor.
 *
 * SERVER-BLIND: deliberately carries NO `ciphertext`. It leaks only THAT/WHEN a
 * namespace changed (already-plaintext sync metadata), never WHAT. A client that
 * sees its namespace here re-pulls the blob over the authenticated GET. The
 * absence of `ciphertext` is a TYPE-level guarantee, asserted by the tests.
 */
export interface ChangedSettingMeta {
  namespace: string;
  /** Monotonic per (userId, namespace) — the new high-watermark for this row. */
  version: number;
  /** ISO-8601 server-assigned write time. */
  updatedAt: string;
}

/**
 * OPTIONAL offline-backfill capability (Track C), layered ALONGSIDE the frozen
 * `SettingStore` rather than baked into it. A store MAY also implement this to
 * answer "which of my namespaces changed since I was last online?".
 *
 * The cursor (`sinceVersion`) is an opaque per-user version high-watermark: the
 * largest `version` the client has already observed across ALL its namespaces.
 * `listChangedSince` returns metadata for every namespace whose stored `version`
 * is strictly greater than that watermark — METADATA ONLY, never `ciphertext`.
 */
export interface ChangeCursorStore {
  listChangedSince(
    userId: string,
    sinceVersion: number,
  ): Promise<ChangedSettingMeta[]>;
}

/** Narrowing helper: does this store also provide the change-cursor capability? */
export function supportsChangeCursor(
  store: SettingStore,
): store is SettingStore & ChangeCursorStore {
  return (
    typeof (store as Partial<ChangeCursorStore>).listChangedSince === "function"
  );
}

// ---------------------------------------------------------------------------
// 2.6 The transport interface (v1 — subscribeInContext DROPPED)
// ---------------------------------------------------------------------------

/**
 * The capability seam. Core ships `PollTransport` (default) + `NoopRealtimeTransport`
 * (CI); a consuming app injects a concrete transport (e.g. Skybber's
 * `AppSyncEventsTransport`) via `setRealtimeProvider()` WITHOUT core ever
 * importing an AWS SDK.
 *
 * `subscribeInContext` is intentionally NOT part of the v1 freeze (in-context
 * liveness is messaging-era; adding an optional method later is non-breaking).
 */
export interface RealtimeTransport {
  readonly kind: "poll" | "appsync-events" | "noop";
  /** Best-effort push. Runs the policy fence (floor) internally, every transport. */
  deliver(
    target: DeliveryTarget,
    channel: Channel,
    payload: Uint8Array,
  ): Promise<DeliveryResult>;
  getSetting(userId: string, namespace: string): Promise<EncryptedBlob | null>;
  putSetting(
    userId: string,
    namespace: string,
    blob: EncryptedBlob,
    expectVersion: number,
  ): Promise<PutResult>;
  shutdown?(): Promise<void>;
}

/** The policy port. WS1 ships `CalmDeliveryResolver`; WS3 may layer it. */
export interface DeliveryPolicyResolver {
  decide(ctx: DeliveryContext): DeliveryDecision;
}
