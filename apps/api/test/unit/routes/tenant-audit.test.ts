/**
 * Unit Tests: Tenant Audit Routes
 *
 * GET /api/tenants/:id/audit
 * - pagination, type/date filtering
 * - JSON and CSV format
 * - cross-tenant isolation
 * - SUPER_ADMIN sees all
 * - 401 when unauthenticated
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { tenantAuditRoutes } from "../../../src/lib/routes/tenant-audit.js";
import { buildTwoTenantFixture } from "../../_helpers/multi-tenant-fixture.js";
import type { Env } from "../../../src/env.js";

// ── DB mock ────────────────────────────────────────────────────────────────────
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    auditEvent: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => mockDb,
}));

// ── Auth mock ──────────────────────────────────────────────────────────────────
const { mockAuthMiddleware } = vi.hoisted(() => ({
  mockAuthMiddleware: vi.fn(),
}));

vi.mock("../../../src/lib/auth/auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/auth/auth-middleware.js")>();
  return {
    ...actual,
    authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  };
});

// ── SecurityHeaders mock ───────────────────────────────────────────────────────
vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    addSecurityHeaders(response: Response) {
      return response;
    }
  },
}));

const mockEnv = { DATABASE_URL: "postgresql://test" } as unknown as Env;

function makeAuditEvent(overrides: Partial<{
  id: string;
  action: string;
  tenantId: string | null;
  actorId: string;
  ipAddress: string | null;
  metadata: unknown;
  timestamp: Date;
}> = {}) {
  return {
    id: "event-1",
    action: "tenant.created",
    tenantId: "tenant-a-id",
    actorId: "user-a-id",
    ipAddress: "1.2.3.0/24",
    metadata: { tenantId: "tenant-a-id", eventId: "uuid-1" },
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const route = tenantAuditRoutes[0]!;

function makeRequest(tenantId: string, params: Record<string, string> = {}): Request {
  const url = new URL(`https://api.example.com/api/tenants/${tenantId}/audit`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { method: "GET" });
}

function routeContext(tenantId: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.example.com/api/tenants/${tenantId}/audit`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return {
    pathname: `/api/tenants/${tenantId}/audit`,
    url,
    params: { id: tenantId },
  };
}

describe("GET /api/tenants/:id/audit", () => {
  const { authA, authB, tenantA, tenantB } = buildTwoTenantFixture();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.auditEvent.findMany.mockResolvedValue([makeAuditEvent()]);
  });

  // ── Authentication ───────────────────────────────────────────────────────────
  it("returns 401 when no auth token", async () => {
    mockAuthMiddleware.mockResolvedValue(null);
    const response = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    expect(response.status).toBe(401);
  });

  // ── Happy path JSON ──────────────────────────────────────────────────────────
  it("returns 200 with events array for authenticated tenant owner", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { events: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("passes tenantId as a filter to Prisma", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    const call = mockDb.auditEvent.findMany.mock.calls[0]?.[0];
    expect(call?.where?.tenantId).toBe(tenantA.id);
  });

  // ── Cross-tenant isolation ───────────────────────────────────────────────────
  it("returns 403 when auth-as-B requests tenant-A audit log", async () => {
    mockAuthMiddleware.mockResolvedValue(authB);
    const response = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    expect(response.status).toBe(403);
    expect(mockDb.auditEvent.findMany).not.toHaveBeenCalled();
  });

  it("returns 200 when auth-as-B requests tenant-B audit log", async () => {
    mockAuthMiddleware.mockResolvedValue(authB);
    mockDb.auditEvent.findMany.mockResolvedValue([
      makeAuditEvent({ tenantId: tenantB.id }),
    ]);
    const response = await route.handler(
      makeRequest(tenantB.id),
      mockEnv,
      routeContext(tenantB.id),
    );
    expect(response.status).toBe(200);
  });

  // ── Pagination ───────────────────────────────────────────────────────────────
  it("sets hasMore=true and nextCursor when more rows than limit", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const events = Array.from({ length: 3 }, (_, i) =>
      makeAuditEvent({ id: `e${i}`, timestamp: new Date(Date.now() - i * 1000) }),
    );
    mockDb.auditEvent.findMany.mockResolvedValue(events);

    const response = await route.handler(
      makeRequest(tenantA.id, { limit: "2" }),
      mockEnv,
      routeContext(tenantA.id, { limit: "2" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { events: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.events).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
  });

  it("accepts a valid cursor and passes AND filter to Prisma", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const cursorData = { createdAt: "2026-01-01T00:00:00.000Z", id: "event-99" };
    const cursor = Buffer.from(JSON.stringify(cursorData), "utf8").toString("base64");

    await route.handler(
      makeRequest(tenantA.id, { cursor }),
      mockEnv,
      routeContext(tenantA.id, { cursor }),
    );

    const call = mockDb.auditEvent.findMany.mock.calls[0]?.[0];
    expect(call?.where?.AND).toBeDefined();
  });

  it("returns 400 for an invalid cursor", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { cursor: "!!!invalid-base64!!!" }),
      mockEnv,
      routeContext(tenantA.id, { cursor: "!!!invalid-base64!!!" }),
    );
    expect(response.status).toBe(400);
  });

  // ── Type filter ──────────────────────────────────────────────────────────────
  it("passes type filter to Prisma query", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    await route.handler(
      makeRequest(tenantA.id, { type: "tenant.created" }),
      mockEnv,
      routeContext(tenantA.id, { type: "tenant.created" }),
    );
    const call = mockDb.auditEvent.findMany.mock.calls[0]?.[0];
    expect(call?.where?.action).toBe("tenant.created");
  });

  // ── Date filter ──────────────────────────────────────────────────────────────
  it("passes from/to date filters to Prisma query", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    await route.handler(
      makeRequest(tenantA.id, {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T23:59:59.999Z",
      }),
      mockEnv,
      routeContext(tenantA.id, {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T23:59:59.999Z",
      }),
    );
    const call = mockDb.auditEvent.findMany.mock.calls[0]?.[0];
    expect(call?.where?.timestamp?.gte).toBeInstanceOf(Date);
    expect(call?.where?.timestamp?.lte).toBeInstanceOf(Date);
  });

  it("returns 400 for invalid from date", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { from: "not-a-date" }),
      mockEnv,
      routeContext(tenantA.id, { from: "not-a-date" }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid to date", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { to: "bad" }),
      mockEnv,
      routeContext(tenantA.id, { to: "bad" }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid limit", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { limit: "0" }),
      mockEnv,
      routeContext(tenantA.id, { limit: "0" }),
    );
    expect(response.status).toBe(400);
  });

  // ── CSV format ───────────────────────────────────────────────────────────────
  it("returns CSV content-type for format=csv", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { format: "csv" }),
      mockEnv,
      routeContext(tenantA.id, { format: "csv" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
  });

  it("CSV response includes header row and data row", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { format: "csv" }),
      mockEnv,
      routeContext(tenantA.id, { format: "csv" }),
    );
    const text = await response.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toContain("eventId");
    expect(lines[0]).toContain("type");
    expect(lines[0]).toContain("tenantId");
    expect(lines).toHaveLength(2); // header + 1 data row
  });

  it("CSV content-disposition includes tenant ID as filename", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    const response = await route.handler(
      makeRequest(tenantA.id, { format: "csv" }),
      mockEnv,
      routeContext(tenantA.id, { format: "csv" }),
    );
    const disposition = response.headers.get("content-disposition");
    expect(disposition).toContain(tenantA.id);
  });

  // ── Metadata payload ─────────────────────────────────────────────────────────
  it("returns the structured metadata object as the JSON payload", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    mockDb.auditEvent.findMany.mockResolvedValue([
      makeAuditEvent({ metadata: { foo: "bar", n: 1 } }),
    ]);
    const response = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { events: Array<{ payload: unknown }> };
    expect(body.events[0]?.payload).toEqual({ foo: "bar", n: 1 });
  });

  it("returns null payload when metadata is null (JSON) and empty cell (CSV)", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    mockDb.auditEvent.findMany.mockResolvedValue([
      makeAuditEvent({ metadata: null }),
    ]);
    const jsonResp = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    const body = await jsonResp.json() as { events: Array<{ payload: unknown }> };
    expect(body.events[0]?.payload).toBeNull();

    mockDb.auditEvent.findMany.mockResolvedValue([
      makeAuditEvent({ metadata: null }),
    ]);
    const csvResp = await route.handler(
      makeRequest(tenantA.id, { format: "csv" }),
      mockEnv,
      routeContext(tenantA.id, { format: "csv" }),
    );
    expect(csvResp.status).toBe(200);
    expect(await csvResp.text()).toContain("eventId"); // header present
  });

  it("CSV payload cell is the stringified metadata; eventId is the audit-event id", async () => {
    mockAuthMiddleware.mockResolvedValue(authA);
    mockDb.auditEvent.findMany.mockResolvedValue([
      makeAuditEvent({ id: "ulid-123", metadata: { k: "v" } }),
    ]);
    const response = await route.handler(
      makeRequest(tenantA.id, { format: "csv" }),
      mockEnv,
      routeContext(tenantA.id, { format: "csv" }),
    );
    const text = await response.text();
    expect(text).toContain("ulid-123");
    expect(text).toContain('{""k"":""v""}'); // CSV-escaped JSON
  });

  // ── SUPER_ADMIN sees all ─────────────────────────────────────────────────────
  it("SUPER_ADMIN can read any tenant audit log", async () => {
    const superAdminAuth = {
      ...authA,
      globalRole: "SUPER_ADMIN" as const,
      activeTenantId: "some-other-tenant",
    };
    mockAuthMiddleware.mockResolvedValue(superAdminAuth);
    mockDb.auditEvent.findMany.mockResolvedValue([makeAuditEvent()]);

    const response = await route.handler(
      makeRequest(tenantA.id),
      mockEnv,
      routeContext(tenantA.id),
    );
    expect(response.status).toBe(200);
  });
});
