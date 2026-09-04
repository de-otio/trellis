/**
 * Unit Tests: reporter notifications (compliance plan 08 §2.2 — Art. 16(4)/(5)).
 *
 * Delivered over BOTH transports (in-app notification + email), copy from the
 * template resolver, best-effort (a transport failure never throws).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  sendReportReceipt,
  sendReportDecision,
} from "../../src/lib/report-notifications.js";
import {
  REPORT_TEMPLATE_KEYS,
  setReportTemplates,
  __resetReportTemplatesForTests,
} from "../../src/lib/report-templates.js";

const mockCreateNotification = vi.fn();
vi.mock("../../src/lib/notification-handler.js", () => ({
  NotificationHandler: class {
    createNotification = mockCreateNotification;
  },
}));

const mockSendEmail = vi.fn().mockResolvedValue({ messageId: "m1", provider: "test" });
vi.mock("../../src/lib/email-provider.js", () => ({
  createEmailProvider: vi.fn(() => ({ sendEmail: mockSendEmail })),
  emailProviderConfigFromEnv: vi.fn(() => ({ provider: "aws-ses" })),
}));

const mockEnv = { FROM_EMAIL: "noreply@example.com" } as unknown as Env;

beforeEach(() => vi.clearAllMocks());
afterEach(() => __resetReportTemplatesForTests());

describe("sendReportReceipt", () => {
  it("delivers via BOTH the in-app notification and email", async () => {
    await sendReportReceipt(
      {
        reportId: "rep1",
        reporterUserId: "u1",
        reporterEmail: "reporter@example.com",
        tenantId: "tenant1",
      },
      mockEnv,
    );

    expect(mockCreateNotification).toHaveBeenCalledOnce();
    const [userId, type, title, body, data, , tenantId] =
      mockCreateNotification.mock.calls[0];
    expect(userId).toBe("u1");
    expect(type).toBe("SYSTEM");
    expect(body).toContain("rep1");
    expect(data.reportId).toBe("rep1");
    expect(tenantId).toBe("tenant1");

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0].subject).toBe(title);
    expect(mockSendEmail.mock.calls[0][0].to).toBe("reporter@example.com");
  });

  it("skips the in-app leg when no tenant, still emails", async () => {
    await sendReportReceipt(
      {
        reportId: "rep2",
        reporterUserId: "u1",
        reporterEmail: "reporter@example.com",
        tenantId: null,
      },
      mockEnv,
    );
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("skips the email leg when no reporter email, still notifies in-app", async () => {
    await sendReportReceipt(
      { reportId: "rep3", reporterUserId: "u1", reporterEmail: null, tenantId: "t1" },
      mockEnv,
    );
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("never throws when a transport fails (best-effort)", async () => {
    mockCreateNotification.mockRejectedValueOnce(new Error("db down"));
    mockSendEmail.mockRejectedValueOnce(new Error("ses down"));
    await expect(
      sendReportReceipt(
        {
          reportId: "rep4",
          reporterUserId: "u1",
          reporterEmail: "reporter@example.com",
          tenantId: "t1",
        },
        mockEnv,
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the injected deployment template when present", async () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.RECEIPT]: {
        title: "Custom receipt",
        body: "Report {reportId} received.",
      },
    });
    await sendReportReceipt(
      { reportId: "rep5", reporterUserId: "u1", reporterEmail: "r@e.com", tenantId: "t1" },
      mockEnv,
    );
    expect(mockCreateNotification.mock.calls[0][2]).toBe("Custom receipt");
    expect(mockCreateNotification.mock.calls[0][3]).toBe("Report rep5 received.");
  });
});

describe("sendReportDecision", () => {
  it("actioned uses the actioned template", async () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.DECISION_ACTIONED]: {
        title: "Actioned",
        body: "Done {reportId}",
      },
      [REPORT_TEMPLATE_KEYS.DECISION_REJECTED]: {
        title: "Rejected",
        body: "No action {reportId}",
      },
    });
    await sendReportDecision(
      { reportId: "rep6", reporterUserId: "u1", reporterEmail: "r@e.com", tenantId: "t1" },
      "actioned",
      mockEnv,
    );
    expect(mockCreateNotification.mock.calls[0][2]).toBe("Actioned");
  });

  it("rejected uses the rejected template", async () => {
    setReportTemplates({
      [REPORT_TEMPLATE_KEYS.DECISION_ACTIONED]: { title: "Actioned", body: "a" },
      [REPORT_TEMPLATE_KEYS.DECISION_REJECTED]: { title: "Rejected", body: "b" },
    });
    await sendReportDecision(
      { reportId: "rep7", reporterUserId: "u1", reporterEmail: "r@e.com", tenantId: "t1" },
      "rejected",
      mockEnv,
    );
    expect(mockCreateNotification.mock.calls[0][2]).toBe("Rejected");
  });
});
