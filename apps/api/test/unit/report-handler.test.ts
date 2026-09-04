/**
 * Unit Tests: ReportHandler (compliance plan 08 §2.2, §5).
 *
 * Covers category routing (operator alert only for ILLEGAL_*; unknown/inactive
 * category => 400), dedup (one open report per reporter+resource+category),
 * the Art. 16(4) receipt on create, back-compat of the legacy resource types,
 * and the /mine listing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  ReportHandler,
  REPORT_RESOURCE_TYPES,
} from "../../src/lib/report-handler.js";

const mockDb = {
  reportCategory: { findUnique: vi.fn(), findMany: vi.fn() },
  report: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
};

vi.mock("../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

const mockSendReceipt = vi.fn();
vi.mock("../../src/lib/report-notifications.js", () => ({
  sendReportReceipt: (...args: unknown[]) => mockSendReceipt(...args),
}));

const mockOperatorHook = vi.fn();
vi.mock("../../src/lib/report-operator-alert.js", () => ({
  getOperatorAlertHook: () => mockOperatorHook,
  routingClassAlertsOperator: (rc: string) =>
    rc === "ILLEGAL_PRIORITY" || rc === "ILLEGAL",
}));

const mockCarveOut = vi.fn(async () => ({ applied: true }));
vi.mock("../../src/lib/compliance/report-carveout.js", () => ({
  applyIllegalPriorityCarveOut: (...args: unknown[]) => mockCarveOut(...args),
  isCarveOutResourceType: (t: string) =>
    ["post", "comment", "media", "entity"].includes(t),
}));

const mockEnv = {
  DEFAULT_REGION: "EU",
  SESSION_SECRET: "test-secret-32-characters-long!!!",
} as unknown as Env;

const requestContext = { region: "EU" } as any;
const session = {
  userId: "user123",
  email: "reporter@example.com",
  activeTenantId: "tenant123",
} as any;

function createReq(body: unknown): Request {
  return new Request("https://api.example.com/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ReportHandler.handleCreate — category routing", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportHandler();
    mockDb.report.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue({
      email: "reporter@example.com",
      personalTenantId: "tenant123",
    });
    mockDb.report.create.mockResolvedValue({
      id: "rep1",
      status: "pending",
      createdAt: new Date("2026-07-17T00:00:00Z"),
    });
  });

  it("FEEDBACK report is created but does NOT alert the operator", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "moderation-appeal",
      active: true,
      routingClass: "FEEDBACK",
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "moderation-appeal",
        resourceType: "post",
        resourceId: "post1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(201);
    expect(mockDb.report.create).toHaveBeenCalledOnce();
    expect(mockSendReceipt).toHaveBeenCalledOnce();
    expect(mockOperatorHook).not.toHaveBeenCalled();
  });

  it("POLICY_VIOLATION report does NOT alert the operator", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "policy-violation",
      active: true,
      routingClass: "POLICY_VIOLATION",
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "policy-violation",
        resourceType: "comment",
        resourceId: "c1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(201);
    expect(mockOperatorHook).not.toHaveBeenCalled();
  });

  it("ILLEGAL_PRIORITY report alerts the operator (M1 clock)", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "illegal-priority",
      active: true,
      routingClass: "ILLEGAL_PRIORITY",
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "illegal-priority",
        resourceType: "media",
        resourceId: "m1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(201);
    expect(mockOperatorHook).toHaveBeenCalledOnce();
    const [alert] = mockOperatorHook.mock.calls[0];
    expect(alert.routingClass).toBe("ILLEGAL_PRIORITY");
    expect(alert.reportId).toBe("rep1");
  });

  it("ILLEGAL report also alerts the operator", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "illegal-content",
      active: true,
      routingClass: "ILLEGAL",
    });

    await handler.handleCreate(
      createReq({
        categoryKey: "illegal-content",
        resourceType: "entity",
        resourceId: "e1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(mockOperatorHook).toHaveBeenCalledOnce();
  });

  it("unknown categoryKey => 400 INVALID_CATEGORY, nothing created", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue(null);

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "does-not-exist",
        resourceType: "post",
        resourceId: "p1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CATEGORY");
    expect(mockDb.report.create).not.toHaveBeenCalled();
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });

  it("inactive categoryKey => 400 INVALID_CATEGORY", async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "retired",
      active: false,
      routingClass: "POLICY_VIOLATION",
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "retired",
        resourceType: "post",
        resourceId: "p1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_CATEGORY");
  });

  it("invalid resourceType => 400 VALIDATION_ERROR", async () => {
    const res = await handler.handleCreate(
      createReq({
        categoryKey: "policy-violation",
        resourceType: "spaceship",
        resourceId: "p1",
      }),
      session,
      mockEnv,
      requestContext,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
    expect(mockDb.reportCategory.findUnique).not.toHaveBeenCalled();
  });
});

describe("ReportHandler.handleCreate — dedup", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportHandler();
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "policy-violation",
      active: true,
      routingClass: "POLICY_VIOLATION",
    });
  });

  it("an existing OPEN report for the same key => 200 deduplicated, no new create", async () => {
    mockDb.report.findFirst.mockResolvedValue({
      id: "existing1",
      status: "pending",
      createdAt: new Date("2026-07-16T00:00:00Z"),
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "policy-violation",
        resourceType: "post",
        resourceId: "post1",
      }),
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
    expect(body.report.id).toBe("existing1");
    expect(mockDb.report.create).not.toHaveBeenCalled();
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });

  it("N identical creates collapse to one open report (dedup after the first)", async () => {
    // First call: no existing report -> creates one.
    mockDb.report.findFirst.mockResolvedValueOnce(null);
    mockDb.user.findUnique.mockResolvedValue({
      email: "reporter@example.com",
      personalTenantId: "tenant123",
    });
    mockDb.report.create.mockResolvedValue({
      id: "rep1",
      status: "pending",
      createdAt: new Date("2026-07-17T00:00:00Z"),
    });
    const first = await handler.handleCreate(
      createReq({
        categoryKey: "policy-violation",
        resourceType: "post",
        resourceId: "post1",
      }),
      session,
      mockEnv,
      requestContext,
    );
    expect(first.status).toBe(201);

    // Subsequent calls: findFirst returns the open report -> deduped.
    mockDb.report.findFirst.mockResolvedValue({
      id: "rep1",
      status: "pending",
      createdAt: new Date("2026-07-17T00:00:00Z"),
    });
    for (let i = 0; i < 3; i++) {
      const res = await handler.handleCreate(
        createReq({
          categoryKey: "policy-violation",
          resourceType: "post",
          resourceId: "post1",
        }),
        session,
        mockEnv,
        requestContext,
      );
      expect(res.status).toBe(200);
    }

    expect(mockDb.report.create).toHaveBeenCalledOnce();
  });
});

describe("ReportHandler — back-compat + listing", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportHandler();
  });

  it("keeps the legacy resource types (url, user) in the validated set", () => {
    expect(REPORT_RESOURCE_TYPES).toContain("url");
    expect(REPORT_RESOURCE_TYPES).toContain("user");
    // and the new CONTENT targets are additive
    for (const t of ["post", "comment", "media", "entity"]) {
      expect(REPORT_RESOURCE_TYPES).toContain(t);
    }
  });

  it('accepts a legacy "user" resourceType (ACCOUNT-style target)', async () => {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "policy-violation",
      active: true,
      routingClass: "POLICY_VIOLATION",
    });
    mockDb.report.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue({
      email: "reporter@example.com",
      personalTenantId: "tenant123",
    });
    mockDb.report.create.mockResolvedValue({
      id: "rep9",
      status: "pending",
      createdAt: new Date("2026-07-17T00:00:00Z"),
    });

    const res = await handler.handleCreate(
      createReq({
        categoryKey: "policy-violation",
        resourceType: "user",
        resourceId: "reported-user-id",
      }),
      session,
      mockEnv,
      requestContext,
    );
    expect(res.status).toBe(201);
    expect(mockDb.report.create).toHaveBeenCalledOnce();
    // reportType is CONTENT (structural), not a semantic override of LINK/ACCOUNT
    expect(mockDb.report.create.mock.calls[0][0].data.reportType).toBe("CONTENT");
  });

  it("handleListMine returns the reporter's own reports, newest first", async () => {
    mockDb.report.findMany.mockResolvedValue([
      {
        id: "r2",
        reportType: "CONTENT",
        resourceType: "post",
        resourceId: "p2",
        categoryKey: "policy-violation",
        status: "pending",
        resolution: null,
        reason: null,
        createdAt: new Date("2026-07-17T00:00:00Z"),
      },
    ]);

    const res = await handler.handleListMine(
      session,
      mockEnv,
      requestContext,
      new URL("https://api.example.com/api/reports/mine?limit=10"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].id).toBe("r2");
    // scoped to the reporter
    expect(mockDb.report.findMany.mock.calls[0][0].where.reporterUserId).toBe(
      "user123",
    );
  });
});

/**
 * The CSAM-class carve-out has to fire on INTAKE, because there is no standing
 * moderator to fire it later. These pin the ROUTING decision (which class does
 * and does not trigger it) at the handler; report-carveout.test.ts pins what it
 * then does.
 */
