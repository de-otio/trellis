/**
 * Events primitive — shared PURE-DOMAIN types (R1).
 *
 * These are the types the pure functional core (`event-core.ts`, P1-A), the
 * handlers (P1-B/C/D), and their tests share. Deliberately free of any Prisma /
 * I/O import so the functional core stays pure (functional-core / imperative-
 * shell, design default #2). The string-literal unions MIRROR the Prisma enums
 * of the same name (schema.prisma) and are structurally assignable to them, so
 * a handler holding a Prisma `RsvpStatus` can pass it where these expect one.
 *
 * Design: plans/events-primitive/README.md §4.3, §5.
 */

/** Mirrors the Prisma `RsvpStatus` enum. */
export type RsvpStatusLiteral = "GOING" | "MAYBE" | "NOT_GOING" | "WAITLISTED";

/** Mirrors the Prisma `EventStatus` enum. */
export type EventStatusLiteral = "DRAFT" | "PUBLISHED" | "CANCELLED";

/** Mirrors the Prisma `EventVisibility` enum. */
export type EventVisibilityLiteral = "TENANT_ONLY" | "GROUP_ONLY" | "PUBLIC";

/** Mirrors the Prisma `ShiftSignupStatus` enum. */
export type ShiftSignupStatusLiteral = "CONFIRMED" | "WAITLISTED" | "CANCELLED";

/** Mirrors the Prisma `LocationPrecision` enum. */
export type LocationPrecisionLiteral =
  | "EXACT"
  | "NEIGHBORHOOD"
  | "CITY"
  | "HIDDEN";

/**
 * Inputs to the pure capacity decision (`decideRsvpOutcome`, P1-A). `capacity`
 * null = unlimited. `party` = 1 + guests (already clamped at the Zod boundary
 * to `maxGuests`). All readonly — the pure core never mutates its inputs.
 */
export interface RsvpDecisionInput {
  readonly currentCount: number;
  readonly capacity: number | null;
  readonly party: number;
}

/** Terminal status the capacity decision can assign to a fresh/GOING RSVP. */
export type RsvpDecisionStatus = "GOING" | "WAITLISTED";

/**
 * Result of the pure capacity decision. The NO-over-capacity GUARANTEE lives in
 * the handler's atomic conditional SQL (§4.3 MED-1), NOT here — this type only
 * carries the arithmetic decision the shell then attempts atomically.
 */
export interface RsvpOutcome {
  readonly status: RsvpDecisionStatus;
  /** Party size = 1 + guests. */
  readonly party: number;
  /** Amount to add to Event.rsvpCount if the atomic seat claim succeeds. */
  readonly rsvpCountDelta: number;
  /** Amount to add to Event.waitlistCount. */
  readonly waitlistCountDelta: number;
}
