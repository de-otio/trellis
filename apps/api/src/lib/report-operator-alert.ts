// Operator-alert hook (plan 08 §2.2 item / Phase 1).
//
// When a report routes to `ILLEGAL_PRIORITY` or `ILLEGAL`, the operator
// (founder) must be notified immediately — awareness starts the "expeditious"
// clock (M1). This module is ONLY that hook point: it does NOT implement
// takedown, preservation, or authority filing (those are Lane A2). The default
// hook is best-effort (email to MODERATOR_EMAILS if configured, else a warn
// log); a deployment can inject a richer hook via `setOperatorAlertHook`.
//
// Jurisdiction-neutral: the alert carries the RoutingClass + opaque refs only,
// never legal/category copy.

import type { Env } from "../env.js";
import type { RoutingClass } from "@prisma/client";
import { getLogger } from "./logger.js";

/** The payload handed to the operator-alert hook. Opaque refs, no legal copy. */
export interface OperatorAlert {
  readonly reportId: string;
  readonly routingClass: RoutingClass;
  readonly categoryKey: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export type OperatorAlertHook = (alert: OperatorAlert, env: Env) => Promise<void>;

/** RoutingClasses that trigger an immediate operator alert (M1 awareness clock). */
export function routingClassAlertsOperator(routingClass: RoutingClass): boolean {
  return routingClass === "ILLEGAL_PRIORITY" || routingClass === "ILLEGAL";
}

let injectedHook: OperatorAlertHook | undefined;

/** Deployment injects a concrete operator-alert hook at startup. */
export function setOperatorAlertHook(hook: OperatorAlertHook): void {
  injectedHook = hook;
}

/** Test-only: clear the injected hook. */
export function __resetOperatorAlertHookForTests(): void {
  injectedHook = undefined;
}

/**
 * Default hook: email the configured moderator/operator addresses if present,
 * otherwise warn-log so an un-wired deploy is loud rather than silent. Neutral
 * copy only — the alert references the report, not the (jurisdiction-specific)
 * meaning of its category.
 */
const defaultOperatorAlertHook: OperatorAlertHook = async (alert, env) => {
  const logger = getLogger();
  const anyEnv = env as unknown as {
    MODERATOR_EMAILS?: string | string[];
    FROM_EMAIL?: string;
  };
  const recipients = anyEnv.MODERATOR_EMAILS;
  const list = Array.isArray(recipients)
    ? recipients
    : typeof recipients === "string"
      ? recipients.split(",").map((e) => e.trim()).filter(Boolean)
      : [];

  if (list.length === 0) {
    logger.warn(
      "[ReportOperatorAlert] Priority report needs operator attention but no " +
        "MODERATOR_EMAILS configured — logging only",
      {
        reportId: alert.reportId,
        routingClass: alert.routingClass,
        resourceType: alert.resourceType,
      },
    );
    return;
  }

  try {
    const { createEmailProvider, emailProviderConfigFromEnv } = await import(
      "./email-provider.js"
    );
    const provider = createEmailProvider(
      emailProviderConfigFromEnv(env as unknown as Record<string, string>),
    );
    await provider.sendEmail({
      from: anyEnv.FROM_EMAIL || "noreply@example.com",
      to: list,
      // Neutral subject/body: report id + routing class only. No category label,
      // no reported content — this is a triage ping, not a case file.
      subject: `Priority report needs review (${alert.routingClass})`,
      text:
        `A report has been filed that requires operator attention.\n\n` +
        `Report ID: ${alert.reportId}\n` +
        `Routing class: ${alert.routingClass}\n` +
        `Resource: ${alert.resourceType}\n\n` +
        `Review it in the moderation surface. Do not act on this email alone.`,
    });
    logger.info("[ReportOperatorAlert] Operator alerted for priority report", {
      reportId: alert.reportId,
      routingClass: alert.routingClass,
    });
  } catch (error) {
    // Best-effort: an alert failure must never break report creation.
    logger.error("[ReportOperatorAlert] Failed to send operator alert", error);
  }
};

/** Returns the injected hook, or the fail-safe default. */
export function getOperatorAlertHook(): OperatorAlertHook {
  return injectedHook ?? defaultOperatorAlertHook;
}
