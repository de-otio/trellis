/**
 * Events Primitive E2E Tests
 *
 * Black-box lifecycle coverage for the Events primitive against a LIVE
 * deployed API (see routes/events.ts, events/event-handler.ts,
 * events/rsvp-handler.ts, events/shift-handler.ts):
 *   - create / get / list / list-mine / update (publish) / cancel (delete)
 *   - RSVP create, confirm, withdraw, attendee roster
 *   - capacity-1 waitlist + promotion across two shard users (best-effort —
 *     only observable when both users share a tenant; see the capacity
 *     block below)
 *   - shift create, list, signup, withdraw
 *   - request validation (400s)
 *   - cross-user authorization (own-only update/delete)
 *
 * Feature-flag tolerance: `events_enabled` may be OFF in the target
 * environment. `featureToggleMiddleware` (route-level) and
 * `EventHandler.featureEnabled` (defense-in-depth) both respond 404 when
 * disabled — indistinguishable from a non-existent route (feature-gate-
 * middleware.ts). The very first create call determines `eventsEnabled` for
 * the rest of the suite; every later test branches on it and skips the
 * dependent lifecycle steps when disabled, mirroring entity-crud.test.ts.
 *
 * Cleanup: events aren't in TestCleanup's known resource types, so cleanup
 * is explicit DELETE calls in afterAll. Deleting an event is a soft-cancel
 * (200, not 204) and is idempotent on an already-CANCELLED event, so
 * best-effort re-deletes here are harmless.
 *
 * All test data is prefixed with __e2e_.
 */

import { afterAll, describe, expect, it } from "vitest";
import { getApiUrl } from "../utils/test-config.js";
import { getShardUser } from "./utils/shard-user-pool.js";

const API_URL = getApiUrl();
const JSON_HEADERS = { "Content-Type": "application/json" };

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

