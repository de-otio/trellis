/**
 * Events primitive — INJECTED SEAM INTERFACES (R1, review HIGH-2 fix).
 *
 * The event handlers reach their two cross-cutting behaviors — feed companion
 * posts and EVENT_* notifications — ONLY through these injected interfaces, so
 * each handler is a disjoint new file that unit-tests with mocks and is
 * complete at the end of Phase 1 (no shared-file edits, no worktrees). Phase 2
 * does DI assembly only.
 *
 *  - `FeedAnnouncer` wraps the extracted `PostHandler.createSystemPost` seam
 *    (cache-version bump + AP outbox). It owns the companion-Post lifecycle:
 *    announce on publish, update on material change (AP Update), retract on
 *    cancel (AP Delete) — §4.6 HIGH-1.
 *  - `NotificationProducer` emits EVENT_UPDATED / EVENT_CANCELLED to current
 *    GOING attendees, respecting NotificationPreference + CalmDeliveryResolver,
 *    batched, and debounced against amplification (§4.6 SEC-5).
 *
 * Design: plans/events-primitive/README.md §2, §4.6.
 */

import type { EventVisibility, LocationPrecision } from "@prisma/client";
import type { Env } from "../../env.js";
import type { PostRadius } from "../graph/types.js";

// ============================================================================
// FeedAnnouncer
// ============================================================================

/**
 * Location snapshot handed to the announcer / detail serializer. `lat`/`lng`
 * are the TRUE coordinates; `displayLat`/`displayLng` the fuzzed pair. The
 * announcer applies `precisionFilteredLocation` before composing the Post body
 * so raw coordinates never leak below EXACT precision (§4.6 SEC-6).
 */
export interface EventLocationSnapshot {
  readonly precision: LocationPrecision;
  readonly locationName: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly displayLat: number | null;
  readonly displayLng: number | null;
}

/**
 * Everything the announcer needs to create / update / retract an event's
 * companion Post, with no dependency on the Prisma `Event` row shape.
 */
export interface EventAnnouncementInput {
  readonly eventId: string;
  readonly tenantId: string;
  /** User.id used as the companion Post's author. */
  readonly creatorId: string;
  readonly visibility: EventVisibility;
  readonly title: string;
  readonly description: string | null;
  /** ISO 8601 start instant. */
  readonly startsAt: string;
  /** IANA timezone the event is scheduled in. */
  readonly timezone: string;
  readonly location: EventLocationSnapshot;
  /**
   * Existing companion Post id (Event.announcePostId). Required for
   * `update`/`retract`; ignored by `announce`.
   */
  readonly announcePostId?: string | null;
}

export interface FeedAnnouncer {
  /**
   * Create the companion Post for a newly PUBLISHED event through the
   * PostHandler seam. Returns the new Post id to store on
   * `Event.announcePostId`, or `null` when no companion Post is created
   * (GROUP_ONLY — no safe feed radius, §4.6 SEC-2).
   */
  announce(input: EventAnnouncementInput, env: Env): Promise<string | null>;
  /**
   * Update the companion Post after a material change (AP Update). No-op when
   * `announcePostId` is null.
   */
  update(input: EventAnnouncementInput, env: Env): Promise<void>;
  /**
   * Retract the companion Post on cancellation (AP Delete). No-op when
   * `announcePostId` is null.
   */
  retract(input: EventAnnouncementInput, env: Env): Promise<void>;
}

// ============================================================================
// NotificationProducer
// ============================================================================

/**
 * Shared context for an event notification. The producer resolves the actual
 * recipients (current GOING attendees) itself from `(eventId, tenantId)`; the
 * caller supplies only the event summary needed for the copy.
 */
export interface EventNotificationContext {
  readonly eventId: string;
  readonly tenantId: string;
  /** Event title, for the notification title/body. */
  readonly title: string;
  /** ISO 8601 start instant, for the body / reschedule copy. */
  readonly startsAt: string;
}

/** Material field(s) whose change triggers an EVENT_UPDATED notification. */
export type EventChangedField = "startsAt" | "endsAt" | "location";

export interface EventUpdatedNotification extends EventNotificationContext {
  /** Which material fields changed — drives copy AND the debounce key. */
  readonly changedFields: ReadonlyArray<EventChangedField>;
}

export interface NotificationProducer {
  /**
   * Notify current GOING attendees that a PUBLISHED event materially changed
   * (startsAt/endsAt/location). Resolves recipients from `(eventId, tenantId)`,
   * respects each recipient's NotificationPreference + CalmDeliveryResolver,
   * batches by a shared batchId, and applies the
   * `env.event.updateNotifyCooldownSeconds` debounce (SEC-5). Best-effort:
   * MUST NOT throw into the event-update path.
   */
  notifyEventUpdated(
    input: EventUpdatedNotification,
    env: Env,
  ): Promise<void>;
  /**
   * Notify current GOING attendees that the event was cancelled. Same delivery
   * contract as `notifyEventUpdated`. Best-effort.
   */
  notifyEventCancelled(
    input: EventNotificationContext,
    env: Env,
  ): Promise<void>;
}

// ============================================================================
// Pure visibility / precision helpers (shared by the announcer + serializer)
// ============================================================================

/** How an event's visibility maps onto a companion Post (§4.6 SEC-2). */
export type CompanionPostPlan =
  | { readonly kind: "post"; readonly radius: PostRadius; readonly groupId: null }
  | { readonly kind: "none" };

/**
 * Visibility → companion-Post mapping (pure):
 *  - PUBLIC      → Post radius SHOUT, groupId null (federates).
 *  - TENANT_ONLY → Post radius NORMAL, groupId null (no federation).
 *  - GROUP_ONLY  → NO companion Post (no feed radius safely limits to a group).
 */
export function planCompanionPost(
  visibility: EventVisibility,
): CompanionPostPlan {
  switch (visibility) {
    case "PUBLIC":
      return { kind: "post", radius: "SHOUT", groupId: null };
    case "TENANT_ONLY":
      return { kind: "post", radius: "NORMAL", groupId: null };
    case "GROUP_ONLY":
      return { kind: "none" };
    default: {
      // Exhaustiveness guard — a new EventVisibility must be classified here.
      const _never: never = visibility;
      return _never;
    }
  }
}

/** Precision-filtered location safe to expose (Post body + detail serializer). */
export interface FilteredLocation {
  readonly label: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
}

/**
 * Apply `LocationPrecision` to a location snapshot (pure, §4.6 SEC-6):
 *  - HIDDEN       → nothing.
 *  - CITY         → label only, no coordinates.
 *  - NEIGHBORHOOD → label + the FUZZED displayLat/displayLng.
 *  - EXACT        → label + the true lat/lng.
 * Never returns raw `lat`/`lng` below EXACT precision.
 */
export function precisionFilteredLocation(
  location: EventLocationSnapshot,
): FilteredLocation {
  switch (location.precision) {
    case "HIDDEN":
      return { label: null, lat: null, lng: null };
    case "CITY":
      return { label: location.locationName, lat: null, lng: null };
    case "NEIGHBORHOOD":
      return {
        label: location.locationName,
        lat: location.displayLat,
        lng: location.displayLng,
      };
    case "EXACT":
      return {
        label: location.locationName,
        lat: location.lat,
        lng: location.lng,
      };
    default: {
      const _never: never = location.precision;
      return _never;
    }
  }
}
