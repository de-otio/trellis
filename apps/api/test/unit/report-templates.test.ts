/**
 * Unit Tests: reporter-notification templates (compliance plan 08 §2.2/§3.3).
 *
 * Template-KEY indirection: neutral core fallback, deployment override, and
 * `{param}` interpolation. Core must ship NO jurisdiction/legal copy — only a
 * neutral acknowledgement.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  REPORT_TEMPLATE_KEYS,
  resolveReportTemplate,
  setReportTemplates,
  __resetReportTemplatesForTests,
} from "../../src/lib/report-templates.js";

afterEach(() => __resetReportTemplatesForTests());

describe("resolveReportTemplate — neutral fallback", () => {
  it("resolves the receipt template and interpolates {reportId}", () => {
    const t = resolveReportTemplate(REPORT_TEMPLATE_KEYS.RECEIPT, {
      reportId: "rep-42",
    });
    expect(t.title).toBeTruthy();
    expect(t.body).toContain("rep-42");
    expect(t.body).not.toContain("{reportId}");
  });

  it("has distinct actioned vs rejected decision copy", () => {
    const actioned = resolveReportTemplate(
      REPORT_TEMPLATE_KEYS.DECISION_ACTIONED,
      { reportId: "r1" },
    );
    const rejected = resolveReportTemplate(
      REPORT_TEMPLATE_KEYS.DECISION_REJECTED,
      { reportId: "r1" },
    );
    expect(actioned.body).not.toBe(rejected.body);
  });

  it("the neutral fallback carries no obvious jurisdiction/legal strings", () => {
    const all = Object.values(REPORT_TEMPLATE_KEYS)
      .map((k) => {
        const t = resolveReportTemplate(k, { reportId: "x" });
        return `${t.title} ${t.body}`;
      })
      .join(" ")
      .toLowerCase();
    for (const marker of ["bka", "§", "stgb", "dsa", "germany", "qualzucht"]) {
      expect(all).not.toContain(marker);
    }
  });
});

describe("resolveReportTemplate — deployment override", () => {
  it("prefers the injected template over the fallback", () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.RECEIPT]: {
        title: "Eingang bestätigt",
        body: "Wir haben deine Meldung {reportId} erhalten.",
      },
    });
    const t = resolveReportTemplate(REPORT_TEMPLATE_KEYS.RECEIPT, {
      reportId: "rep-7",
    });
    expect(t.title).toBe("Eingang bestätigt");
    expect(t.body).toBe("Wir haben deine Meldung rep-7 erhalten.");
  });

  it("falls back to neutral copy for keys the injected map omits", () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.RECEIPT]: { title: "x", body: "y" },
    });
    // DECISION_ACTIONED not injected -> neutral fallback still resolves.
    const t = resolveReportTemplate(REPORT_TEMPLATE_KEYS.DECISION_ACTIONED, {
      reportId: "r1",
    });
    expect(t.title).toBeTruthy();
    expect(t.body).toContain("r1");
  });
});
