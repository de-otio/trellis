/**
 * Audit composer (phase 1.C.2).
 *
 * Trellis-side facade over `@de-otio/saas-foundation/audit`. Replaces
 * the old `AuditLogger` (data lifecycle) and `AuditEventEmitter`
 * (tenant / IdP) with a single composition point that:
 *
 *   1. Applies trellis's default-DENY allowlist (`filterPayload`) +
 *      IP anonymisation (`anonymizeIp`) to event metadata BEFORE the
 *      event reaches foundation. (LOCKED: keep the allowlist.)
 *   2. Hands the scrubbed event to foundation's `AuditLog`, which is
 *      configured with foundation's `PiiFilter` (denylist) as a
 *      SECOND, additive layer. (LOCKED: denylist is additive, not a
 *      replacement.)
 *   3. Persists via `PostgresAuditStore` over a region-resolved Prisma
 *      client. Retention tiers: info=30, warning=90, error=365 days.
 *      (LOCKED.)
 *
 * Frozen-type crossing: this module is the first trellis consumer of
 * the frozen `AuditEvent` / `AuditAction` vocabulary. Future changes to
 * the emitted shape go through the frozen-type RFC process.
 *
 * Severity collapse (trellis 4-tier -> foundation 3-tier):
 *   low + medium -> info     (30d)
 *   high         -> warning  (90d)
 *   critical     -> error    (365d)
 */

import { AuditLog, PiiFilter } from "@de-otio/saas-foundation/audit";
import type { AuditAction, AuditEvent } from "@de-otio/saas-foundation/audit";
import { PostgresAuditStore } from "@de-otio/saas-foundation/audit/prisma";
import type { PrismaAuditClient } from "@de-otio/saas-foundation/audit/prisma";
import type { TenantId } from "@de-otio/saas-foundation/types/frozen";

import { createPrismaForRegion, type EnvWithDb } from "../db.js";
import { getLogger } from "./logger.js";
import { isValidRegion, type Region } from "./region-detection.js";
import { filterPayload, anonymizeIp } from "./audit/pii-filter.js";
import {
  DATA_READ,
  DATA_CREATE,
  DATA_UPDATE,
  DATA_DELETE,
  AUTHZ_DENIED,
} from "./audit-actions.js";

/** Retention tiers (LOCKED): collapse trellis intent onto foundation's. */
const RETENTION_DAYS = { info: 30, warning: 90, error: 365 } as const;

// ── Severity mapping (trellis 4-tier -> foundation 3-tier) ────────────
export type TrellisSeverity = "low" | "medium" | "high" | "critical";
type FoundationSeverity = "info" | "warning" | "error";

function mapSeverity(severity: TrellisSeverity): FoundationSeverity {
  switch (severity) {
    case "low":
    case "medium":
      return "info";
    case "high":
      return "warning";
    case "critical":
      return "error";
  }
}

/**
 * Foundation's `EmitInput.metadata` is `Record<string, JsonValue>`.
 * Trellis call sites pass `Record<string, unknown>`; scrub + coerce to
 * a JSON-safe shape (the allowlist already replaces non-allowed values
 * with the literal "<redacted>" string, and IP is pre-anonymised).
 */
type JsonSafe = string | number | boolean | null | JsonSafe[] | { [k: string]: JsonSafe };

function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value as JsonSafe;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (t === "object") {
    const out: { [k: string]: JsonSafe } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return String(value);
}

/**
 * Apply trellis's allowlist to a raw metadata object and coerce to a
 * JSON-safe record. Returns `undefined` for an empty input so we don't
 * emit an empty `metadata: {}`.
 */
function scrubMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, JsonSafe> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  const { filtered } = filterPayload(metadata);
  const out: Record<string, JsonSafe> = {};
  for (const [k, v] of Object.entries(filtered)) {
    out[k] = toJsonSafe(v);
  }
  return out;
}

/**
 * Anything with an `auditEvent.create` method. The real Prisma client
 * (`ManagedPrismaClient`), the structural `PrismaAuditClient`, and test
 * mocks all satisfy this. Foundation's `PostgresAuditStore` requires the
 * narrower `PrismaAuditClient`; Prisma's generated `create` is more
 * generic than (and so not structurally assignable to) foundation's
 * narrow shape, so we accept the broad type at the boundary and cast
 * once inside `getAuditLog`. The cast is runtime-safe — the column
 * names foundation writes match the generated `AuditEvent` model.
 */
export type AuditPrismaClientLike = {
  readonly auditEvent: { create: (...args: never[]) => unknown };
};

// ── AuditLog cache (per region-resolved Prisma client) ────────────────
// One AuditLog per Prisma client. The DatabaseConnectionManager already
// caches the underlying pool per region, so this just avoids rebuilding
// the foundation wrapper on every emit.
const auditLogByClient = new WeakMap<object, AuditLog>();

