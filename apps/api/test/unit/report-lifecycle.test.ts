/**
 * Unit Tests: report lifecycle (compliance plan 08 §2.2, §5).
 *
 * pending -> acknowledged -> decided; the Art. 16(5) decision notification fires
 * only on reaching the terminal `decided` state, with the resolution outcome.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  transitionReportStatus,
  InvalidReportTransitionError,
  ReportNotFoundError,
} from "../../src/lib/report-lifecycle.js";

const mockDb = {
  report: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  release: vi.fn(),
};

vi.mock("../../src/db.js", () => ({
  createPrisma: vi.fn(() => mockDb),
}));

const mockSendDecision = vi.fn();
vi.mock("../../src/lib/report-notifications.js", () => ({
  sendReportDecision: (...args: unknown[]) => mockSendDecision(...args),
}));

const mockEnv = { DEFAULT_REGION: "EU" } as unknown as Env;

describe("transitionReportStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({
      email: "reporter@example.com",
      personalTenantId: "tenant123",
    });
  });

  it("pending -> acknowledged: updates status, NO decision notification", async () => {
    mockDb.report.findUnique.mockResolvedValue({
      id: "r1",
      status: "pending",
      reporterUserId: "u1",
    });
    mockDb.report.update.mockResolvedValue({
      id: "r1",
      status: "acknowledged",
      resolution: null,
    });

    const result = await transitionReportStatus(
      { reportId: "r1", toStatus: "acknowledged" },
      mockEnv,
    );

    expect(result.status).toBe("acknowledged");
    expect(mockSendDecision).not.toHaveBeenCalled();
    expect(mockDb.report.update.mock.calls[0][0].data.status).toBe(
      "acknowledged",
    );
  });

  it("pending -> decided(actioned): sets resolution + resolvedAt, sends decision", async () => {
    mockDb.report.findUnique.mockResolvedValue({
      id: "r1",
      status: "pending",
      reporterUserId: "u1",
    });
    mockDb.report.update.mockResolvedValue({
      id: "r1",
      status: "decided",
      resolution: "actioned",
    });

    const result = await transitionReportStatus(
      { reportId: "r1", toStatus: "decided", resolution: "actioned" },
      mockEnv,
    );

    expect(result.status).toBe("decided");
    const updateData = mockDb.report.update.mock.calls[0][0].data;
    expect(updateData.resolution).toBe("actioned");
    expect(updateData.resolvedAt).toBeInstanceOf(Date);

    expect(mockSendDecision).toHaveBeenCalledOnce();
    const [target, outcome] = mockSendDecision.mock.calls[0];
    expect(outcome).toBe("actioned");
    expect(target.reportId).toBe("r1");
    expect(target.reporterEmail).toBe("reporter@example.com");
  });

  it("acknowledged -> decided(rejected): sends the rejected decision", async () => {
    mockDb.report.findUnique.mockResolvedValue({
      id: "r1",
      status: "acknowledged",
      reporterUserId: "u1",
    });
    mockDb.report.update.mockResolvedValue({
      id: "r1",
      status: "decided",
      resolution: "rejected",
    });

    await transitionReportStatus(
      { reportId: "r1", toStatus: "decided", resolution: "rejected" },
      mockEnv,
    );

    expect(mockSendDecision.mock.calls[0][1]).toBe("rejected");
  });

  it("decided is terminal: any further transition throws", async () => {
    mockDb.report.findUnique.mockResolvedValue({
      id: "r1",
      status: "decided",
      reporterUserId: "u1",
    });

    await expect(
      transitionReportStatus({ reportId: "r1", toStatus: "acknowledged" }, mockEnv),
    ).rejects.toBeInstanceOf(InvalidReportTransitionError);
    expect(mockDb.report.update).not.toHaveBeenCalled();
  });

  it("decided without a resolution throws (no silent close)", async () => {
    mockDb.report.findUnique.mockResolvedValue({
      id: "r1",
      status: "pending",
      reporterUserId: "u1",
    });

    await expect(
      transitionReportStatus({ reportId: "r1", toStatus: "decided" }, mockEnv),
    ).rejects.toBeInstanceOf(InvalidReportTransitionError);
    expect(mockDb.report.update).not.toHaveBeenCalled();
    expect(mockSendDecision).not.toHaveBeenCalled();
  });

  it("missing report throws ReportNotFoundError", async () => {
    mockDb.report.findUnique.mockResolvedValue(null);
    await expect(
      transitionReportStatus({ reportId: "nope", toStatus: "acknowledged" }, mockEnv),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });
});
