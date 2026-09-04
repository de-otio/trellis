/**
 * Unit Tests: ContentReportAdminHandler (compliance plan 08 §2.2).
 *
 * The gap this closes: `routes/admin.ts` scopes its queue to
 * `reportType: "LINK"`, so before this surface existed a CONTENT report could be
 * filed, receipted and never reviewed by anybody. These pin
 *   - the CONTENT scope in BOTH directions (CONTENT is listed; a LINK id is not
 *     decidable here),
 *   - the SUPER_ADMIN gate,
 *   - that deciding goes through the lifecycle mechanism, which is what sends
 *     the reporter their Art. 16(5) notice, and
 *   - that an illegal transition is a 409, not a silent overwrite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";

const mockDb = {
  report: { findMany: vi.fn(), findFirst: vi.fn() },
};

vi.mock("../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

const mockTransition = vi.fn();
vi.mock("../../src/lib/report-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/report-lifecycle.js")
  >();
  return {
    ...actual,
    transitionReportStatus: (...args: unknown[]) => mockTransition(...args),
  };
});

const { ContentReportAdminHandler } = await import(
  "../../src/lib/content-report-admin-handler.js"
);
const { InvalidReportTransitionError } = await import(
  "../../src/lib/report-lifecycle.js"
);

const mockEnv = { DEFAULT_REGION: "EU" } as unknown as Env;

const superAdmin = { userId: "admin1", globalRole: "SUPER_ADMIN" } as any;
const endUser = { userId: "user1", globalRole: "END_USER" } as any;

function decisionReq(body: unknown): Request {
  return new Request(
    "https://api.example.com/api/admin/content-reports/rep1/decision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("ContentReportAdminHandler.handleList", () => {
  let handler: InstanceType<typeof ContentReportAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ContentReportAdminHandler();
    mockDb.report.findMany.mockResolvedValue([]);
  });

  it("scopes the queue to CONTENT reports — the LINK queue stays separate", async () => {
    await handler.handleList(
      superAdmin,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports"),
      "EU",
    );

    const where = mockDb.report.findMany.mock.calls[0][0].where;
    expect(where.reportType).toBe("CONTENT");
  });

  it("orders oldest-first: this is a deadline-bearing queue", async () => {
    await handler.handleList(
      superAdmin,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports"),
      "EU",
    );

    expect(mockDb.report.findMany.mock.calls[0][0].orderBy).toEqual({
      createdAt: "asc",
    });
  });

  it("returns the routing class so an operator can triage without the category vocabulary", async () => {
    mockDb.report.findMany.mockResolvedValue([
      {
        id: "rep1",
        resourceType: "media",
        resourceId: "m1",
        categoryKey: "some-key",
        reporterUserId: "user1",
        reason: null,
        status: "pending",
        resolution: null,
        resolvedAt: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        category: { routingClass: "ILLEGAL_PRIORITY" },
      },
    ]);

    const res = await handler.handleList(
      superAdmin,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports"),
      "EU",
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.reports[0].routingClass).toBe("ILLEGAL_PRIORITY");
    expect(body.hasMore).toBe(false);
  });

  it("filters by status, categoryKey and routingClass", async () => {
    await handler.handleList(
      superAdmin,
      mockEnv,
      new URL(
        "https://api.example.com/api/admin/content-reports?status=pending&categoryKey=k1&routingClass=ILLEGAL",
      ),
      "EU",
    );

    const where = mockDb.report.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("pending");
    expect(where.categoryKey).toBe("k1");
    expect(where.category).toEqual({ routingClass: "ILLEGAL" });
  });

  it("rejects an unknown status or routing class rather than returning everything", async () => {
    const bad = await handler.handleList(
      superAdmin,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports?status=approved"),
      "EU",
    );
    expect(bad.status).toBe(400);

    const badClass = await handler.handleList(
      superAdmin,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports?routingClass=NOPE"),
      "EU",
    );
    expect(badClass.status).toBe(400);
    expect(mockDb.report.findMany).not.toHaveBeenCalled();
  });

  it("403s a non-SUPER_ADMIN before it touches the database", async () => {
    const res = await handler.handleList(
      endUser,
      mockEnv,
      new URL("https://api.example.com/api/admin/content-reports"),
      "EU",
    );

    expect(res.status).toBe(403);
    expect(mockDb.report.findMany).not.toHaveBeenCalled();
  });
});

describe("ContentReportAdminHandler.handleDecision", () => {
  let handler: InstanceType<typeof ContentReportAdminHandler>;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ContentReportAdminHandler();
    mockDb.report.findFirst.mockResolvedValue({ id: "rep1" });
    mockTransition.mockResolvedValue({
      id: "rep1",
      status: "decided",
      resolution: "actioned",
    });
  });

  it("decides through the lifecycle mechanism — which is what notifies the reporter", async () => {
    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "decided", resolution: "actioned" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(200);
    expect(mockTransition).toHaveBeenCalledOnce();
    expect(mockTransition.mock.calls[0][0]).toMatchObject({
      reportId: "rep1",
      toStatus: "decided",
      resolution: "actioned",
    });
  });

  it("acknowledges without a resolution", async () => {
    mockTransition.mockResolvedValue({
      id: "rep1",
      status: "acknowledged",
      resolution: null,
    });

    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "acknowledged" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(200);
    expect(mockTransition.mock.calls[0][0].resolution).toBeUndefined();
  });

  it("refuses to decide without a resolution — the reporter must get an outcome", async () => {
    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "decided" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("404s a LINK/ACCOUNT report id — the wrong state machine is not entered", async () => {
    mockDb.report.findFirst.mockResolvedValue(null);

    const res = await handler.handleDecision(
      "link-report-1",
      decisionReq({ status: "acknowledged" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(404);
    expect(mockDb.report.findFirst.mock.calls[0][0].where.reportType).toBe(
      "CONTENT",
    );
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("409s an illegal transition rather than overwriting a decided report", async () => {
    mockTransition.mockRejectedValue(
      new InvalidReportTransitionError("decided", "acknowledged"),
    );

    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "acknowledged" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe("INVALID_TRANSITION");
  });

  it("rejects an unknown target status", async () => {
    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "approved" }),
      superAdmin,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("403s a non-SUPER_ADMIN before any read or transition", async () => {
    const res = await handler.handleDecision(
      "rep1",
      decisionReq({ status: "acknowledged" }),
      endUser,
      mockEnv,
      "EU",
    );

    expect(res.status).toBe(403);
    expect(mockDb.report.findFirst).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
  });
});
