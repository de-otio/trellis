/**
 * Signup-metadata capture (Surveillance-hardening Phase 0, E2 / P3).
 *
 * This module is the ONE choke point through which signup metadata is written.
 * Every path that creates a `User` row (the Cognito PostConfirmation Lambda, the
 * dev/test user-creation seam, and any future passwordless/invite path) MUST go
 * through `signupUserData()` to populate `User.signupMethod` / `User.invitationId`
 * and through `emitSignupSecurityEvent()` to record the client signals. Spreading
 * this logic across call sites is a review-surface and data-minimization hazard
 * (07-data-minimization.md): keep it here so there is exactly one place to audit.
 *
 * Data-minimization rules enforced here:
 *
 *  1. Client signals (IP / User-Agent) are NEVER written as columns on `User`.
 *     They live only on a retention-bound `SecurityEvent` row (raw, deliberate —
 *     security forensics), pruned by the hourly cron's `retentionUntil`
 *     deleteMany. `retentionUntil` is NON-NULLABLE (P1): a missing bound would
 *     escape pruning forever, exactly the unbounded client-metadata log the
 *     threat model forbids. We always compute it from config.
 *
 *  2. A signup with no request context (e.g. a seed script) gets `signupMethod`
 *     but NO fabricated IP/UA — we record only what actually exists.
 *
 *  3. Fail-open: the SecurityEvent write must never block account creation. A
 *     telemetry failure is logged and swallowed; the user is still created.
 *
 * ── INVITATION-CHAIN INVARIANT (Phase 0, E2 — do not weaken) ──────────────────
 * `User.invitationId` → `Invitation.createdBy` makes the who-invited-whom tree
 * cheaply traversable. That is useful for Phase 2 cluster detection, but under
 * legal compulsion it maps a community's entire introduction network
 * (01-threat-landscape.md §4). The chain was already reconstructable via
 * `Invitation.usedBy`; this FK only lowers the cost.
 *
 *   INVARIANT: NO API endpoint — user-facing OR admin — exposes transitive
 *   invitation chains. Traversal of the invitation graph is reserved for the
 *   Phase 2 detection path and nothing else. Whether to null out `invitationId`
 *   after the detection window is an open Phase 2 decision (recorded there, not
 *   silently resolved here).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type { SignupMethod } from "@prisma/client";

/**
 * Default retention for `signup` SecurityEvents: 180 days. Longer than
 * InteractionEvent (signup cohorts are the slowest-moving abuse signal) but
 * still bounded. The exact number is config-driven per the threshold-secrecy
 * invariant — see `env.SIGNUP_EVENT_RETENTION_DAYS`.
 */
export const DEFAULT_SIGNUP_EVENT_RETENTION_DAYS = 180;

/** Minimal config surface this module needs (a slice of `Env`). */
export interface SignupRetentionConfig {
  /** Retention window in days for `signup` SecurityEvents. */
  SIGNUP_EVENT_RETENTION_DAYS?: string | number;
}

/**
 * Resolve the configured retention window for `signup` events, in days.
 * Falls back to {@link DEFAULT_SIGNUP_EVENT_RETENTION_DAYS} when unset or
 * non-positive / non-numeric (never returns an unbounded / zero retention).
 */
export function resolveSignupRetentionDays(
  config: SignupRetentionConfig | undefined,
): number {
  const raw = config?.SIGNUP_EVENT_RETENTION_DAYS;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SIGNUP_EVENT_RETENTION_DAYS;
  }
  return parsed;
}

