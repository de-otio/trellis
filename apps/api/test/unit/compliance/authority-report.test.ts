/**
 * Unit Tests: Authority-report tracking (plan 08 §2.6 / §5).
 *
 * - creation NEVER auto-submits (the channel is never touched).
 * - operator-confirmed mark-submitted files through the channel.
 * - mark-closed releases the evidence hold (store + DB flag).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

vi.mock("../../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    async logSystemAction() {}
  },
}));

import {
  createPendingAuthorityReport,
  markAuthorityReportSubmitted,
  markAuthorityReportClosed,
} from "../../../src/lib/compliance/authority-report.js";
import {
  setAuthorityReportChannel,
  setEvidencePreservationStore,
  __resetComplianceSeamsForTests,
} from "../../../src/lib/media/compliance-seams.js";

const env = { DEFAULT_REGION: "EU" } as unknown as Env;

describe("createPendingAuthorityReport", () => {
  beforeEach(() => __resetComplianceSeamsForTests());
  afterEach(() => __resetComplianceSeamsForTests());

  it("creates a pending report and NEVER submits through the channel", async () => {
    const channelSubmit = vi.fn(async () => ({ mode: "manual" as const, instructionsKey: "k" }));
    setAuthorityReportChannel({ submit: channelSubmit });

    const create = vi.fn(async () => ({ id: "ar1", status: "pending" }));
    const db = { authorityReport: { create } } as any;

    const result = await createPendingAuthorityReport(
      db,
      { jurisdiction: "DE", evidenceId: "ev1", bundle: { contentRef: "media:m1" } },
      env,
      "EU" as any,
    );

    expect(result).toEqual({ id: "ar1", status: "pending" });
    expect(create.mock.calls[0][0].data.status).toBe("pending");
    // THE invariant: nothing was filed.
    expect(channelSubmit).not.toHaveBeenCalled();
  });
});

describe("markAuthorityReportSubmitted", () => {
  beforeEach(() => __resetComplianceSeamsForTests());
  afterEach(() => __resetComplianceSeamsForTests());

  it("files through the channel on explicit operator confirmation", async () => {
    const channelSubmit = vi.fn(async () => ({ mode: "manual" as const, instructionsKey: "k" }));
    setAuthorityReportChannel({ submit: channelSubmit });

    const db = {
      authorityReport: {
        findUnique: vi.fn(async () => ({ id: "ar1", status: "pending", evidenceId: "ev1" })),
        update: vi.fn(async () => ({ id: "ar1", status: "submitted" })),
      },
    } as any;

    const result = await markAuthorityReportSubmitted(
      db,
      "ar1",
      { jurisdiction: "DE", bundle: { contentRef: "media:m1" } },
      env,
      "EU" as any,
    );

    expect(channelSubmit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("submitted");
    expect(result.channelMode).toBe("manual");
    expect(db.authorityReport.update.mock.calls[0][0].data.status).toBe("submitted");
  });
});

describe("markAuthorityReportClosed", () => {
  beforeEach(() => __resetComplianceSeamsForTests());
  afterEach(() => __resetComplianceSeamsForTests());

  it("releases the evidence hold (store + DB flag) on close", async () => {
    const releaseHold = vi.fn(async () => {});
    setEvidencePreservationStore({ preserve: vi.fn(async () => ({ evidenceId: "x" })), releaseHold });

    const mediaUpdateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      authorityReport: {
        findUnique: vi.fn(async () => ({ id: "ar1", status: "submitted", evidenceId: "ev1" })),
        update: vi.fn(async () => ({ id: "ar1", status: "closed" })),
      },
      mediaFile: { updateMany: mediaUpdateMany },
    } as any;

    const result = await markAuthorityReportClosed(db, "ar1", "case-closed", env, "EU" as any);

    expect(releaseHold).toHaveBeenCalledWith("ev1", "case-closed");
    expect(mediaUpdateMany).toHaveBeenCalledWith({
      where: { evidenceId: "ev1" },
      data: { evidenceHold: false },
    });
    expect(result.status).toBe("closed");
  });
});
