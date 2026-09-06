// Reporter notifications (plan 08 §2.2 — Art. 16(4) receipt + Art. 16(5)
// decision). Delivered over BOTH existing transports:
//   - the in-app notification (NotificationHandler, best-effort, respects prefs)
//   - transactional email (guaranteed channel for the logged-out-visible
//     confirmation the article expects)
//
// All copy comes from the deployment template map via `report-templates.ts`
// (neutral fallback in core; NO legal/jurisdiction text here). Every send is
// best-effort: a transport failure must never break report creation or the
// lifecycle transition.

import type { Env } from "../env.js";
import { getLogger } from "./logger.js";
import {
  REPORT_TEMPLATE_KEYS,
  resolveReportTemplate,
  type ReportTemplateKey,
} from "./report-templates.js";

/** The reporter identity + routing the notification transports need. */
export interface ReporterNotificationTarget {
  readonly reportId: string;
  readonly reporterUserId: string;
  /** Recipient email; when absent the email leg is skipped (in-app still runs). */
  readonly reporterEmail?: string | null;
  /** Tenant scope for the in-app notification; when absent the in-app leg is skipped. */
  readonly tenantId?: string | null;
}

/** Terminal outcome for the decision notice (Art. 16(5)). */
export type ReportDecisionOutcome = "actioned" | "rejected";

async function deliver(
  target: ReporterNotificationTarget,
  templateKey: ReportTemplateKey,
  env: Env,
): Promise<void> {
  const logger = getLogger();
  const { title, body } = resolveReportTemplate(templateKey, {
    reportId: target.reportId,
  });

  // 1. In-app notification (best-effort; needs a tenant scope).
  if (target.tenantId) {
    try {
      const { NotificationHandler } = await import("./notification-handler.js");
      await new NotificationHandler().createNotification(
        target.reporterUserId,
        "SYSTEM",
        title,
        body,
        { reportId: target.reportId, kind: templateKey },
        env,
        target.tenantId,
      );
    } catch (error) {
      logger.error("[ReportNotifications] in-app notification failed", error);
    }
  }

  // 2. Transactional email (best-effort; the guaranteed receipt channel).
  if (target.reporterEmail) {
    try {
      const { createEmailProvider, emailProviderConfigFromEnv } = await import(
        "./email-provider.js"
      );
      const provider = createEmailProvider(
        emailProviderConfigFromEnv(env as unknown as Record<string, string>),
      );
      await provider.sendEmail({
        from: env.FROM_EMAIL || "noreply@example.com",
        to: target.reporterEmail,
        subject: title,
        text: body,
      });
    } catch (error) {
      logger.error("[ReportNotifications] receipt/decision email failed", error);
    }
  }
}

/** Art. 16(4) — confirm receipt of a report to its reporter. */
export async function sendReportReceipt(
  target: ReporterNotificationTarget,
  env: Env,
): Promise<void> {
  await deliver(target, REPORT_TEMPLATE_KEYS.RECEIPT, env);
}

/** Art. 16(5) — notify the reporter of the terminal outcome. */
export async function sendReportDecision(
  target: ReporterNotificationTarget,
  outcome: ReportDecisionOutcome,
  env: Env,
): Promise<void> {
  await deliver(
    target,
    outcome === "actioned"
      ? REPORT_TEMPLATE_KEYS.DECISION_ACTIONED
      : REPORT_TEMPLATE_KEYS.DECISION_REJECTED,
    env,
  );
}
