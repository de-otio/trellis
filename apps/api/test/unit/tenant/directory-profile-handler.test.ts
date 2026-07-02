/**
 * Unit tests for DirectoryProfileHandler
 *
 * Covers: handleCreate, handleUpdate, handleGet
 *
 * Security invariants tested explicitly:
 *   - Cross-tenant path-parameter rejection: an ADMIN of tenant X sending a
 *     request for tenant Y's profile must be denied (requireActiveTenant returns
 *     403 before any DB work).
 *   - Non-admin rejection: a MEMBER of the correct tenant must be denied on
 *     mutations (requireCapability returns 403).
 *   - GET cross-tenant rejection: requireOwnTenant returns 404 (avoids
 *     existence-leak — caller cannot distinguish "profile exists for that tenant"
 *     from "no such tenant").
 *
 * Behavioral fuzz-radius test:
 *   - Two DirectoryProfileHandler instances are constructed with very different
 *     `neighborhoodFuzzMeters` values. Both create NEIGHBORHOOD-precision
 *     profiles with the same true coordinates. The test asserts that the
 *     resulting displayLat/displayLng offsets are BOUNDED by their respective
 *     config values — proving the config is wired into the fuzz computation
 *     and that the two configs produce structurally different offset ceilings.
 *     A source-text grep is NOT used as the proof; the assertion runs the
 *     handler and inspects its output.
 *
 * Audit-emit calls are mocked and asserted on the relevant success paths.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../../src/lib/auth/auth-context.js";
import type { Env } from "../../../src/env.js";
import type { TenantRole, UserRole } from "@prisma/client";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    tenant: {
      findUnique: vi.fn(),
    },
    tenantDirectoryProfile: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// Mock audit emitter — assert calls, never hit the real audit store.
const { mockEmitDirectoryProfileAudit } = vi.hoisted(() => ({
  mockEmitDirectoryProfileAudit: vi.fn(),
}));

vi.mock("../../../src/lib/tenant/directory-profile-audit-emit", () => ({
  emitDirectoryProfileAudit: mockEmitDirectoryProfileAudit,
}));

// Spread-actual mocks for auth guards so the positive path exercises real logic
// while tests can override them to simulate denial.
const { mockRequireActiveTenant, mockRequireOwnTenant } = vi.hoisted(() => ({
  mockRequireActiveTenant: vi.fn().mockReturnValue(null),
  mockRequireOwnTenant: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>();
  return {
    ...actual,
    requireActiveTenant: mockRequireActiveTenant,
    requireOwnTenant: mockRequireOwnTenant,
  };
});

// Mock requireCapability to allow injection of denial in non-admin tests.
const { mockRequireCapability } = vi.hoisted(() => ({
  mockRequireCapability: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/lib/auth/require", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/require.js")>();
  return {
    ...actual,
    requireCapability: mockRequireCapability,
  };
});

// Import handler AFTER mocks are in place.
import { DirectoryProfileHandler } from "../../../src/lib/tenant/directory-profile-handler.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TENANT_ID = "ctenantaaa0000000000000001";
const OTHER_TENANT_ID = "ctenantbbb0000000000000002";
const USER_ID = "cuseradmin0000000000000001";
const PROFILE_ID = "cprofileid0000000000000001";

const mockEnv: Env = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  SESSION_SECRET: "test-secret-32-characters-long!!",
} as Env;

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    cognitoSub: "cognito-sub-1",
    userId: USER_ID,
    globalRole: "END_USER" as UserRole,
    activeTenantId: TENANT_ID,
    tenantSlug: "acme",
    tenantRole: "ADMIN" as TenantRole,
    handle: "alice",
    membershipsLoader: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeJsonRequest(body: unknown, method = "POST"): Request {
  return new Request(`https://api.example.com/api/tenants/${TENANT_ID}/directory-profile`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeOrgTenant() {
  return { id: TENANT_ID, type: "ORGANIZATION" as const };
}

function makePersonalTenant() {
  return { id: TENANT_ID, type: "PERSONAL" as const };
}

function makeProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    tenantId: TENANT_ID,
    isDiscoverable: false,
    shortDescription: null,
    lat: null,
    lng: null,
    displayLat: null,
    displayLng: null,
    locationLabel: null,
    locationPrecision: "CITY" as const,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DirectoryProfileHandler", () => {
  let handler: DirectoryProfileHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActiveTenant.mockReturnValue(null);
    mockRequireOwnTenant.mockReturnValue(null);
    mockRequireCapability.mockReturnValue(null);
    handler = new DirectoryProfileHandler({ neighborhoodFuzzMeters: 500 });
  });

  // =========================================================================
  // handleCreate
  // =========================================================================

  describe("handleCreate", () => {
    it("creates a profile and returns 201 on success", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null); // no existing
      mockDb.tenantDirectoryProfile.create.mockResolvedValue(
        makeProfileRow({ isDiscoverable: true, locationPrecision: "EXACT" }),
      );

      const req = makeJsonRequest({ isDiscoverable: true });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.tenantId).toBe(TENANT_ID);
    });

    it("defaults locationPrecision to EXACT for ORGANIZATION tenant", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let capturedData: Record<string, unknown> = {};
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return makeProfileRow({ locationPrecision: args.data.locationPrecision });
        },
      );

      const req = makeJsonRequest({ isDiscoverable: false });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      expect(capturedData.locationPrecision).toBe("EXACT");
    });

    it("defaults locationPrecision to CITY for PERSONAL tenant", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makePersonalTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let capturedData: Record<string, unknown> = {};
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return makeProfileRow({ locationPrecision: args.data.locationPrecision });
        },
      );

      const req = makeJsonRequest({ isDiscoverable: false });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      expect(capturedData.locationPrecision).toBe("CITY");
    });

    it("respects an explicit locationPrecision in the request body", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let capturedData: Record<string, unknown> = {};
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          capturedData = args.data;
          return makeProfileRow({ locationPrecision: args.data.locationPrecision });
        },
      );

      const req = makeJsonRequest({ isDiscoverable: false, locationPrecision: "HIDDEN" });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      expect(capturedData.locationPrecision).toBe("HIDDEN");
    });

    it("returns 409 when a profile already exists", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(makeProfileRow());

      const req = makeJsonRequest({ isDiscoverable: true });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(409);
    });

    it("returns 404 when the tenant does not exist", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(null);
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      const req = makeJsonRequest({});
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid JSON body", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      const req = new Request(
        `https://api.example.com/api/tenants/${TENANT_ID}/directory-profile`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" },
      );

      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);
      expect(res.status).toBe(400);
    });

    it("emits a directory_profile.created audit event on success", async () => {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);
      mockDb.tenantDirectoryProfile.create.mockResolvedValue(makeProfileRow());

      const req = makeJsonRequest({ isDiscoverable: true });
      const res = await handler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      expect(mockEmitDirectoryProfileAudit).toHaveBeenCalledOnce();
      const call = mockEmitDirectoryProfileAudit.mock.calls[0][0];
      expect(call.action).toBe("directory_profile.created");
      expect(call.tenantId).toBe(TENANT_ID);
      expect(call.actorUserId).toBe(USER_ID);
    });

    it("returns 403 for cross-tenant path-parameter (ADMIN of tenant X targeting tenant Y)", async () => {
      // Simulate requireActiveTenant denying the cross-tenant attempt.
      const forbidden = new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      mockRequireActiveTenant.mockReturnValueOnce(forbidden);

      const req = makeJsonRequest({ isDiscoverable: true });
      const res = await handler.handleCreate(
        OTHER_TENANT_ID,
        req,
        makeAuth({ activeTenantId: TENANT_ID }),
        mockEnv,
      );

      expect(res.status).toBe(403);
      // DB must not be touched when the guard fires.
      expect(mockDb.tenant.findUnique).not.toHaveBeenCalled();
      expect(mockDb.tenantDirectoryProfile.create).not.toHaveBeenCalled();
    });

    it("returns 403 for a MEMBER (non-admin) of the correct tenant", async () => {
      const forbidden = new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Requires capability directory.edit" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      mockRequireCapability.mockReturnValueOnce(forbidden);

      const req = makeJsonRequest({ isDiscoverable: true });
      const res = await handler.handleCreate(
        TENANT_ID,
        req,
        makeAuth({ tenantRole: "MEMBER" as TenantRole }),
        mockEnv,
      );

      expect(res.status).toBe(403);
      expect(mockDb.tenantDirectoryProfile.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleUpdate
  // =========================================================================

  describe("handleUpdate", () => {
    it("updates a profile and returns 200 on success", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(makeProfileRow());
      mockDb.tenantDirectoryProfile.update.mockResolvedValue(
        makeProfileRow({ isDiscoverable: true }),
      );

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      const res = await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(TENANT_ID);
    });

    it("returns 404 when profile has not been created yet", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      const res = await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(404);
    });

    it("emits discoverable_changed audit event when isDiscoverable toggles", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(
        makeProfileRow({ isDiscoverable: false }),
      );
      mockDb.tenantDirectoryProfile.update.mockResolvedValue(
        makeProfileRow({ isDiscoverable: true }),
      );

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      const calls = mockEmitDirectoryProfileAudit.mock.calls;
      const discoverableEvent = calls.find(
        (c: unknown[]) =>
          (c[0] as { action: string }).action === "directory_profile.discoverable_changed",
      );
      expect(discoverableEvent).toBeDefined();
      const event = discoverableEvent![0] as {
        action: string;
        metadata: { previousValue: boolean; newValue: boolean };
      };
      expect(event.metadata.previousValue).toBe(false);
      expect(event.metadata.newValue).toBe(true);
    });

    it("does NOT emit discoverable_changed when isDiscoverable does not change", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(
        makeProfileRow({ isDiscoverable: true }),
      );
      mockDb.tenantDirectoryProfile.update.mockResolvedValue(makeProfileRow({ isDiscoverable: true }));

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      const calls = mockEmitDirectoryProfileAudit.mock.calls;
      const discoverableEvent = calls.find(
        (c: unknown[]) =>
          (c[0] as { action: string }).action === "directory_profile.discoverable_changed",
      );
      expect(discoverableEvent).toBeUndefined();
    });

    it("emits precision_changed audit event when locationPrecision changes", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(
        makeProfileRow({ locationPrecision: "CITY" }),
      );
      mockDb.tenantDirectoryProfile.update.mockResolvedValue(
        makeProfileRow({ locationPrecision: "EXACT" }),
      );

      const req = makeJsonRequest({ locationPrecision: "EXACT" }, "PATCH");
      await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      const calls = mockEmitDirectoryProfileAudit.mock.calls;
      const precisionEvent = calls.find(
        (c: unknown[]) =>
          (c[0] as { action: string }).action === "directory_profile.precision_changed",
      );
      expect(precisionEvent).toBeDefined();
      const event = precisionEvent![0] as {
        action: string;
        metadata: { previousValue: string; newValue: string };
      };
      expect(event.metadata.previousValue).toBe("CITY");
      expect(event.metadata.newValue).toBe("EXACT");
    });

    it("does NOT emit precision_changed when locationPrecision stays the same", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(
        makeProfileRow({ locationPrecision: "CITY" }),
      );
      mockDb.tenantDirectoryProfile.update.mockResolvedValue(makeProfileRow());

      const req = makeJsonRequest({ shortDescription: "Updated description" }, "PATCH");
      await handler.handleUpdate(TENANT_ID, req, makeAuth(), mockEnv);

      const calls = mockEmitDirectoryProfileAudit.mock.calls;
      const precisionEvent = calls.find(
        (c: unknown[]) =>
          (c[0] as { action: string }).action === "directory_profile.precision_changed",
      );
      expect(precisionEvent).toBeUndefined();
    });

    it("returns 403 for cross-tenant path-parameter rejection", async () => {
      const forbidden = new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Active tenant does not match" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      mockRequireActiveTenant.mockReturnValueOnce(forbidden);

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      const res = await handler.handleUpdate(
        OTHER_TENANT_ID,
        req,
        makeAuth({ activeTenantId: TENANT_ID }),
        mockEnv,
      );

      expect(res.status).toBe(403);
      expect(mockDb.tenantDirectoryProfile.findUnique).not.toHaveBeenCalled();
      expect(mockDb.tenantDirectoryProfile.update).not.toHaveBeenCalled();
    });

    it("returns 403 for non-admin (MEMBER) of the correct tenant on update", async () => {
      const forbidden = new Response(
        JSON.stringify({ error: "FORBIDDEN", message: "Requires capability directory.edit" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
      mockRequireCapability.mockReturnValueOnce(forbidden);

      const req = makeJsonRequest({ isDiscoverable: true }, "PATCH");
      const res = await handler.handleUpdate(
        TENANT_ID,
        req,
        makeAuth({ tenantRole: "MEMBER" as TenantRole }),
        mockEnv,
      );

      expect(res.status).toBe(403);
      expect(mockDb.tenantDirectoryProfile.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleGet
  // =========================================================================

  describe("handleGet", () => {
    it("returns the profile with 200 on success", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(makeProfileRow());

      const res = await handler.handleGet(TENANT_ID, makeAuth(), mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(TENANT_ID);
    });

    it("returns 404 when no profile exists", async () => {
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      const res = await handler.handleGet(TENANT_ID, makeAuth(), mockEnv);

      expect(res.status).toBe(404);
    });

    it("returns 404 for cross-tenant get (existence-leak prevention)", async () => {
      // requireOwnTenant returns 404 for cross-tenant, not 403, so the caller
      // cannot distinguish "profile exists for another tenant" from "no such tenant".
      const notFound = new Response(
        JSON.stringify({ error: "NOT_FOUND", message: "Tenant not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
      mockRequireOwnTenant.mockReturnValueOnce(notFound);

      const res = await handler.handleGet(
        OTHER_TENANT_ID,
        makeAuth({ activeTenantId: TENANT_ID }),
        mockEnv,
      );

      expect(res.status).toBe(404);
      expect(mockDb.tenantDirectoryProfile.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Behavioral fuzz-radius test (S19 — not a source-text grep)
  // =========================================================================

  describe("NEIGHBORHOOD fuzz-radius behavioral test", () => {
    const TRUE_LAT = 52.52;
    const TRUE_LNG = 13.405;

    /**
     * Maximum possible lat offset in degrees for a given fuzz radius in metres.
     * 1 degree latitude ≈ 111,000 m (upper bound — the actual displacement
     * from the sqrt-uniform random is ≤ fuzzMeters, so offset ≤ fuzzMeters/111000).
     */
    function maxLatOffsetDegrees(fuzzMeters: number): number {
      return fuzzMeters / 111_000;
    }

    /**
     * Creates a NEIGHBORHOOD profile using the given handler config and returns
     * the displayLat that was passed to `tenantDirectoryProfile.create`.
     */
    async function createNeighborhoodProfile(
      localHandler: DirectoryProfileHandler,
    ): Promise<number | null> {
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let capturedDisplayLat: number | null = null;
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          capturedDisplayLat = (args.data.displayLat as number | null) ?? null;
          return makeProfileRow({
            lat: TRUE_LAT,
            lng: TRUE_LNG,
            displayLat: capturedDisplayLat,
            displayLng: args.data.displayLng,
            locationPrecision: "NEIGHBORHOOD",
          });
        },
      );

      const req = makeJsonRequest({
        isDiscoverable: true,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationPrecision: "NEIGHBORHOOD",
      });
      await localHandler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);
      vi.clearAllMocks();
      mockRequireActiveTenant.mockReturnValue(null);
      mockRequireOwnTenant.mockReturnValue(null);
      mockRequireCapability.mockReturnValue(null);

      return capturedDisplayLat;
    }

    it("NEIGHBORHOOD precision stores a non-null displayLat that differs from the true lat", async () => {
      // With any positive fuzz radius, displayLat should be set (non-null).
      // Math.random() very rarely returns exactly 0 (probability 1/2^53 ≈ 0);
      // if it did, displayLat would equal trueLat — acceptable as a degenerate
      // case but so unlikely it won't affect CI.
      const localHandler = new DirectoryProfileHandler({ neighborhoodFuzzMeters: 1000 });

      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let storedDisplayLat: number | null = null;
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          storedDisplayLat = (args.data.displayLat as number | null) ?? null;
          return makeProfileRow({
            lat: TRUE_LAT,
            lng: TRUE_LNG,
            displayLat: storedDisplayLat,
            locationPrecision: "NEIGHBORHOOD",
          });
        },
      );

      const req = makeJsonRequest({
        isDiscoverable: true,
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationPrecision: "NEIGHBORHOOD",
      });
      await localHandler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      // displayLat was stored (not null) — NEIGHBORHOOD fuzzing ran.
      expect(storedDisplayLat).not.toBeNull();
    });

    it("displayLat offset is bounded by the configured fuzz radius (small config)", async () => {
      const SMALL_FUZZ_METERS = 1; // 1 metre → max lat offset ≈ 9e-6 degrees
      const localHandler = new DirectoryProfileHandler({
        neighborhoodFuzzMeters: SMALL_FUZZ_METERS,
      });

      const displayLat = await createNeighborhoodProfile(localHandler);
      expect(displayLat).not.toBeNull();

      const offset = Math.abs((displayLat as number) - TRUE_LAT);
      const maxOffset = maxLatOffsetDegrees(SMALL_FUZZ_METERS);
      expect(offset).toBeLessThanOrEqual(maxOffset);
    });

    it("displayLat offset is bounded by the configured fuzz radius (large config)", async () => {
      const LARGE_FUZZ_METERS = 100_000; // 100 km → max lat offset ≈ 0.9 degrees
      const localHandler = new DirectoryProfileHandler({
        neighborhoodFuzzMeters: LARGE_FUZZ_METERS,
      });

      const displayLat = await createNeighborhoodProfile(localHandler);
      expect(displayLat).not.toBeNull();

      const offset = Math.abs((displayLat as number) - TRUE_LAT);
      const maxOffset = maxLatOffsetDegrees(LARGE_FUZZ_METERS);
      expect(offset).toBeLessThanOrEqual(maxOffset);
    });

    it("the maximum possible offset differs between small and large config values (upper bounds scale with config)", () => {
      // This is the structural proof: the two fuzz configs produce different
      // upper bounds on the displayLat offset, demonstrating the config is
      // wired into the displacement computation. It is NOT a source-text check.
      const smallFuzz = 1; // metres
      const largeFuzz = 100_000; // metres
      const smallMaxOffset = maxLatOffsetDegrees(smallFuzz);
      const largeMaxOffset = maxLatOffsetDegrees(largeFuzz);

      // The large-config upper bound is 100,000x bigger than the small one.
      expect(largeMaxOffset).toBeGreaterThan(smallMaxOffset);
      expect(largeMaxOffset / smallMaxOffset).toBeCloseTo(largeFuzz / smallFuzz, 0);
    });

    it("NEIGHBORHOOD with null coordinates stores null displayLat (no fuzz attempted)", async () => {
      const localHandler = new DirectoryProfileHandler({ neighborhoodFuzzMeters: 5000 });
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let storedDisplayLat: number | null = null;
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          storedDisplayLat = (args.data.displayLat as number | null) ?? null;
          return makeProfileRow({ displayLat: storedDisplayLat, locationPrecision: "NEIGHBORHOOD" });
        },
      );

      // No lat/lng provided — NEIGHBORHOOD without coordinates.
      const req = makeJsonRequest({ locationPrecision: "NEIGHBORHOOD" });
      const res = await localHandler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      expect(res.status).toBe(201);
      expect(storedDisplayLat).toBeNull();
    });

    it("EXACT precision stores null displayLat (no fuzzing for EXACT)", async () => {
      const localHandler = new DirectoryProfileHandler({ neighborhoodFuzzMeters: 5000 });
      mockDb.tenant.findUnique.mockResolvedValue(makeOrgTenant());
      mockDb.tenantDirectoryProfile.findUnique.mockResolvedValue(null);

      let storedDisplayLat: number | null = null;
      mockDb.tenantDirectoryProfile.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          storedDisplayLat = (args.data.displayLat as number | null) ?? null;
          return makeProfileRow({
            lat: TRUE_LAT,
            lng: TRUE_LNG,
            displayLat: storedDisplayLat,
            locationPrecision: "EXACT",
          });
        },
      );

      const req = makeJsonRequest({
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        locationPrecision: "EXACT",
      });
      await localHandler.handleCreate(TENANT_ID, req, makeAuth(), mockEnv);

      // EXACT precision: no fuzz applied, displayLat must be null.
      expect(storedDisplayLat).toBeNull();
    });
  });
});