function getAuditLog(prisma: AuditPrismaClientLike): AuditLog {
  const existing = auditLogByClient.get(prisma);
  if (existing) return existing;
  const log = new AuditLog(new PostgresAuditStore(prisma as unknown as PrismaAuditClient), {
    retentionDays: RETENTION_DAYS,
    // Foundation's denylist as the additive second PII layer.
    piiFilter: new PiiFilter(),
  });
  auditLogByClient.set(prisma, log);
  return log;
}

// ── Trellis data-lifecycle event shape (mirrors old AuditLogger) ──────
export type TrellisAuditEventType =
  | "data_access"
  | "data_create"
  | "data_update"
  | "data_delete"
  | "user_action"
  | "authentication"
  | "authorization"
  | "region_change";

export interface TrellisAuditEvent {
  type?: TrellisAuditEventType;
  action: string;
  resource: string;
  resourceId?: string;
  userId?: string;
  region: Region;
  dataRegion?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  severity?: TrellisSeverity;
  success: boolean;
}

export interface TrellisAuditLoggerEnv extends EnvWithDb {
  DEFAULT_REGION?: string;
}

/**
 * Map a trellis event `type` to a frozen `AuditAction`. The trellis
 * `action` string (e.g. "user_accessed") is preserved in metadata; the
 * coarse foundation action keeps the open-union dotted convention.
 */
function actionFor(type: TrellisAuditEventType): AuditAction {
  switch (type) {
    case "data_access":
      return DATA_READ;
    case "data_create":
      return DATA_CREATE;
    case "data_update":
      return DATA_UPDATE;
    case "data_delete":
      return DATA_DELETE;
    case "region_change":
      return "system.region_change";
    case "authentication":
      return "auth.login";
    case "authorization":
      return AUTHZ_DENIED;
    case "user_action":
      return DATA_UPDATE;
  }
}

/**
 * `TrellisAuditLogger` — drop-in for the old `AuditLogger`. Region-aware
 * (resolves a Prisma client per region), best-effort (never throws into
 * the caller), and validates region before emitting (invalid-region
 * events are dropped, as before).
 */
export class TrellisAuditLogger {
  // Constructor kept signature-compatible with old `new AuditLogger(env)`
  // / `new AuditLogger(env, requestId)`; env is unused (region drives the
  // client) but accepted so call sites don't change.
  public constructor(
    _env?: TrellisAuditLoggerEnv,
    private readonly requestId?: string,
  ) {}

  public withRequestId(requestId: string): TrellisAuditLogger {
    return new TrellisAuditLogger(undefined, requestId);
  }

  public async logDataAccess(
    event: Omit<TrellisAuditEvent, "type" | "severity"> & {
      type?: TrellisAuditEventType;
      severity?: TrellisSeverity;
    },
    env: TrellisAuditLoggerEnv,
  ): Promise<void> {
    return this.emit(
      { ...event, type: event.type ?? "data_access", severity: event.severity ?? "low" },
      env,
    );
  }

  public async logUserAction(
    event: Omit<TrellisAuditEvent, "type" | "severity"> & {
      type?: TrellisAuditEventType;
      severity?: TrellisSeverity;
    },
    env: TrellisAuditLoggerEnv,
  ): Promise<void> {
    return this.emit(
      { ...event, type: event.type ?? "user_action", severity: event.severity ?? "medium" },
      env,
    );
  }

  public async logAuthentication(
    event: Omit<TrellisAuditEvent, "type" | "severity"> & {
      type?: TrellisAuditEventType;
      severity?: TrellisSeverity;
    },
    env: TrellisAuditLoggerEnv,
  ): Promise<void> {
    return this.emit(
      {
        ...event,
        resource: event.resource || "user",
        type: event.type ?? "authentication",
        severity: event.severity ?? (event.success ? "low" : "high"),
      },
      env,
    );
  }

  public async logAuthorization(
    event: Omit<TrellisAuditEvent, "type" | "severity"> & {
      type?: TrellisAuditEventType;
      severity?: TrellisSeverity;
    },
    env: TrellisAuditLoggerEnv,
  ): Promise<void> {
    return this.emit(
      {
        ...event,
        type: event.type ?? "authorization",
        severity: event.severity ?? (event.success ? "low" : "high"),
      },
      env,
    );
  }

  /** Generic entry point — accepts a full trellis event. */
  public async log(
    event: Omit<TrellisAuditEvent, "severity"> & { severity?: TrellisSeverity },
    env: TrellisAuditLoggerEnv,
  ): Promise<void> {
    const type = event.type ?? "user_action";
    const defaultSeverity: TrellisSeverity =
      type === "authentication" || type === "authorization"
        ? event.success
          ? "low"
          : "high"
        : type === "data_access"
          ? "low"
          : "medium";
    return this.emit({ ...event, type, severity: event.severity ?? defaultSeverity }, env);
  }

