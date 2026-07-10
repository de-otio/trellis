/**
 * Unit tests: EventHandler (R1, P1-B).
 *
 * Mocks Prisma (createPrisma), FeatureToggleService, GroupService, the
 * directory-profile fuzz-radius resolver, and `requireCapability` (auth
 * internals are covered by require.test.ts — here we only assert the handler
 * calls it with the right capability/resource and honors its verdict).
 * `NotificationProducer` / `FeedAnnouncer` are injected mocks per the
 * handler's constructor DI.
 *
 * Covers: create/get/list/update/delete success paths, capability denial
 * (403), cross-tenant 404 isolation, GROUP_ONLY read denial + allow,
 * feature-flag-off (404), and the visibility -> announce/update/cancel
 * seam-call behavior (§4.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";
import type {
  EventAnnouncementInput,
  FeedAnnouncer,
  NotificationProducer,
} from "../../../src/lib/events/seams.js";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockDb,
  isEnabledMock,
  requireCapabilityMock,
  isMemberMock,
} = vi.hoisted(() => ({
  mockDb: {
    event: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    group: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    groupMember: {
      findMany: vi.fn(),
    },
  },
  isEnabledMock: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  requireCapabilityMock: vi.fn<() => Response | null>().mockReturnValue(null),
  isMemberMock: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
}));

vi.mock("../../../src/db.js", () => ({
  createPrisma: vi.fn(() => mockDb),
}));

vi.mock("../../../src/lib/feature-toggle-service.js", () => ({
  FeatureToggleService: class {
    isEnabled = isEnabledMock;
  },
}));

vi.mock("../../../src/lib/activitypub/group-service.js", () => ({
  GroupService: { isMember: isMemberMock },
}));

vi.mock("../../../src/lib/org-category/directory-profile-config.js", () => ({
  resolveDirectoryProfileConfig: () => ({ neighborhoodFuzzMeters: 500 }),
}));

vi.mock("../../../src/lib/auth/require.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/lib/auth/require.js")>()),
  requireCapability: requireCapabilityMock,
}));

// ── Import SUT (after mocks) ──────────────────────────────────────────────────

import { EventHandler } from "../../../src/lib/events/event-handler.js";
// The real `Capability` enum (the require.js mock spreads the actual module, so
// this is the genuine value the handler passes) — used to assert the SPECIFIC
// capability each mutation requests, so a capability swap can't pass (T-1).
import { Capability } from "../../../src/lib/auth/require.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_A = "tenant-a-id";
const TENANT_B = "tenant-b-id";
const USER_ID = "caller-user-id";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-caller",
    userId: USER_ID,
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_A,
    tenantSlug: "org-a",
    tenantRole: "MEMBER" as TenantRole,
    handle: "caller",
    membershipsLoader: async () => [],
    ...overrides,
  };
}

function buildEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    event: {
      maxPerTenant: 500,
      maxShiftsPerEvent: 50,
      maxGuestsPerRsvp: 10,
      rsvpRatePerHour: 60,
      updateRatePerHour: 20,
      updateNotifyCooldownSeconds: 3600,
      listPageMax: 50,
    },
  } as unknown as Env;
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    tenantId: TENANT_A,
    groupId: null,
    creatorId: USER_ID,
    title: "Community Picnic",
    description: "Bring snacks",
    status: "DRAFT",
    visibility: "TENANT_ONLY",
    startsAt: new Date("2026-08-01T12:00:00.000Z"),
    endsAt: null,
    timezone: "Europe/Berlin",
    locationName: "Central Park",
    lat: 40.785091,
    lng: -73.968285,
    displayLat: null,
    displayLng: null,
    locationPrecision: "CITY",
    capacity: null,
    rsvpCount: 0,
    waitlistCount: 0,
    announcePostId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("https://api.example.com/api/events", {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function makeSeams() {
  const feedAnnouncer: FeedAnnouncer = {
    announce: vi.fn<() => Promise<string | null>>().mockResolvedValue("post-1"),
    update: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    retract: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const notificationProducer: NotificationProducer = {
    notifyEventUpdated: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    notifyEventCancelled: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return { feedAnnouncer, notificationProducer };
}

describe("EventHandler", () => {
  let handler: EventHandler;
  let feedAnnouncer: FeedAnnouncer;
  let notificationProducer: NotificationProducer;
  const env = buildEnv();

  beforeEach(() => {
    vi.clearAllMocks();
    isEnabledMock.mockResolvedValue(true);
    requireCapabilityMock.mockReturnValue(null);
    isMemberMock.mockResolvedValue(false);
    mockDb.event.count.mockResolvedValue(0);
    mockDb.user.findUnique.mockResolvedValue({ actorUri: "https://example.com/ap/users/caller" });
    mockDb.groupMember.findMany.mockResolvedValue([]);
    const seams = makeSeams();
    feedAnnouncer = seams.feedAnnouncer;
    notificationProducer = seams.notificationProducer;
    handler = new EventHandler(notificationProducer, feedAnnouncer);
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── feature flag ────────────────────────────────────────────────────────

  describe("feature-flag-off", () => {
    it("returns 404 from handleCreate when events_enabled is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleCreate(
        jsonRequest("POST", { title: "X", startsAt: "2026-08-01T12:00:00.000Z" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(404);
      expect(mockDb.event.create).not.toHaveBeenCalled();
    });

    it("returns 404 from handleGet when events_enabled is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    });

    it("returns 404 from handleList when events_enabled is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(404);
      expect(mockDb.event.findMany).not.toHaveBeenCalled();
    });

    it("returns 404 from handleUpdate when events_enabled is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "New title" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(404);
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    });

    it("returns 404 from handleDelete when events_enabled is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleDelete("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
      expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── create ──────────────────────────────────────────────────────────────

  describe("handleCreate", () => {
    it("creates a DRAFT event and returns 201", async () => {
      const created = makeEventRow();
      mockDb.event.create.mockResolvedValue(created);

      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "Community Picnic",
          description: "Bring snacks",
          startsAt: "2026-08-01T12:00:00.000Z",
        }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("event-1");
      expect(body.status).toBe("DRAFT");
      // T-1: assert the SPECIFIC capability, not just the verdict.
      expect(requireCapabilityMock).toHaveBeenCalledWith(
        expect.anything(),
        Capability.EventCreate,
      );
      expect(mockDb.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_A,
            creatorId: USER_ID,
            title: "Community Picnic",
            visibility: "TENANT_ONLY",
          }),
        }),
      );
    });

    it("returns 403 when requireCapability denies", async () => {
      requireCapabilityMock.mockReturnValue(
        new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
      );
      const res = await handler.handleCreate(
        jsonRequest("POST", { title: "X", startsAt: "2026-08-01T12:00:00.000Z" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(403);
      expect(mockDb.event.create).not.toHaveBeenCalled();
    });

    it("returns 400 for GROUP_ONLY visibility with no groupId", async () => {
      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "X",
          startsAt: "2026-08-01T12:00:00.000Z",
          visibility: "GROUP_ONLY",
        }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when groupId does not resolve in tenant", async () => {
      mockDb.group.findFirst.mockResolvedValue(null);
      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "X",
          startsAt: "2026-08-01T12:00:00.000Z",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
        }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("GROUP_NOT_FOUND");
    });

    it("returns 409 when the tenant is at its event cap", async () => {
      mockDb.event.count.mockResolvedValue(500);
      const res = await handler.handleCreate(
        jsonRequest("POST", { title: "X", startsAt: "2026-08-01T12:00:00.000Z" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(409);
      expect(mockDb.event.create).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid body (validation failure)", async () => {
      const res = await handler.handleCreate(
        jsonRequest("POST", { title: "" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("computes a fuzzed displayLat/displayLng for NEIGHBORHOOD precision", async () => {
      mockDb.event.create.mockResolvedValue(makeEventRow({ locationPrecision: "NEIGHBORHOOD" }));
      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "X",
          startsAt: "2026-08-01T12:00:00.000Z",
          locationPrecision: "NEIGHBORHOOD",
          lat: 40.785091,
          lng: -73.968285,
        }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(201);
      const [{ data }] = mockDb.event.create.mock.calls[0];
      expect(data.displayLat).not.toBeNull();
      expect(data.displayLng).not.toBeNull();
      expect(typeof data.displayLat).toBe("number");
    });

    it("maps a P2002 database error to 409", async () => {
      mockDb.event.create.mockRejectedValue({ code: "P2002", message: "unique" });
      const res = await handler.handleCreate(
        jsonRequest("POST", { title: "X", startsAt: "2026-08-01T12:00:00.000Z" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(409);
    });

    it("creates a GROUP_ONLY event when the group resolves in the tenant", async () => {
      mockDb.group.findFirst.mockResolvedValue({ id: "group-1" });
      mockDb.event.create.mockResolvedValue(
        makeEventRow({ visibility: "GROUP_ONLY", groupId: "group-1" }),
      );
      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "X",
          startsAt: "2026-08-01T12:00:00.000Z",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
        }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(201);
      expect(mockDb.event.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ groupId: "group-1" }) }),
      );
    });

    it("stores an explicit endsAt as a Date", async () => {
      mockDb.event.create.mockResolvedValue(
        makeEventRow({ endsAt: new Date("2026-08-01T14:00:00.000Z") }),
      );
      const res = await handler.handleCreate(
        jsonRequest("POST", {
          title: "X",
          startsAt: "2026-08-01T12:00:00.000Z",
          endsAt: "2026-08-01T14:00:00.000Z",
        }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(201);
      expect(mockDb.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ endsAt: new Date("2026-08-01T14:00:00.000Z") }),
        }),
      );
    });

    it("falls back to latitude-only fuzz scaling near the poles (cosLat <= 1e-6)", async () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
      try {
        mockDb.event.create.mockResolvedValue(
          makeEventRow({ locationPrecision: "NEIGHBORHOOD", lat: 90, lng: 0 }),
        );
        const res = await handler.handleCreate(
          jsonRequest("POST", {
            title: "X",
            startsAt: "2026-08-01T12:00:00.000Z",
            locationPrecision: "NEIGHBORHOOD",
            lat: 90,
            lng: 0,
          }),
          makeAuth(),
          env,
        );
        expect(res.status).toBe(201);
        const [{ data }] = mockDb.event.create.mock.calls[0];
        expect(Number.isFinite(data.displayLat)).toBe(true);
        expect(Number.isFinite(data.displayLng)).toBe(true);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  // ── get (read-side visibility) ───────────────────────────────────────────

  describe("handleGet", () => {
    it("returns the event with precision-filtered location for the owning tenant", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ status: "PUBLISHED", visibility: "TENANT_ONLY" }),
      );
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.location).toEqual({ precision: "CITY", label: "Central Park", lat: null, lng: null });
    });

    it("returns 404 for cross-tenant TENANT_ONLY read (TENANT_SCOPE_MODE unset)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ tenantId: TENANT_B, status: "PUBLISHED", visibility: "TENANT_ONLY" }),
      );
      const res = await handler.handleGet(
        "event-1",
        makeAuth({ activeTenantId: TENANT_A }),
        env,
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when the event does not exist", async () => {
      mockDb.event.findFirst.mockResolvedValue(null);
      const res = await handler.handleGet("missing", makeAuth(), env);
      expect(res.status).toBe(404);
    });

    it("returns 200 for PUBLIC events regardless of tenant", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ tenantId: TENANT_B, status: "PUBLISHED", visibility: "PUBLIC" }),
      );
      const res = await handler.handleGet(
        "event-1",
        makeAuth({ activeTenantId: TENANT_A }),
        env,
      );
      expect(res.status).toBe(200);
    });

    it("denies GROUP_ONLY read for a non-member (404)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({
          status: "PUBLISHED",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
          creatorId: "someone-else",
        }),
      );
      isMemberMock.mockResolvedValue(false);
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
    });

    it("allows GROUP_ONLY read for a group member", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({
          status: "PUBLISHED",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
          creatorId: "someone-else",
        }),
      );
      isMemberMock.mockResolvedValue(true);
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(200);
    });

    it("allows a DRAFT read for its creator", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ status: "DRAFT", creatorId: USER_ID }));
      const res = await handler.handleGet("event-1", makeAuth({ userId: USER_ID }), env);
      expect(res.status).toBe(200);
    });

    it("denies a DRAFT read for a non-creator MEMBER", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ status: "DRAFT", creatorId: "someone-else" }),
      );
      const res = await handler.handleGet("event-1", makeAuth({ tenantRole: "MEMBER" }), env);
      expect(res.status).toBe(404);
    });

    it("allows a DRAFT read for an ADMIN (EventModerate holder)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ status: "DRAFT", creatorId: "someone-else" }),
      );
      const res = await handler.handleGet("event-1", makeAuth({ tenantRole: "ADMIN" }), env);
      expect(res.status).toBe(200);
    });

    it("denies GROUP_ONLY read when the caller has no actorUri (never calls GroupService)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({
          status: "PUBLISHED",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
          creatorId: "someone-else",
        }),
      );
      mockDb.user.findUnique.mockResolvedValue({ actorUri: null });
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
      expect(isMemberMock).not.toHaveBeenCalled();
    });

    it("returns 404 for an unrecognized visibility value (default branch)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ status: "PUBLISHED", visibility: "BOGUS" as any }),
      );
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
    });

    it("denies a DRAFT event found via the cross-tenant PUBLIC fallback (draft trumps visibility)", async () => {
      // Tenant-scoped lookup misses; the PUBLIC-visibility fallback finds a
      // DRAFT event that happens to be in a different tenant — DRAFT status
      // must still deny it regardless of `visibility: PUBLIC`.
      mockDb.event.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeEventRow({
            tenantId: TENANT_B,
            status: "DRAFT",
            visibility: "PUBLIC",
            creatorId: "someone-else",
          }),
        );
      const res = await handler.handleGet(
        "event-1",
        makeAuth({ activeTenantId: TENANT_A }),
        env,
      );
      expect(res.status).toBe(404);
    });

    it("denies GROUP_ONLY read when the event has no groupId (defensive, inconsistent data)", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({ status: "PUBLISHED", visibility: "GROUP_ONLY", groupId: null }),
      );
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
      expect(isMemberMock).not.toHaveBeenCalled();
    });

    it("allows GROUP_ONLY read for a SUPER_ADMIN without querying GroupService", async () => {
      mockDb.event.findFirst.mockResolvedValue(
        makeEventRow({
          status: "PUBLISHED",
          visibility: "GROUP_ONLY",
          groupId: "group-1",
          creatorId: "someone-else",
        }),
      );
      const res = await handler.handleGet(
        "event-1",
        makeAuth({ globalRole: "SUPER_ADMIN" as UserRole, tenantRole: "MEMBER" as TenantRole }),
        env,
      );
      expect(res.status).toBe(200);
      expect(isMemberMock).not.toHaveBeenCalled();
    });

    it("maps a P2025 database error to 404", async () => {
      mockDb.event.findFirst.mockRejectedValue({ code: "P2025", message: "not found" });
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(404);
    });

    it("maps an unexpected error to 500", async () => {
      mockDb.event.findFirst.mockRejectedValue(new Error("boom"));
      const res = await handler.handleGet("event-1", makeAuth(), env);
      expect(res.status).toBe(500);
    });
  });

  // ── list ────────────────────────────────────────────────────────────────

  describe("handleList", () => {
    it("returns items/cursor/hasMore, scoped to the active tenant", async () => {
      mockDb.event.findMany.mockResolvedValue([makeEventRow({ status: "PUBLISHED" })]);
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events?limit=20"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.hasMore).toBe(false);
      expect(mockDb.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT_A, deletedAt: null }),
        }),
      );
    });

    it("sets hasMore + cursor when a page overflows the limit", async () => {
      const rows = Array.from({ length: 3 }, (_, i) =>
        makeEventRow({ id: `event-${i}`, startsAt: new Date(`2026-08-0${i + 1}T00:00:00.000Z`) }),
      );
      mockDb.event.findMany.mockResolvedValue(rows);
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events?limit=2"),
        makeAuth(),
        env,
      );
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.hasMore).toBe(true);
      expect(typeof body.cursor).toBe("string");
    });

    it("returns 400 for an invalid query", async () => {
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events?limit=abc"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("decodes a valid keyset cursor and applies it to the query", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const cursor = Buffer.from(
        JSON.stringify({ startsAt: "2026-08-01T00:00:00.000Z", eventId: "event-0" }),
      ).toString("base64");
      const res = await handler.handleList(
        new Request(`https://api.example.com/api/events?cursor=${encodeURIComponent(cursor)}`),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      expect(where.AND[2].OR).toBeDefined();
    });

    it("ignores a malformed cursor (falls back to the first page)", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events?cursor=not-valid-base64-json"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
    });

    it("resolves member group ids to [] when the caller has no actorUri", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      mockDb.user.findUnique.mockResolvedValue({ actorUri: null });
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      expect(mockDb.groupMember.findMany).not.toHaveBeenCalled();
    });

    it("maps an unexpected database error to 500", async () => {
      mockDb.event.findMany.mockRejectedValue(new Error("boom"));
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(500);
    });

    it("applies status/groupId/upcoming query filters to the where clause", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const res = await handler.handleList(
        new Request(
          "https://api.example.com/api/events?status=PUBLISHED&groupId=group-9&upcoming=true",
        ),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      expect(where.status).toBe("PUBLISHED");
      expect(where.groupId).toBe("group-9");
      expect(where.startsAt).toEqual({ gte: new Date("2026-07-10T10:00:00.000Z") });
    });

    it("uses an empty draft filter for a moderator (ADMIN sees DRAFT events by others)", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const res = await handler.handleList(
        new Request("https://api.example.com/api/events"),
        makeAuth({ tenantRole: "ADMIN" as TenantRole }),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      // draftFilter is the second AND clause; a moderator's is {} (no
      // status/creator restriction), unlike a non-moderator's OR-guard.
      expect(where.AND[1]).toEqual({});
    });

    it("ignores a cursor whose startsAt does not parse to a valid date", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const cursor = Buffer.from(
        JSON.stringify({ startsAt: "not-a-real-date", eventId: "event-0" }),
      ).toString("base64");
      const res = await handler.handleList(
        new Request(`https://api.example.com/api/events?cursor=${encodeURIComponent(cursor)}`),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      // Invalid date inside an otherwise well-formed cursor → treated as no
      // cursor (first page), same as the malformed-cursor case.
      expect(where.AND[2]).toEqual({});
    });
  });

  // ── list mine (created OR rsvped, no visibility filter) ──────────────────

  describe("handleListMine", () => {
    it("returns the caller's created+rsvped events, scoped to the active tenant", async () => {
      mockDb.event.findMany.mockResolvedValue([makeEventRow({ status: "PUBLISHED" })]);
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine?limit=20"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.hasMore).toBe(false);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      expect(where.tenantId).toBe(TENANT_A);
      expect(where.deletedAt).toBeNull();
      // "Mine" = created by the caller OR the caller has an RSVP on it — and NO
      // visibility filter (every row is inherently visible to the caller).
      expect(where.OR).toEqual([
        { creatorId: USER_ID },
        { rsvps: { some: { userId: USER_ID } } },
      ]);
      expect(where.AND).toBeDefined();
    });

    it("returns an empty page when the caller owns/rsvped no events", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.hasMore).toBe(false);
      expect(body.cursor).toBeUndefined();
    });

    it("sets hasMore + a next cursor when a page overflows the limit", async () => {
      const rows = Array.from({ length: 3 }, (_, i) =>
        makeEventRow({ id: `event-${i}`, startsAt: new Date(`2026-08-0${i + 1}T00:00:00.000Z`) }),
      );
      mockDb.event.findMany.mockResolvedValue(rows);
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine?limit=2"),
        makeAuth(),
        env,
      );
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.hasMore).toBe(true);
      expect(typeof body.cursor).toBe("string");
      // take = limit + 1, so the overflow row is detected.
      expect(mockDb.event.findMany.mock.calls[0][0].take).toBe(3);
    });

    it("decodes a valid keyset cursor and applies it to the AND filter", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const cursor = Buffer.from(
        JSON.stringify({ startsAt: "2026-08-01T00:00:00.000Z", eventId: "event-0" }),
      ).toString("base64");
      const res = await handler.handleListMine(
        new Request(
          `https://api.example.com/api/events/mine?cursor=${encodeURIComponent(cursor)}`,
        ),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      expect(where.AND[0].OR).toEqual([
        { startsAt: { gt: new Date("2026-08-01T00:00:00.000Z") } },
        { startsAt: new Date("2026-08-01T00:00:00.000Z"), id: { gt: "event-0" } },
      ]);
    });

    it("returns 400 for an invalid query", async () => {
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine?limit=abc"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when the events feature is disabled", async () => {
      isEnabledMock.mockResolvedValue(false);
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(404);
      expect(mockDb.event.findMany).not.toHaveBeenCalled();
    });

    it("maps a thrown SyntaxError to a 400 'Invalid JSON body' response", async () => {
      // Exercises the SyntaxError arm of mapError (event-handler.ts:799).
      mockDb.event.findMany.mockRejectedValue(new SyntaxError("Unexpected token"));
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: "VALIDATION_ERROR", message: "Invalid JSON body" });
    });

    it("maps an unexpected database error to 500", async () => {
      mockDb.event.findMany.mockRejectedValue(new Error("boom"));
      const res = await handler.handleListMine(
        new Request("https://api.example.com/api/events/mine"),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(500);
    });

    it("applies status/groupId/upcoming query filters to the where clause", async () => {
      mockDb.event.findMany.mockResolvedValue([]);
      const res = await handler.handleListMine(
        new Request(
          "https://api.example.com/api/events/mine?status=PUBLISHED&groupId=group-9&upcoming=true",
        ),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(200);
      const { where } = mockDb.event.findMany.mock.calls[0][0];
      expect(where.status).toBe("PUBLISHED");
      expect(where.groupId).toBe("group-9");
      expect(where.startsAt).toEqual({ gte: new Date("2026-07-10T10:00:00.000Z") });
    });
  });

  // ── update ──────────────────────────────────────────────────────────────

  describe("handleUpdate", () => {
    it("returns 404 cross-tenant before touching capability/body", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ tenantId: TENANT_B }));
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "New title" }),
        makeAuth({ activeTenantId: TENANT_A }),
        env,
      );
      expect(res.status).toBe(404);
      expect(requireCapabilityMock).not.toHaveBeenCalled();
    });

    it("returns 403 when requireCapability denies (non-owner MEMBER)", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ creatorId: "someone-else" }));
      requireCapabilityMock.mockReturnValue(
        new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
      );
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "New title" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(403);
    });

    it("publishes DRAFT->PUBLISHED via the FeedAnnouncer and stores announcePostId", async () => {
      const existing = makeEventRow({ status: "DRAFT" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update
        .mockResolvedValueOnce({ ...existing, status: "PUBLISHED" })
        .mockResolvedValueOnce({ ...existing, status: "PUBLISHED", announcePostId: "post-1" });

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { status: "PUBLISHED" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      // T-1: update requests EventUpdate (own-only resource-scoped).
      expect(requireCapabilityMock).toHaveBeenCalledWith(
        expect.anything(),
        Capability.EventUpdate,
        expect.anything(),
      );
      expect(feedAnnouncer.announce).toHaveBeenCalledTimes(1);
      const [input] = (feedAnnouncer.announce as any).mock.calls[0] as [EventAnnouncementInput, Env];
      expect(input.eventId).toBe("event-1");
      expect(input.visibility).toBe("TENANT_ONLY");
      const body = await res.json();
      expect(body.announcePostId).toBe("post-1");
    });

    it("skips announcePostId update when announce() returns null (GROUP_ONLY)", async () => {
      const existing = makeEventRow({
        status: "DRAFT",
        visibility: "GROUP_ONLY",
        groupId: "group-1",
      });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValueOnce({ ...existing, status: "PUBLISHED" });
      (feedAnnouncer.announce as any).mockResolvedValue(null);

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { status: "PUBLISHED" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(mockDb.event.update).toHaveBeenCalledTimes(1);
    });

    it("calls FeedAnnouncer.update + notifyEventUpdated on material change to a PUBLISHED event", async () => {
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: "post-1" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      const updatedRow = {
        ...existing,
        startsAt: new Date("2026-08-02T12:00:00.000Z"),
      };
      mockDb.event.update.mockResolvedValue(updatedRow);

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { startsAt: "2026-08-02T12:00:00.000Z" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(feedAnnouncer.update).toHaveBeenCalledTimes(1);
      expect(notificationProducer.notifyEventUpdated).toHaveBeenCalledTimes(1);
      const [notifyInput] = (notificationProducer.notifyEventUpdated as any).mock.calls[0];
      expect(notifyInput.changedFields).toEqual(["startsAt"]);
    });

    it("does not call the seams when no material field changed", async () => {
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: "post-1" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue(existing);

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { description: "Updated description only" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(feedAnnouncer.update).not.toHaveBeenCalled();
      expect(notificationProducer.notifyEventUpdated).not.toHaveBeenCalled();
    });

    it("cancels via PATCH status=CANCELLED, retracting + notifying for a PUBLISHED event", async () => {
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: "post-1" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, status: "CANCELLED" });

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { status: "CANCELLED" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(feedAnnouncer.retract).toHaveBeenCalledTimes(1);
      expect(notificationProducer.notifyEventCancelled).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when editing an already-CANCELLED event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ status: "CANCELLED" }));
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "New title" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(409);
    });

    it("returns 400 when patching visibility to GROUP_ONLY without an existing groupId", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ status: "PUBLISHED", groupId: null }));
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { visibility: "GROUP_ONLY" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid patch body", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ status: "PUBLISHED" }));
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(400);
    });

    it("maps an unexpected database error to 500", async () => {
      mockDb.event.findFirst.mockRejectedValue(new Error("boom"));
      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { title: "New title" }),
        makeAuth(),
        env,
      );
      expect(res.status).toBe(500);
    });

    it("applies title/visibility/timezone/capacity/lat/lng/locationName/endsAt when provided", async () => {
      // existing.endsAt is null (makeEventRow default) — patching to a real
      // value exercises both the existing-null and next-truthy arms of the
      // endsAt change-detection ternaries.
      const existing = makeEventRow({ status: "PUBLISHED" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, title: "Renamed" });

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", {
          title: "Renamed",
          visibility: "PUBLIC",
          timezone: "America/New_York",
          capacity: 42,
          lat: 41.0,
          lng: -74.0,
          locationName: "New Spot",
          endsAt: "2026-08-01T15:00:00.000Z",
        }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(mockDb.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Renamed",
            visibility: "PUBLIC",
            timezone: "America/New_York",
            capacity: 42,
            lat: 41.0,
            lng: -74.0,
            locationName: "New Spot",
            endsAt: new Date("2026-08-01T15:00:00.000Z"),
          }),
        }),
      );
    });

    it("clears endsAt when the patch explicitly sets it to null", async () => {
      const existing = makeEventRow({
        status: "PUBLISHED",
        endsAt: new Date("2026-08-01T16:00:00.000Z"),
      });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, endsAt: null });

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { endsAt: null }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(mockDb.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ endsAt: null }) }),
      );
      const [notifyInput] = (notificationProducer.notifyEventUpdated as any).mock.calls[0];
      expect(notifyInput.changedFields).toEqual(["endsAt"]);
    });

    it("cancels a DRAFT event via PATCH status=CANCELLED without retract/notify", async () => {
      const existing = makeEventRow({ status: "DRAFT" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, status: "CANCELLED" });

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { status: "CANCELLED" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      // A DRAFT event was never announced, so cancelling it must not retract
      // a companion post or emit an EVENT_CANCELLED notification.
      expect(feedAnnouncer.retract).not.toHaveBeenCalled();
      expect(notificationProducer.notifyEventCancelled).not.toHaveBeenCalled();
    });

    it("skips FeedAnnouncer.update (but still notifies) when the event was never announced", async () => {
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: null });
      mockDb.event.findFirst.mockResolvedValue(existing);
      const updatedRow = { ...existing, startsAt: new Date("2026-08-02T12:00:00.000Z") };
      mockDb.event.update.mockResolvedValue(updatedRow);

      const res = await handler.handleUpdate(
        "event-1",
        jsonRequest("PATCH", { startsAt: "2026-08-02T12:00:00.000Z" }),
        makeAuth(),
        env,
      );

      expect(res.status).toBe(200);
      expect(feedAnnouncer.update).not.toHaveBeenCalled();
      expect(notificationProducer.notifyEventUpdated).toHaveBeenCalledTimes(1);
    });
  });

  // ── delete (soft cancel) ─────────────────────────────────────────────────

  describe("handleDelete", () => {
    it("cancels a PUBLISHED event and retracts + notifies", async () => {
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: "post-1" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, status: "CANCELLED" });

      const res = await handler.handleDelete("event-1", makeAuth(), env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("CANCELLED");
      // T-1: delete requests EventDelete (own-only resource-scoped).
      expect(requireCapabilityMock).toHaveBeenCalledWith(
        expect.anything(),
        Capability.EventDelete,
        expect.anything(),
      );
      expect(feedAnnouncer.retract).toHaveBeenCalledTimes(1);
      expect(notificationProducer.notifyEventCancelled).toHaveBeenCalledTimes(1);
    });

    it("cancels a DRAFT event without retract/notify (no companion post, no attendees)", async () => {
      const existing = makeEventRow({ status: "DRAFT" });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, status: "CANCELLED" });

      const res = await handler.handleDelete("event-1", makeAuth(), env);

      expect(res.status).toBe(200);
      expect(feedAnnouncer.retract).not.toHaveBeenCalled();
      expect(notificationProducer.notifyEventCancelled).not.toHaveBeenCalled();
    });

    it("cancels a PUBLISHED event that was never announced: notifies but does not retract", async () => {
      // A PUBLISHED event with announcePostId=null (the FeedAnnouncer declined
      // to create a companion post at publish time — see the GROUP_ONLY
      // "announce() returns null" case in handleUpdate) still gets the
      // EVENT_CANCELLED notification, but there is no companion post to
      // retract.
      const existing = makeEventRow({ status: "PUBLISHED", announcePostId: null });
      mockDb.event.findFirst.mockResolvedValue(existing);
      mockDb.event.update.mockResolvedValue({ ...existing, status: "CANCELLED" });

      const res = await handler.handleDelete("event-1", makeAuth(), env);

      expect(res.status).toBe(200);
      expect(feedAnnouncer.retract).not.toHaveBeenCalled();
      expect(notificationProducer.notifyEventCancelled).toHaveBeenCalledTimes(1);
    });

    it("is idempotent for an already-CANCELLED event", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ status: "CANCELLED" }));
      const res = await handler.handleDelete("event-1", makeAuth(), env);
      expect(res.status).toBe(200);
      expect(mockDb.event.update).not.toHaveBeenCalled();
    });

    it("returns 404 for a cross-tenant delete", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ tenantId: TENANT_B }));
      const res = await handler.handleDelete(
        "event-1",
        makeAuth({ activeTenantId: TENANT_A }),
        env,
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 when requireCapability denies (non-owner MEMBER)", async () => {
      mockDb.event.findFirst.mockResolvedValue(makeEventRow({ creatorId: "someone-else" }));
      requireCapabilityMock.mockReturnValue(
        new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
      );
      const res = await handler.handleDelete("event-1", makeAuth(), env);
      expect(res.status).toBe(403);
    });

    it("maps an unexpected database error to 500", async () => {
      mockDb.event.findFirst.mockRejectedValue(new Error("boom"));
      const res = await handler.handleDelete("event-1", makeAuth(), env);
      expect(res.status).toBe(500);
    });
  });
});
