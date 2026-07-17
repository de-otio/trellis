/**
 * Unit Tests: compliance seams (plan 08 §2.5, plan 07 §4.2, plan 09 §6).
 *
 * The fail-SAFE default contract: preservation and the feedback sink THROW when
 * un-injected (a mis-wired deploy must fail loud, never silently drop evidence
 * or feedback); the authority channel defaults to a manual no-op that never
 * auto-files. Injection replaces the default.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComplianceSeamNotConfiguredError,
  getEvidencePreservationStore,
  getAuthorityReportChannel,
  getModerationFeedbackSink,
  setEvidencePreservationStore,
  setAuthorityReportChannel,
  setModerationFeedbackSink,
  isEvidencePreservationConfigured,
  __resetComplianceSeamsForTests,
} from "../../src/lib/media/compliance-seams.js";

afterEach(() => __resetComplianceSeamsForTests());

describe("EvidencePreservationStore fail-safe default", () => {
  it("throws when un-injected (never a silent no-op)", async () => {
    expect(isEvidencePreservationConfigured()).toBe(false);
    await expect(
      getEvidencePreservationStore().preserve({ contentRef: "post:1" }),
    ).rejects.toBeInstanceOf(ComplianceSeamNotConfiguredError);
    await expect(
      getEvidencePreservationStore().releaseHold("e1", "closed"),
    ).rejects.toBeInstanceOf(ComplianceSeamNotConfiguredError);
  });

  it("returns the injected store once set", async () => {
    const preserve = vi.fn().mockResolvedValue({ evidenceId: "e-9" });
    setEvidencePreservationStore({ preserve, releaseHold: vi.fn() });
    expect(isEvidencePreservationConfigured()).toBe(true);
    const out = await getEvidencePreservationStore().preserve({
      contentRef: "post:1",
    });
    expect(out.evidenceId).toBe("e-9");
    expect(preserve).toHaveBeenCalledOnce();
  });
});

describe("ModerationFeedbackSink fail-safe default", () => {
  it("throws when un-injected", async () => {
    await expect(
      getModerationFeedbackSink().store({
        resourceType: "post",
        resourceId: "1",
        reporterUserId: "u1",
        includeContent: false,
        blockClass: "lawful-flagged",
      }),
    ).rejects.toBeInstanceOf(ComplianceSeamNotConfiguredError);
  });

  it("delegates to the injected sink", async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    setModerationFeedbackSink({ store });
    await getModerationFeedbackSink().store({
      resourceType: "post",
      resourceId: "1",
      reporterUserId: "u1",
      includeContent: false,
      blockClass: "lawful-flagged",
    });
    expect(store).toHaveBeenCalledOnce();
  });
});

describe("AuthorityReportChannel fail-safe default", () => {
  it("defaults to a manual no-op that never auto-files", async () => {
    const result = await getAuthorityReportChannel().submit({
      jurisdiction: "XX",
      bundle: {},
    });
    expect(result.mode).toBe("manual");
    if (result.mode === "manual") {
      expect(result.instructionsKey).toBeTruthy();
    }
  });

  it("returns the injected channel once set", async () => {
    const submit = vi
      .fn()
      .mockResolvedValue({ mode: "api", receiptId: "rcpt-1" });
    setAuthorityReportChannel({ submit });
    const result = await getAuthorityReportChannel().submit({
      jurisdiction: "XX",
      bundle: {},
    });
    expect(result).toEqual({ mode: "api", receiptId: "rcpt-1" });
  });
});