describe("ReportHandler.handleCreate — ILLEGAL_PRIORITY carve-out routing", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportHandler();
    mockDb.report.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue({
      email: "reporter@example.com",
      personalTenantId: "tenant123",
    });
    mockDb.report.create.mockResolvedValue({
      id: "rep1",
      status: "pending",
      createdAt: new Date("2026-09-04T00:00:00Z"),
    });
    mockCarveOut.mockResolvedValue({ applied: true });
  });

  async function fileWith(routingClass: string, resourceType = "media") {
    mockDb.reportCategory.findUnique.mockResolvedValue({
      key: "k",
      active: true,
      routingClass,
    });
    return handler.handleCreate(
      createReq({ categoryKey: "k", resourceType, resourceId: "m1" }),
      session,
      mockEnv,
      requestContext,
    );
  }

  it("fires the carve-out on ILLEGAL_PRIORITY, with the new report id", async () => {
    const res = await fileWith("ILLEGAL_PRIORITY");

    expect(res.status).toBe(201);
    expect(mockCarveOut).toHaveBeenCalledOnce();
    const [, input] = mockCarveOut.mock.calls[0] as any[];
    expect(input).toMatchObject({
      reportId: "rep1",
      resourceType: "media",
      resourceId: "m1",
    });
  });

  it("does NOT fire it for ILLEGAL, POLICY_VIOLATION or FEEDBACK", async () => {
    for (const rc of ["ILLEGAL", "POLICY_VIOLATION", "FEEDBACK"]) {
      mockCarveOut.mockClear();
      await fileWith(rc);
      expect(mockCarveOut, rc).not.toHaveBeenCalled();
    }
  });

  it("does NOT restrict a legacy url/user target even at ILLEGAL_PRIORITY", async () => {
    await fileWith("ILLEGAL_PRIORITY", "url");
    expect(mockCarveOut).not.toHaveBeenCalled();
  });

  it("a failed carve-out still returns 201 — the notice is never dropped", async () => {
    mockCarveOut.mockResolvedValue({
      applied: false,
      failure: "seam-not-configured",
    });

    const res = await fileWith("ILLEGAL_PRIORITY");

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.report.id).toBe("rep1");
    // And the reporter learns nothing about the carve-out either way.
    expect(JSON.stringify(body)).not.toContain("carve");
    expect(JSON.stringify(body)).not.toContain("evidence");
  });
});

