/**
 * Public API surface snapshot.
 *
 * `@de-otio/trellis` is consumed via this exact set of named exports. Pinning
 * them means an accidental removal or rename fails here, before publish, where
 * it would otherwise only surface as a broken consumer build downstream.
 *
 * When you intentionally add/remove a public export, update this list in the
 * same change.
 */

import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";

const EXPECTED_EXPORTS = [
  "getExtension",
  "getExtensions",
  "registerExtension",
  "setMediaModerationProvider",
  "setPushTransportProvider",
  "setRealtimeProvider",
  "setTextModerationProvider",
  "startServer",
  // Compliance seams + reporter-notification wiring (plan 08 §2.5 / §2.2).
  // Type-only exports don't appear as runtime keys; only these value exports do.
  "setEvidencePreservationStore",
  "setAuthorityReportChannel",
  "setModerationFeedbackSink",
  "setReportTemplates",
  "REPORT_TEMPLATE_KEYS",
  "setOperatorAlertHook",
  // Compliance enforcement (plan 08 Phase 2 / spec 07 §4 — Lane A2). Value
  // exports only; the accompanying type exports are erased at runtime.
  "restrictContent",
  "evidenceHoldExemptWhere",
  "setComplianceAlarmHook",
  "setStatementDelivery",
  "ILLEGAL_SUSPECTED_LABEL",
  "deriveBlockClass",
  "isAppealable",
  "createPendingAuthorityReport",
  "markAuthorityReportSubmitted",
  "markAuthorityReportClosed",
].sort();

describe("public API surface (@de-otio/trellis)", () => {
  it("exports exactly the documented names", () => {
    expect(Object.keys(publicApi).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it("exposes the registration + boot functions as callables", () => {
    expect(typeof publicApi.registerExtension).toBe("function");
    expect(typeof publicApi.startServer).toBe("function");
    expect(typeof publicApi.getExtension).toBe("function");
    expect(typeof publicApi.getExtensions).toBe("function");
  });

  it("exposes the moderation-provider injection hooks as callables", () => {
    expect(typeof publicApi.setMediaModerationProvider).toBe("function");
    expect(typeof publicApi.setTextModerationProvider).toBe("function");
  });

  it("exposes the push-transport injection hook as a callable (T8)", () => {
    expect(typeof publicApi.setPushTransportProvider).toBe("function");
  });

  it("exposes the compliance-seam injection hooks as callables (plan 08 §2.5)", () => {
    expect(typeof publicApi.setEvidencePreservationStore).toBe("function");
    expect(typeof publicApi.setAuthorityReportChannel).toBe("function");
    expect(typeof publicApi.setModerationFeedbackSink).toBe("function");
    expect(typeof publicApi.setReportTemplates).toBe("function");
    expect(typeof publicApi.setOperatorAlertHook).toBe("function");
    expect(typeof publicApi.REPORT_TEMPLATE_KEYS).toBe("object");
  });
});