/** Compute the absolute `retentionUntil` date from config (now + N days). */
export function computeSignupRetentionUntil(
  config: SignupRetentionConfig | undefined,
  now: Date = new Date(),
): Date {
  const days = resolveSignupRetentionDays(config);
  const date = new Date(now.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

/** The signup-metadata fields written onto a new `User` row. */
export interface SignupUserData {
  signupMethod: SignupMethod;
  /** Prisma `Invitation.id` redeemed at signup, or null when not invite-based. */
  invitationId: string | null;
}

/**
 * Build the `User`-row signup-metadata fragment. This is the ONLY place these
 * two columns are populated. `invitationId` is set only for INVITE signups and
 * must be a real `Invitation.id` (the FK is enforced at the DB; see schema).
 */
export function signupUserData(input: {
  method: SignupMethod;
  invitationId?: string | null;
}): SignupUserData {
  return {
    signupMethod: input.method,
    // Only INVITE signups carry an invitation FK; never fabricate one.
    invitationId: input.method === "INVITE" ? input.invitationId ?? null : null,
  };
}

/** Client signals captured for a signup, where a request context exists. */
export interface SignupClientSignals {
  /** Source IP, if a request context provided one (Lambda triggers may not). */
  ipAddress?: string | null;
  /** User-Agent, if present. */
  userAgent?: string | null;
}

/**
 * Minimal Prisma surface needed to write a SecurityEvent (test-friendly).
 *
 * `create` is intentionally loosely typed (`data: any`) so the real, far more
 * strictly typed Prisma `securityEvent.create` (and a plain `vi.fn()` mock)
 * both satisfy it. The concrete `data` shape is constrained where we build it
 * in {@link emitSignupSecurityEvent}.
 */
export interface SecurityEventWriter {
  securityEvent: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args: { data: any }) => Promise<unknown>;
  };
}

/** Minimal logger surface (console-style). */
export interface SignupLogger {
  warn: (...args: unknown[]) => void;
}

export interface EmitSignupEventInput {
  db: SecurityEventWriter;
  userId: string;
  method: SignupMethod;
  /** Prisma `Invitation.id` if INVITE, else null/undefined. */
  invitationId?: string | null;
  /** Tenant scope, if known at signup (personal/org tenant). */
  tenantId?: string | null;
  /** Client signals — omitted entirely when there is no request context. */
  signals?: SignupClientSignals;
  config: SignupRetentionConfig | undefined;
  logger?: SignupLogger;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Emit exactly one `signup`-type SecurityEvent for a freshly created user.
 *
 * FAIL-OPEN: any failure writing the event is logged and swallowed — account
 * creation must never be blocked by telemetry. Callers MUST invoke this AFTER
 * the user row is committed (so a telemetry hiccup can't roll back the signup).
 *
 * Returns `true` if the event was written, `false` if it failed (and was
 * swallowed) — useful for tests / metrics, never to gate the signup.
 */
export async function emitSignupSecurityEvent(
  input: EmitSignupEventInput,
): Promise<boolean> {
  const {
    db,
    userId,
    method,
    invitationId,
    tenantId,
    signals,
    config,
    logger,
    now,
  } = input;

  try {
    const retentionUntil = computeSignupRetentionUntil(config, now);
    await db.securityEvent.create({
      data: {
        type: "signup",
        // `signup` is a low-severity informational forensic record, not an alert.
        severity: "low",
        userId,
        tenantId: tenantId ?? null,
        // No fabricated client signals: only what the request context actually
        // carried. Lambda triggers (Cognito PostConfirmation) expose no source
        // IP/UA, so these stay null there.
        ipAddress: signals?.ipAddress ?? null,
        userAgent: signals?.userAgent ?? null,
        details: JSON.stringify({
          signupMethod: method,
          invitationId: invitationId ?? null,
        }),
        // NON-NULLABLE (P1): always set, config-driven.
        retentionUntil,
      },
    });
    return true;
  } catch (error) {
    // FAIL-OPEN — log and continue. The user is already created.
    (logger ?? console).warn(
      JSON.stringify({
        event: "signup.security_event_failed",
        userId,
        signupMethod: method,
        reason: (error as { name?: string }).name ?? "unknown",
      }),
    );
    return false;
  }
}
