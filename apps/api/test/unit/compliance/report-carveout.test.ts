/**
 * Unit Tests: the ILLEGAL_PRIORITY carve-out on report intake
 * (compliance plan 08 §2.3/§2.6 — the CSAM-class routing decision).
 *
 * The invariants under test are the ones that must hold WITHOUT a moderator on
 * shift:
 *   - hide + evidence hold + suppressed statement happen at INTAKE, not after
 *     a human triage step;
 *   - the media block class becomes `illegal-suspected`, so `isAppealable()`
 *     returns false and no appeal affordance is ever offered;
 *   - an AuthorityReport is created `pending` and is NEVER submitted — the
 *     channel seam must not be touched by this path at all;
 *   - a mis-wired deployment (no evidence store) fails LOUD to the operator and
 *     mutates NOTHING, but still keeps the reporter's notice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { isAppealable } from "../../../src/lib/compliance/block-class.js";
import { PLACEHOLDER_EVIDENCE_BUCKET } from "../../../src/lib/media/compliance-seams.js";

const mockPreserve = vi.fn();
const mockSubmit = vi.fn();
const mockReleaseHold = vi.fn();
let evidenceConfigured = true;

vi.mock("../../../src/lib/media/compliance-seams.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/lib/media/compliance-seams.js")
  >();
  return {
    ...actual,
    isEvidencePreservationConfigured: () => evidenceConfigured,
    getEvidencePreservationStore: () => ({
      preserve: mockPreserve,
      releaseHold: mockReleaseHold,
    }),
    getAuthorityReportChannel: () => ({ submit: mockSubmit }),
  };
});

const mockAudit = vi.fn();
vi.mock("../../../src/lib/audit-composer.js", () => ({
  TrellisAuditLogger: class {
    logSystemAction = mockAudit;
  },
}));

const {
  applyIllegalPriorityCarveOut,
  ILLEGAL_PRIORITY_SUPPRESS_REASON,
  isCarveOutResourceType,
} = await import("../../../src/lib/compliance/report-carveout.js");
const { setComplianceAlarmHook, __resetComplianceAlarmHookForTests } =
  await import("../../../src/lib/compliance/restrict-content.js");

const VALID_TENANT = "c" + "a".repeat(24); // matches /^c[a-z0-9]{24}$/
const VALID_HASH = "a".repeat(64);

const mockEnv = {
  DEFAULT_REGION: "EU",
  MEDIA_BUCKET_NAME: "core-test-media",
  COMPLIANCE_JURISDICTION: "XX",
} as unknown as Env;

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    mediaFile: {
      findUnique: vi.fn(async () => ({
        uploadedBy: "owner-1",
        tenantId: VALID_TENANT,
        contentHash: VALID_HASH,
      })),
      update: vi.fn(async () => ({ id: "media-1" })),
    },
    post: {
      findUnique: vi.fn(async () => ({
        authorId: "owner-1",
        tenantId: VALID_TENANT,
      })),
      update: vi.fn(async () => ({ id: "post-1" })),
    },
    postComment: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: "comment-1" })),
    },
    entityOwnership: { findFirst: vi.fn(async () => null) },
    statementOfReasons: {
      create: vi.fn(async () => ({ id: "sor-1", suppressed: true })),
    },
    authorityReport: {
      create: vi.fn(async () => ({ id: "auth-1", status: "pending" })),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ...overrides,
  } as any;
}

describe("ILLEGAL_PRIORITY carve-out — media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetComplianceAlarmHookForTests();
    evidenceConfigured = true;
    mockPreserve.mockResolvedValue({ evidenceId: "ev-1" });
  });

  it("hides, holds evidence, and marks the item non-appealable at INTAKE", async () => {
    const db = makeDb();

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    expect(result.applied).toBe(true);
    expect(result.evidenceId).toBe("ev-1");

    // 1. HIDE + evidence hold, in the same first write.
    const hideCall = db.mediaFile.update.mock.calls[0][0];
    expect(hideCall.where).toEqual({ id: "media-1" });
    expect(hideCall.data.hidden).toBe(true);
    expect(hideCall.data.evidenceHold).toBe(true);

    // 2. The block class is written and it is the non-appealable one. Asserted
    //    through isAppealable(), not the string, so the invariant is what's
    //    pinned rather than the label.
    const classCall = db.mediaFile.update.mock.calls.at(-1)[0];
    expect(isAppealable(classCall.data.blockClass)).toBe(false);
  });

  it("preserves the ORIGINAL bytes from the real configured bucket", async () => {
    const db = makeDb();

    await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    expect(mockPreserve).toHaveBeenCalledTimes(1);
    const bundle = mockPreserve.mock.calls[0][0];
    expect(bundle.bytesLocation.bucket).toBe("core-test-media");
    expect(bundle.bytesLocation.key).toBe(
      `processing/${VALID_TENANT}/${VALID_HASH}`,
    );
    // Refs only — the bundle must never carry the reporter's free text.
    expect(JSON.stringify(bundle)).not.toContain("reason");
  });

  it("writes the statement of reasons SUPPRESSED (non-tip-off), never delivered", async () => {
    const db = makeDb();

    await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    const sor = db.statementOfReasons.create.mock.calls[0][0].data;
    expect(sor.suppressed).toBe(true);
    expect(sor.suppressReason).toBe(ILLEGAL_PRIORITY_SUPPRESS_REASON);
    expect(sor.affectedUserId).toBe("owner-1");
  });

  it("creates a PENDING authority report and NEVER submits it", async () => {
    const db = makeDb();

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    expect(result.authorityReportId).toBe("auth-1");
    const created = db.authorityReport.create.mock.calls[0][0].data;
    expect(created.status).toBe("pending");
    expect(created.jurisdiction).toBe("XX");
    expect(created.evidenceId).toBe("ev-1");
    // The human gate: the channel seam is not touched by the intake path.
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(db.authorityReport.update).not.toHaveBeenCalled();
  });

  it("bundles REFS only — no bytes, and the report chain is a report id", async () => {
    const db = makeDb();

    await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    const bundle = db.authorityReport.create.mock.calls[0][0].data.bundle;
    expect(bundle.contentRef).toBe("media:media-1");
    expect(bundle.reportChain).toEqual(["rep-1"]);
  });
});

describe("ILLEGAL_PRIORITY carve-out — failure modes must be LOUD, not silent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetComplianceAlarmHookForTests();
    evidenceConfigured = true;
    mockPreserve.mockResolvedValue({ evidenceId: "ev-1" });
  });

  it("no evidence store wired: mutates NOTHING and fires the operator alarm", async () => {
    evidenceConfigured = false;
    const alarms: Array<{ kind: string }> = [];
    setComplianceAlarmHook(async (a) => {
      alarms.push(a);
    });
    const db = makeDb();

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    expect(result.applied).toBe(false);
    expect(result.failure).toBe("seam-not-configured");
    // Refuse rather than hide-then-silently-drop-evidence.
    expect(db.mediaFile.update).not.toHaveBeenCalled();
    expect(mockPreserve).not.toHaveBeenCalled();
    expect(db.authorityReport.create).not.toHaveBeenCalled();
    expect(alarms.map((a) => a.kind)).toContain(
      "illegal-priority-seam-not-configured",
    );
  });

  it("V2 FINDING G: unresolvable evidence copy-source refuses BEFORE preserving", async () => {
    const alarms: Array<{ kind: string }> = [];
    setComplianceAlarmHook(async (a) => {
      alarms.push(a);
    });
    // MEDIA_BUCKET_NAME unset — the exact mis-wiring that would otherwise
    // preserve a manifest with no bytes behind it and look successful.
    const envNoBucket = {
      DEFAULT_REGION: "EU",
      COMPLIANCE_JURISDICTION: "XX",
    } as unknown as Env;
    const db = makeDb();

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      envNoBucket,
      "EU" as any,
    );

    expect(result.applied).toBe(false);
    expect(result.failure).toBe("evidence-source-unresolved");
    expect(mockPreserve).not.toHaveBeenCalled();
    expect(db.mediaFile.update).not.toHaveBeenCalled();
    expect(db.authorityReport.create).not.toHaveBeenCalled();
    expect(alarms.map((a) => a.kind)).toContain(
      "illegal-priority-evidence-source-unresolved",
    );
  });

  it("V2 FINDING G: the literal CAS prefix is never accepted as a bucket", async () => {
    const alarms: Array<{ kind: string }> = [];
    setComplianceAlarmHook(async (a) => {
      alarms.push(a);
    });
    const envPlaceholder = {
      DEFAULT_REGION: "EU",
      // "processing" is a key PREFIX, not a bucket — CopyObject would 404.
      MEDIA_BUCKET_NAME: PLACEHOLDER_EVIDENCE_BUCKET,
      COMPLIANCE_JURISDICTION: "XX",
    } as unknown as Env;

    const result = await applyIllegalPriorityCarveOut(
      makeDb(),
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      envPlaceholder,
      "EU" as any,
    );

    expect(result.failure).toBe("evidence-source-unresolved");
    expect(mockPreserve).not.toHaveBeenCalled();
  });

  it("unresolvable owner: alarms and does not mutate", async () => {
    const alarms: Array<{ kind: string }> = [];
    setComplianceAlarmHook(async (a) => {
      alarms.push(a);
    });
    const db = makeDb({
      mediaFile: {
        findUnique: vi.fn(async () => null),
        update: vi.fn(),
      },
    });

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "gone" },
      mockEnv,
      "EU" as any,
    );

    expect(result.failure).toBe("owner-unresolved");
    expect(db.mediaFile.update).not.toHaveBeenCalled();
    expect(alarms.map((a) => a.kind)).toContain(
      "illegal-priority-owner-unresolved",
    );
  });

  it("never throws: a database fault is caught, alarmed, and reported back", async () => {
    const alarms: Array<{ kind: string }> = [];
    setComplianceAlarmHook(async (a) => {
      alarms.push(a);
    });
    const db = makeDb({
      statementOfReasons: {
        create: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    });

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
      mockEnv,
      "EU" as any,
    );

    expect(result.applied).toBe(false);
    expect(result.failure).toBe("error");
    expect(alarms.map((a) => a.kind)).toContain(
      "illegal-priority-carveout-failed",
    );
  });

  /**
   * A3 (quality sweep 2026-09-05). The block-class write is LAST, so that a
   * preserve failure cannot mark an item that was never hidden. The cost of
   * that ordering is a window: hide + preserve + hold all succeed, the class
   * write alone fails, and `isAppealable(null)` is deliberately `true` — so the
   * owner's disposition endpoint would offer submit-for-analysis on suspected
   * illegal content, the exact affordance the carve-out removes.
   *
   * The existing "db down" test throws at `statementOfReasons.create`, BEFORE
   * the class write, so it could never see this. These pin the window itself.
   */
  describe("the block-class write failing alone (A3)", () => {
    /** Succeeds for the hide, throws only for the block-class write. */
    const failOnBlockClass = () => {
      const update = vi.fn(async (args: any) => {
        if (args?.data?.blockClass) throw new Error("class write lost");
        return { id: "media-1" };
      });
      return makeDb({
        mediaFile: {
          findUnique: vi.fn(async () => ({
            uploadedBy: "owner-1",
            tenantId: VALID_TENANT,
            contentHash: VALID_HASH,
          })),
          update,
        },
      });
    };

    it("still files the authority report — Art. 18 is not abandoned at the last step", async () => {
      const db = failOnBlockClass();

      const result = await applyIllegalPriorityCarveOut(
        db,
        { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
        mockEnv,
        "EU" as any,
      );

      // Letting this reach the outer catch would return applied:false and
      // create NO authority report for content that is already hidden and
      // preserved. That is the worse outcome, so the carve-out continues.
      expect(result.applied).toBe(true);
      expect(result.authorityReportId).toBe("auth-1");
      expect(db.authorityReport.create).toHaveBeenCalled();
    });

    it("alarms under its own kind and reports the partial state back", async () => {
      const alarms: Array<{ kind: string }> = [];
      setComplianceAlarmHook(async (a) => {
        alarms.push(a);
      });
      const db = failOnBlockClass();

      const result = await applyIllegalPriorityCarveOut(
        db,
        { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
        mockEnv,
        "EU" as any,
      );

      // A distinct kind: the generic carve-out-failed alarm does not tell an
      // operator that a specific row needs its class repaired.
      expect(alarms.map((a) => a.kind)).toContain(
        "illegal-priority-block-class-unwritten",
      );
      expect(result.blockClassUnwritten).toBe(true);
    });

    it("leaves the item hidden — protection does not depend on the class write", async () => {
      const db = failOnBlockClass();

      await applyIllegalPriorityCarveOut(
        db,
        { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
        mockEnv,
        "EU" as any,
      );

      const hideCall = db.mediaFile.update.mock.calls[0][0];
      expect(hideCall.data.hidden).toBe(true);
    });

    it("does not set the flag on the ordinary success path", async () => {
      const db = makeDb();

      const result = await applyIllegalPriorityCarveOut(
        db,
        { reportId: "rep-1", resourceType: "media", resourceId: "media-1" },
        mockEnv,
        "EU" as any,
      );

      expect(result.applied).toBe(true);
      expect(result.blockClassUnwritten).toBeUndefined();
    });
  });
});

describe("ILLEGAL_PRIORITY carve-out — text resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetComplianceAlarmHookForTests();
    evidenceConfigured = true;
    mockPreserve.mockResolvedValue({ evidenceId: "ev-1" });
  });

  it("a post is hidden and preserved, with no block-class write (text has none)", async () => {
    const db = makeDb();

    const result = await applyIllegalPriorityCarveOut(
      db,
      { reportId: "rep-2", resourceType: "post", resourceId: "post-1" },
      mockEnv,
      "EU" as any,
    );

    expect(result.applied).toBe(true);
    expect(db.post.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "post-1" } }),
    );
    expect(db.mediaFile.update).not.toHaveBeenCalled();
  });

  it("recognises exactly the four content resource types", () => {
    expect(isCarveOutResourceType("post")).toBe(true);
    expect(isCarveOutResourceType("comment")).toBe(true);
    expect(isCarveOutResourceType("media")).toBe(true);
    expect(isCarveOutResourceType("entity")).toBe(true);
    // Legacy LINK/ACCOUNT targets are not content and must not be restricted.
    expect(isCarveOutResourceType("url")).toBe(false);
    expect(isCarveOutResourceType("user")).toBe(false);
  });
});