  private async emit(event: TrellisAuditEvent, env: TrellisAuditLoggerEnv): Promise<void> {
    const logger = getLogger();
    try {
      // Region validation — drop invalid-region events (preserved).
      if (!isValidRegion(event.region)) {
        logger.error("[Audit] Invalid region in audit event", {
          region: event.region,
          action: event.action,
        });
        return;
      }

      const type = event.type ?? "user_action";
      const severity = mapSeverity(event.severity ?? "low");

      // Build the metadata: carry the trellis action / resource /
      // region context, then scrub through the allowlist. The IP is
      // anonymised and lives on the frozen `ipAddress` field (not
      // metadata) so foundation persists it verbatim.
      const rawMetadata: Record<string, unknown> = {
        action: event.action,
        resource: event.resource,
        ...(event.region !== undefined && { region: event.region }),
        ...(event.dataRegion !== undefined && { dataRegion: event.dataRegion }),
        ...event.metadata,
      };
      const metadata = scrubMetadata(rawMetadata);
      const anonIp = event.ipAddress ? anonymizeIp(event.ipAddress) : undefined;

      const prisma = createPrismaForRegion(event.region, env) as AuditPrismaClientLike;
      const auditLog = getAuditLog(prisma);

      const failureReason =
        !event.success && typeof event.metadata?.error === "string"
          ? event.metadata.error
          : undefined;

      await auditLog.emitAwait({
        actor: event.userId
          ? { kind: "user", userSub: event.userId }
          : { kind: "anonymous" },
        action: actionFor(type),
        ...(event.resource && event.resourceId
          ? { resource: { kind: event.resource, id: event.resourceId } }
          : {}),
        outcome: event.success ? "success" : "failure",
        ...(failureReason !== undefined && { failureReason }),
        severity,
        ...(this.requestId !== undefined && { requestId: this.requestId }),
        ...(anonIp !== undefined && { ipAddress: anonIp }),
        ...(event.userAgent !== undefined && { userAgent: event.userAgent }),
        ...(metadata !== undefined && { metadata }),
      });

      // Operator-facing audit line (preserved contract).
      const message = `[Audit] ${event.action} on ${event.resource}${
        event.resourceId ? ` (${event.resourceId})` : ""
      } in region ${event.region}${event.dataRegion ? ` (dataRegion: ${event.dataRegion})` : ""}`;
      const logFields = {
        type,
        action: event.action,
        resource: event.resource,
        region: event.region,
        dataRegion: event.dataRegion,
        userId: event.userId,
      };
      if (event.success) {
        logger.info(message, logFields);
      } else {
        logger.warn(message, { ...logFields, error: event.metadata?.error });
      }
    } catch (error) {
      // Best-effort: never block the in-flight request on an audit
      // failure.
      logger.error("[Audit] Failed to log audit event", {
        error,
        action: event.action,
        resource: event.resource,
      });
    }
  }
}

/** Factory — drop-in for the old `createAuditLogger`. */
export function createAuditLogger(
  env?: TrellisAuditLoggerEnv,
  requestId?: string,
): TrellisAuditLogger {
  return new TrellisAuditLogger(env, requestId);
}

// ── Tenant / IdP emitter (replaces AuditEventEmitter) ─────────────────

/** Input shape preserved from the old `AuditEventEmitter.emit`. */
export interface TenantAuditEmitInput {
  type: AuditAction;
  tenantId: string;
  actorUserId: string;
  payload: Record<string, unknown>;
  /** Source IP — anonymised to /24 (v4) or /64 (v6) before storage. */
  sourceIp?: string;
  /** Present when made through an agent session. */
  agentSessionId?: string;
}

/**
 * `TenantAuditEmitter` — replaces the CloudWatch+Postgres
 * `AuditEventEmitter`. CloudWatch is dropped (foundation owns the sink);
 * the Postgres write now goes through foundation's `AuditLog` /
 * `PostgresAuditStore`. Signature `emit(input, prismaClient)` is
 * preserved so the four consumers change only their import.
 *
 * Tenant/IdP events are tenant-scoped (`actor.kind = "user"`,
 * `tenantId` set) and default to `info` severity (matching the old
 * "medium" -> info collapse).
 */
export class TenantAuditEmitter {
  public async emit(input: TenantAuditEmitInput, prisma: AuditPrismaClientLike): Promise<void> {
    try {
      const auditLog = getAuditLog(prisma);
      const anonIp = input.sourceIp ? anonymizeIp(input.sourceIp) : "unknown";

      const rawMetadata: Record<string, unknown> = {
        ...input.payload,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        sourceIp: anonIp,
        ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      };
      const metadata = scrubMetadata(rawMetadata);

      await auditLog.emitAwait({
        // `tenantId` is validated against `TenantIdSchema` inside
        // foundation's `AuditLog.emit`; cast to the branded type to
        // satisfy `EmitInput` (runtime check is the source of truth).
        tenantId: input.tenantId as TenantId,
        actor: { kind: "user", userSub: input.actorUserId },
        action: input.type,
        outcome: "success",
        severity: "info",
        ...(anonIp !== "unknown" ? { ipAddress: anonIp } : {}),
        ...(metadata !== undefined && { metadata }),
      });
    } catch (err) {
      // Best-effort: audit failures must not block the mutation.
      // eslint-disable-next-line no-console -- audit-fallback line for ops grep
      console.error(
        JSON.stringify({
          level: "error",
          tag: "audit-fallback",
          type: input.type,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

export type { AuditEvent };