describe("Events primitive", () => {
  const userA = getShardUser(0);
  const userB = getShardUser(1);

  // Discovered from the first create call; every later assertion branches on
  // it so the suite is green whether the target env has events_enabled on or off.
  let eventsEnabled = false;

  const createdEventIds: string[] = [];
  const createdShifts: Array<{ eventId: string; shiftId: string }> = [];

  afterAll(async () => {
    for (const { eventId, shiftId } of createdShifts.splice(0).reverse()) {
      await userA
        .authFetch(`${API_URL}/api/events/${eventId}/shifts/${shiftId}`, { method: "DELETE" })
        .catch(() => undefined);
    }
    for (const id of createdEventIds.splice(0).reverse()) {
      await userA
        .authFetch(`${API_URL}/api/events/${id}`, { method: "DELETE" })
        .catch(() => undefined);
    }
  });

  // ==========================================================================
  // Authentication — must hold regardless of the feature flag (401 happens
  // before any feature-toggle check in the route layer).
  // ==========================================================================
  describe("Authentication", () => {
    it("rejects unauthenticated create", async () => {
      const res = await fetch(`${API_URL}/api/events`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "__e2e_noauth", startsAt: futureIso(24) }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated list", async () => {
      const res = await fetch(`${API_URL}/api/events`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated get-by-id", async () => {
      const res = await fetch(`${API_URL}/api/events/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated mine", async () => {
      const res = await fetch(`${API_URL}/api/events/mine`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated rsvp", async () => {
      const res = await fetch(
        `${API_URL}/api/events/00000000-0000-0000-0000-000000000000/rsvp`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ status: "GOING", guests: 0 }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated shift create", async () => {
      const res = await fetch(
        `${API_URL}/api/events/00000000-0000-0000-0000-000000000000/shifts`,
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "__e2e_shift", capacity: 1 }),
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // Core lifecycle: create / validate / get / list / mine / publish
  // ==========================================================================
  let eventId: string | null = null;
  let eventPublished = false;

  it("creates an event (or feature is disabled)", async () => {
    const res = await userA.authFetch(`${API_URL}/api/events`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: `__e2e_event_${Date.now()}`,
        description: "black-box e2e event",
        visibility: "TENANT_ONLY",
        startsAt: futureIso(48),
        endsAt: futureIso(50),
      }),
    });

    // 201 = created; 404 = events_enabled is off (feature-gate middleware AND
    // EventHandler.featureEnabled both 404 a disabled feature, never 403).
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    expect([201, 404]).toContain(res.status);

    if (res.status === 201) {
      eventsEnabled = true;
      const body = await res.json();
      eventId = body.id;
      createdEventIds.push(eventId!);
      expect(typeof body.id).toBe("string");
      expect(body.title).toContain("__e2e_event_");
      expect(body.status).toBe("DRAFT"); // Prisma default; publish is a separate PATCH.
      expect(body.visibility).toBe("TENANT_ONLY");
      expect(typeof body.rsvpCount).toBe("number");
      expect(typeof body.waitlistCount).toBe("number");
      expect(body.location).toBeTruthy();
    }
  });

  it("rejects a malformed create body (missing required fields)", async () => {
    const res = await userA.authFetch(`${API_URL}/api/events`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    // Feature-off 404s before validation ever runs; feature-on validates and 400s.
    expect(res.status).toBe(eventsEnabled ? 400 : 404);
  });

  it("rejects endsAt before startsAt", async () => {
    const res = await userA.authFetch(`${API_URL}/api/events`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: `__e2e_bad_range_${Date.now()}`,
        startsAt: futureIso(48),
        endsAt: futureIso(1), // before startsAt
      }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(eventsEnabled ? 400 : 404);
  });

  it("gets the created event by id", async () => {
    if (!eventId) return;
    const res = await userA.authFetch(`${API_URL}/api/events/${eventId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(eventId);
    expect(body.status).toBe("DRAFT");
  });

  it("returns 404 (not 401/500) for a non-existent event id", async () => {
    const res = await userA.authFetch(
      `${API_URL}/api/events/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(404);
  });

  it("lists events (cursor-paginated shape)", async () => {
    const res = await userA.authFetch(`${API_URL}/api/events`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (eventsEnabled) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.hasMore).toBe("boolean");
    }
  });

  it("lists the caller's own events via /api/events/mine", async () => {
    const res = await userA.authFetch(`${API_URL}/api/events/mine`);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (eventsEnabled) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      if (eventId) {
        const found = (body.items as Array<{ id: string }>).some((e) => e.id === eventId);
        expect(found).toBe(true);
      }
    }
  });

  it("publishes the event (DRAFT -> PUBLISHED)", async () => {
    if (!eventId) return;
    const res = await userA.authFetch(`${API_URL}/api/events/${eventId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "PUBLISHED" }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      eventPublished = true;
      const body = await res.json();
      expect(body.status).toBe("PUBLISHED");
    }
  });

  // ==========================================================================
  // RSVP: create (confirmed, uncapped event), attendee roster, withdraw
  // ==========================================================================
  describe("RSVP", () => {
    it("RSVPs the creator as GOING", async () => {
      if (!eventId || !eventPublished) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/rsvp`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: "GOING", guests: 0 }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect([200, 201]).toContain(res.status);
      const body = await res.json();
      expect(body.status).toBe("GOING");
      expect(body.eventId).toBe(eventId);
      expect(body.guests).toBe(0);
    });

    it("lists attendees including the creator", async () => {
      if (!eventId || !eventPublished) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/attendees`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      if (res.status === 200) {
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        const entry = (
          body.items as Array<{ userId: string; status: string }>
        ).find((a) => a.userId === userA.userId);
        expect(entry?.status).toBe("GOING");
        // Attendee roster is a roster, not a location leak (§4.4).
        expect(entry).not.toHaveProperty("lat");
        expect(entry).not.toHaveProperty("lng");
      }
    });

    it("withdraws the RSVP", async () => {
      if (!eventId || !eventPublished) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/rsvp`, {
        method: "DELETE",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(204);
    });

    it("withdrawing again is idempotent", async () => {
      if (!eventId || !eventPublished) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/rsvp`, {
        method: "DELETE",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(204);
    });
  });

  // ==========================================================================
  // Capacity + waitlist across two shard users. This is only observable
  // black-box when userA and userB share a tenant; if they don't (separate
  // self-registered accounts, each the OWNER of their own tenant), userB's
  // RSVP 404s at the tenant-scoped visibility gate (rsvp-handler.ts
  // loadVisibleEvent) before it ever reaches the capacity check. That case
  // is treated as "not observable with these two accounts", not a failure —
  // the atomicity guarantee itself is covered by the integration test
  // (test/integration/events.integration.test.ts), not this e2e suite.
  // ==========================================================================
  describe("Capacity and waitlist", () => {
    let capEventId: string | null = null;
    let capEventPublished = false;

    it("creates and publishes a capacity-1 event", async () => {
      if (!eventsEnabled) return;
      const createRes = await userA.authFetch(`${API_URL}/api/events`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: `__e2e_capacity_${Date.now()}`,
          startsAt: futureIso(72),
          capacity: 1,
        }),
      });
      expect(createRes.status).not.toBe(401);
      expect(createRes.status).toBeLessThan(500);
      if (createRes.status !== 201) return;
      const created = await createRes.json();
      capEventId = created.id;
      createdEventIds.push(capEventId!);
      expect(created.capacity).toBe(1);

      const publishRes = await userA.authFetch(`${API_URL}/api/events/${capEventId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: "PUBLISHED" }),
      });
      expect(publishRes.status).not.toBe(401);
      expect(publishRes.status).toBeLessThan(500);
      capEventPublished = publishRes.status === 200;
    });

    it("confirms the first RSVP and waitlists (or 404s cross-tenant) the second", async () => {
      if (!eventsEnabled || !capEventId || !capEventPublished) return;

      const rsvpA = await userA.authFetch(`${API_URL}/api/events/${capEventId}/rsvp`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: "GOING", guests: 0 }),
      });
      expect(rsvpA.status).not.toBe(401);
      expect(rsvpA.status).toBeLessThan(500);
      if (rsvpA.status !== 201) return;
      const bodyA = await rsvpA.json();
      expect(bodyA.status).toBe("GOING");

      const rsvpB = await userB.authFetch(`${API_URL}/api/events/${capEventId}/rsvp`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: "GOING", guests: 0 }),
      });
      expect(rsvpB.status).not.toBe(401);
      expect(rsvpB.status).toBeLessThan(500);

      if (rsvpB.status === 404) {
        // userB's active tenant differs from capEventId's tenant — the
        // cross-user waitlist scenario isn't observable with this pair of
        // shard users. Clean up userA's RSVP and stop.
        await userA
          .authFetch(`${API_URL}/api/events/${capEventId}/rsvp`, { method: "DELETE" })
          .catch(() => undefined);
        return;
      }

      expect(rsvpB.status).toBe(201);
      const bodyB = await rsvpB.json();
      expect(bodyB.status).toBe("WAITLISTED");

      // Promotion: withdrawing the confirmed seat should promote the
      // waitlisted user (FIFO, promoteWaitlist in rsvp-handler.ts).
      const withdrawA = await userA.authFetch(`${API_URL}/api/events/${capEventId}/rsvp`, {
        method: "DELETE",
      });
      expect(withdrawA.status).toBe(204);

      const attendeesRes = await userA.authFetch(
        `${API_URL}/api/events/${capEventId}/attendees`,
      );
      expect(attendeesRes.status).toBe(200);
      const attendeesBody = await attendeesRes.json();
      const promoted = (
        attendeesBody.items as Array<{ userId: string; status: string }>
      ).find((a) => a.userId === userB.userId);
      expect(promoted?.status).toBe("GOING");

      await userB
        .authFetch(`${API_URL}/api/events/${capEventId}/rsvp`, { method: "DELETE" })
        .catch(() => undefined);
    });
  });

  // ==========================================================================
  // Shifts: create, list, signup, withdraw
  // ==========================================================================
  describe("Shifts", () => {
    let shiftId: string | null = null;

    it("creates a shift on the event", async () => {
      if (!eventId) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/shifts`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: `__e2e_shift_${Date.now()}`,
          capacity: 2,
        }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect([201, 404]).toContain(res.status);
      if (res.status === 201) {
        const body = await res.json();
        shiftId = body.id;
        createdShifts.push({ eventId: eventId!, shiftId: shiftId! });
        expect(body.eventId).toBe(eventId);
        expect(body.capacity).toBe(2);
        expect(body.filledCount).toBe(0);
      }
    });

    it("rejects a malformed shift body", async () => {
      if (!eventId) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/shifts`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      if (shiftId) {
        // We know the flag is on (a shift already got created above).
        expect(res.status).toBe(400);
      }
    });

    it("lists shifts for the event", async () => {
      if (!eventId) return;
      const res = await userA.authFetch(`${API_URL}/api/events/${eventId}/shifts`);
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      if (res.status === 200) {
        const body = await res.json();
        expect(Array.isArray(body.shifts)).toBe(true);
      }
    });

    it("signs up for the shift", async () => {
      if (!eventId || !shiftId) return;
      const res = await userA.authFetch(
        `${API_URL}/api/events/${eventId}/shifts/${shiftId}/signup`,
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) },
      );
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect([200, 201]).toContain(res.status);
      const body = await res.json();
      expect(body.status).toBe("CONFIRMED");
      expect(body.shiftId).toBe(shiftId);
    });

    it("withdraws from the shift", async () => {
      if (!eventId || !shiftId) return;
      const res = await userA.authFetch(
        `${API_URL}/api/events/${eventId}/shifts/${shiftId}/signup`,
        { method: "DELETE" },
      );
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(204);
    });

    it("deletes the shift", async () => {
      if (!eventId || !shiftId) return;
      const res = await userA.authFetch(
        `${API_URL}/api/events/${eventId}/shifts/${shiftId}`,
        { method: "DELETE" },
      );
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(204);
    });
  });

  // ==========================================================================
  // Authorization: a non-owning user may not update/delete/moderate someone
  // else's event. Expect 403 (own-only capability, same tenant, no
  // EventModerate) OR 404 (different tenant — existence not confirmed across
  // tenants, see event-handler.ts handleUpdate/handleDelete). Never 401
  // (auth itself succeeds) and never a bypass 200/204.
  // ==========================================================================
  describe("Authorization", () => {
    it("userB cannot update userA's event", async () => {
      if (!eventId) return;
      const res = await userB.authFetch(`${API_URL}/api/events/${eventId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: `__e2e_hijacked_${Date.now()}` }),
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      if (eventsEnabled) {
        expect([403, 404]).toContain(res.status);
      }
    });

    it("userB cannot delete (cancel/moderate) userA's event", async () => {
      if (!eventId) return;
      const res = await userB.authFetch(`${API_URL}/api/events/${eventId}`, {
        method: "DELETE",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
      if (eventsEnabled) {
        expect([403, 404]).toContain(res.status);
      }
    });
  });

  // ==========================================================================
  // Final cancellation of the primary event (soft-delete: 200 + CANCELLED,
  // not 204 — see EventHandler.handleDelete).
  // ==========================================================================
  it("cancels (soft-deletes) the event", async () => {
    if (!eventId) return;
    const res = await userA.authFetch(`${API_URL}/api/events/${eventId}`, {
      method: "DELETE",
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
    if (eventsEnabled) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("CANCELLED");
    }
  });
});