/**
 * The category vocabulary is deployment-seeded data. A client that hardcoded it
 * would put jurisdiction/offence vocabulary back into the published surface by
 * the back door, so it has to be readable — and readable WITHOUT the routing
 * class, which is the operator's enforcement posture, not the reporter's
 * business.
 */
describe("ReportHandler.handleListCategories", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReportHandler();
  });

  it("returns active categories with their labels, ordered for a picker", async () => {
    mockDb.reportCategory.findMany.mockResolvedValue([
      { key: "b-key", labels: { en: "B", de: "B-de" } },
      { key: "a-key", labels: { en: "A" } },
    ]);

    const res = await handler.handleListCategories(mockEnv, requestContext);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.categories).toEqual([
      { key: "b-key", labels: { en: "B", de: "B-de" } },
      { key: "a-key", labels: { en: "A" } },
    ]);
    const args = mockDb.reportCategory.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ active: true });
    expect(args.orderBy).toEqual([{ sortOrder: "asc" }, { key: "asc" }]);
  });

  it("never exposes routingClass — it is not even selected", async () => {
    mockDb.reportCategory.findMany.mockResolvedValue([
      { key: "a-key", labels: { en: "A" } },
    ]);

    const res = await handler.handleListCategories(mockEnv, requestContext);

    const select = mockDb.reportCategory.findMany.mock.calls[0][0].select;
    expect(select).toEqual({ key: true, labels: true });
    expect(JSON.stringify(await res.json())).not.toContain("routingClass");
  });

  it("inactive categories are excluded — that flag is the pre-legal-review gate", async () => {
    mockDb.reportCategory.findMany.mockResolvedValue([]);

    const body = (await (
      await handler.handleListCategories(mockEnv, requestContext)
    ).json()) as any;

    expect(body.categories).toEqual([]);
    expect(mockDb.reportCategory.findMany.mock.calls[0][0].where.active).toBe(true);
  });

  it("a database fault is a 500, not a leak", async () => {
    mockDb.reportCategory.findMany.mockRejectedValue(new Error("db down"));

    const res = await handler.handleListCategories(mockEnv, requestContext);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});
