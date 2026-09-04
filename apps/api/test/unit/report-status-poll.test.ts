/**
 * Unit Tests: the reporter's status poll — GET /api/reports/:id
 * (compliance plan 08 §2.2 — DSA Art. 16(4), 16(5), 17).
 *
 * Four things must be REACHABLE by the person who filed the report, not merely
 * emitted once into an email that may never arrive:
 *   1. the receipt confirmation (Art. 16(4)),
 *   2. the decision (Art. 16(5)),
 *   3. the statement of reasons — the fact and kind of restriction (Art. 17),
 *   4. the remedies / redress notice (Art. 16(5)).
 *
 * And two things must NOT be reachable: someone else's report, and a SUPPRESSED
 * statement of reasons (the non-tip-off carve-out would be pointless if the
 * reporter could read it back).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { ReportHandler } from "../../src/lib/report-handler.js";
import {
  REPORT_TEMPLATE_KEYS,
  setReportTemplates,
  __resetReportTemplatesForTests,
} from "../../src/lib/report-templates.js";

const mockDb = {
  report: { findFirst: vi.fn() },
  statementOfReasons: { findFirst: vi.fn() },
};

vi.mock("../../src/lib/data-router.js", () => ({
  DataRouter: { getDatabaseForRegion: vi.fn(() => mockDb) },
}));

const mockEnv = { DEFAULT_REGION: "EU" } as unknown as Env;
const requestContext = { region: "EU" } as any;
const session = { userId: "user123", email: "reporter@example.com" } as any;

const CREATED = new Date("2026-09-01T10:00:00Z");
const DECIDED = new Date("2026-09-03T12:00:00Z");

function reportRow(over: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    reportType: "CONTENT",
    resourceType: "post",
    resourceId: "post1",
    categoryKey: "some-category",
    status: "pending",
    resolution: null,
    resolvedAt: null,
    createdAt: CREATED,
    ...over,
  };
}

describe("ReportHandler.handleStatus — what the reporter can reach", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReportTemplatesForTests();
    handler = new ReportHandler();
    mockDb.statementOfReasons.findFirst.mockResolvedValue(null);
  });

  it("1. the Art. 16(4) receipt is reachable as soon as the report exists", async () => {
    mockDb.report.findFirst.mockResolvedValue(reportRow());

    const res = await handler.handleStatus("rep1", session, mockEnv, requestContext);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.receipt.confirmed).toBe(true);
    expect(body.receipt.receivedAt).toBe(CREATED.toISOString());
    // Rendered copy, not a bare flag — the reference is interpolated.
    expect(body.receipt.body).toContain("rep1");
    // Nothing has been decided, so nothing pretends otherwise.
    expect(body.decision).toBeNull();
    expect(body.remedies).toBeNull();
    expect(body.statementOfReasons).toBeNull();
  });

  it("2. the Art. 16(5) decision is reachable once decided", async () => {
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "actioned", resolvedAt: DECIDED }),
    );

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.decision.outcome).toBe("actioned");
    expect(body.decision.decidedAt).toBe(DECIDED.toISOString());
    expect(body.decision.title).toBeTruthy();
    expect(body.decision.body).toContain("rep1");
  });

  it("2b. a rejected report gets the rejected copy, not the actioned copy", async () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.DECISION_ACTIONED]: {
        title: "A",
        body: "we acted",
      },
      [REPORT_TEMPLATE_KEYS.DECISION_REJECTED]: {
        title: "R",
        body: "we did not act",
      },
    });
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "rejected", resolvedAt: DECIDED }),
    );

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.decision.outcome).toBe("rejected");
    expect(body.decision.body).toBe("we did not act");
  });

  it("3. the statement of reasons is reachable — the fact and kind only", async () => {
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "actioned", resolvedAt: DECIDED }),
    );
    mockDb.statementOfReasons.findFirst.mockResolvedValue({
      restriction: "hidden",
      createdAt: DECIDED,
    });

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.statementOfReasons).toEqual({
      restriction: "hidden",
      issuedAt: DECIDED.toISOString(),
    });
    // The lookup is scoped to the reported resource and excludes suppressed rows.
    expect(mockDb.statementOfReasons.findFirst.mock.calls[0][0].where).toMatchObject({
      resourceType: "post",
      resourceId: "post1",
      suppressed: false,
    });
    // Never the affected user, the template key, or the template params.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("affectedUserId");
    expect(serialized).not.toContain("templateKey");
    expect(serialized).not.toContain("params");
  });

  it("4. the remedies / redress notice travels with the decision", async () => {
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "rejected", resolvedAt: DECIDED }),
    );

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.remedies.title).toBeTruthy();
    expect(body.remedies.body).toContain("rep1");
  });

  it("4b. deployment-supplied redress copy overrides the neutral core fallback", async () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.REDRESS]: {
        title: "Your options",
        body: "Complaint handling for {reportId}.",
      },
    });
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "actioned", resolvedAt: DECIDED }),
    );

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.remedies.title).toBe("Your options");
    expect(body.remedies.body).toBe("Complaint handling for rep1.");
  });
});

describe("ReportHandler.handleStatus — what the reporter must NOT reach", () => {
  let handler: ReportHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReportTemplatesForTests();
    handler = new ReportHandler();
    mockDb.statementOfReasons.findFirst.mockResolvedValue(null);
  });

  it("a SUPPRESSED statement stays invisible — the carve-out is not leaked back", async () => {
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "actioned", resolvedAt: DECIDED }),
    );
    // The DB-side filter is `suppressed: false`, so a suppressed row never comes
    // back; assert both the filter and the resulting null.
    mockDb.statementOfReasons.findFirst.mockResolvedValue(null);

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(
      mockDb.statementOfReasons.findFirst.mock.calls[0][0].where.suppressed,
    ).toBe(false);
    expect(body.statementOfReasons).toBeNull();
    // The decision itself is still delivered — the reporter is not left in the
    // dark, they just learn nothing about the class of the content.
    expect(body.decision.outcome).toBe("actioned");
  });

  it("no statement is surfaced before a decision, even if one exists", async () => {
    mockDb.report.findFirst.mockResolvedValue(reportRow({ status: "acknowledged" }));

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.statementOfReasons).toBeNull();
    expect(mockDb.statementOfReasons.findFirst).not.toHaveBeenCalled();
  });

  it("no statement is surfaced for a REJECTED report — nothing was restricted", async () => {
    mockDb.report.findFirst.mockResolvedValue(
      reportRow({ status: "decided", resolution: "rejected", resolvedAt: DECIDED }),
    );

    const body = (await (
      await handler.handleStatus("rep1", session, mockEnv, requestContext)
    ).json()) as any;

    expect(body.statementOfReasons).toBeNull();
    expect(mockDb.statementOfReasons.findFirst).not.toHaveBeenCalled();
  });

  it("someone else's report 404s, and the query is reporter-scoped", async () => {
    mockDb.report.findFirst.mockResolvedValue(null);

    const res = await handler.handleStatus(
      "someone-elses",
      session,
      mockEnv,
      requestContext,
    );

    expect(res.status).toBe(404);
    expect(mockDb.report.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "someone-elses",
      reporterUserId: "user123",
    });
  });

  it("a database fault is a 500, not a leak", async () => {
    mockDb.report.findFirst.mockRejectedValue(new Error("db down"));

    const res = await handler.handleStatus("rep1", session, mockEnv, requestContext);
    const body = (await res.json()) as any;

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("db down");
  });
});
