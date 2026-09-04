/**
 * Unit Tests: restrictContent takedown orchestration (plan 08 §2.3 / §5).
 *
 * - HIDE happens immediately, before preservation completes (ordering).
 * - preservation FAILURE → item stays hidden + retried + alarm fired.
 * - FAIL-SAFE: preserve requested with NO store injected → throws LOUD, before
 *   any mutation.
 * - a StatementOfReasons is written for every restriction.
 * - media under preservation gets an evidence hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";

// Audit is best-effort infra; stub it so tests don't touch a DB.
vi.mock("../../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    async logSystemAction() {}
  },
}));

import {
  restrictContent,
  evidenceHoldExemptWhere,
  setComplianceAlarmHook,
  __resetComplianceAlarmHookForTests,
  MAX_PRESERVE_ATTEMPTS,
  type RestrictContentDb,
} from "../../../src/lib/compliance/restrict-content.js";
import {
  setEvidencePreservationStore,
  __resetComplianceSeamsForTests,
  ComplianceSeamNotConfiguredError,
} from "../../../src/lib/media/compliance-seams.js";
import {
  setStatementDelivery,
  __resetStatementDeliveryForTests,
} from "../../../src/lib/compliance/statement-of-reasons.js";

const env = { DEFAULT_REGION: "EU" } as unknown as Env;

function mockDb() {
  const order: string[] = [];
  const statementCreate = vi.fn(async () => ({ id: "sor1", suppressed: false }));
  const mediaUpdate = vi.fn(async () => {
    order.push("media.update");
    return { id: "m1" };
  });
  const db: RestrictContentDb = {
    statementOfReasons: { create: statementCreate as any },
    mediaFile: { update: mediaUpdate as any },
    post: { update: vi.fn(async () => ({ id: "p1" })) as any },
    postComment: { update: vi.fn(async () => ({ id: "c1" })) as any },
  };
  return { db, order, statementCreate, mediaUpdate };
}

const mediaRef = {
  resourceType: "media" as const,
  resourceId: "m1",
  affectedUserId: "u1",
  bytesLocation: { bucket: "processing", key: "t1/hash" },
};

describe("restrictContent", () => {
  beforeEach(() => {
    __resetComplianceSeamsForTests();
    __resetComplianceAlarmHookForTests();
    __resetStatementDeliveryForTests();
    setStatementDelivery(async () => {});
  });
  afterEach(() => {
    __resetComplianceSeamsForTests();
    __resetComplianceAlarmHookForTests();
    __resetStatementDeliveryForTests();
  });

  it("hides immediately BEFORE preservation completes", async () => {
    const preserveOrder: string[] = [];
    const { db, order } = mockDb();
    setEvidencePreservationStore({
      preserve: vi.fn(async () => {
        // At the moment preserve is invoked, the hide must already be done.
        preserveOrder.push("preserve");
        expect(order).toContain("media.update"); // hide happened first
        return { evidenceId: "ev1" };
      }),
      releaseHold: vi.fn(async () => {}),
    });

    const result = await restrictContent(
      db,
      mediaRef,
      { preserve: true, statementTemplateKey: "sor.default" },
      env,
      "EU" as any,
    );

    expect(result.restricted).toBe(true);
    expect(result.evidenceId).toBe("ev1");
    expect(preserveOrder).toEqual(["preserve"]);
  });

  it("sets hidden + evidenceHold on the media row when preserving", async () => {
    const { db, mediaUpdate } = mockDb();
    setEvidencePreservationStore({
      preserve: vi.fn(async () => ({ evidenceId: "ev1" })),
      releaseHold: vi.fn(async () => {}),
    });
    await restrictContent(
      db,
      mediaRef,
      { preserve: true, statementTemplateKey: "sor.default" },
      env,
      "EU" as any,
    );
    // First update = the hide (hidden:true, evidenceHold:true).
    const hideData = mediaUpdate.mock.calls[0][0].data;
    expect(hideData.hidden).toBe(true);
    expect(hideData.evidenceHold).toBe(true);
    // A later update records the evidence id.
    const evidenceUpdate = mediaUpdate.mock.calls.find(
      (c) => c[0].data.evidenceId === "ev1",
    );
    expect(evidenceUpdate).toBeTruthy();
  });

  it("keeps the item hidden and fires the alarm when preservation fails after retries", async () => {
    const { db, mediaUpdate } = mockDb();
    const preserve = vi.fn(async () => {
      throw new Error("s3 down");
    });
    setEvidencePreservationStore({ preserve, releaseHold: vi.fn(async () => {}) });
    const alarm = vi.fn(async () => {});
    setComplianceAlarmHook(alarm);

    const result = await restrictContent(
      db,
      mediaRef,
      { preserve: true, statementTemplateKey: "sor.default" },
      env,
      "EU" as any,
    );

    // Retried up to the bound, then alarmed — but the item is STILL hidden.
    expect(preserve).toHaveBeenCalledTimes(MAX_PRESERVE_ATTEMPTS);
    expect(alarm).toHaveBeenCalledTimes(1);
    expect(result.preserveFailed).toBe(true);
    const hideData = mediaUpdate.mock.calls[0][0].data;
    expect(hideData.hidden).toBe(true);
  });

  it("FAIL-SAFE: preserve requested with no store injected throws LOUD before any mutation", async () => {
    const { db, mediaUpdate, statementCreate } = mockDb();
    // No store injected → the throwing default is active.
    await expect(
      restrictContent(
        db,
        mediaRef,
        { preserve: true, statementTemplateKey: "sor.default" },
        env,
        "EU" as any,
      ),
    ).rejects.toBeInstanceOf(ComplianceSeamNotConfiguredError);
    // Nothing was mutated — no hide, no statement.
    expect(mediaUpdate).not.toHaveBeenCalled();
    expect(statementCreate).not.toHaveBeenCalled();
  });

  it("writes a StatementOfReasons for every restriction (even without preserve)", async () => {
    const { db, statementCreate } = mockDb();
    const result = await restrictContent(
      db,
      { resourceType: "post", resourceId: "p1", affectedUserId: "u1" },
      { preserve: false, statementTemplateKey: "sor.default", restriction: "hidden" },
      env,
      "EU" as any,
    );
    expect(statementCreate).toHaveBeenCalledTimes(1);
    expect(result.statementId).toBe("sor1");
  });
});

describe("evidenceHoldExemptWhere", () => {
  it("is the single hold-exempt predicate both cascade paths use", () => {
    expect(evidenceHoldExemptWhere()).toEqual({ evidenceHold: false });
  });
});
