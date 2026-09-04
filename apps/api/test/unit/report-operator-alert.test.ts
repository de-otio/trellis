/**
 * Unit Tests: operator-alert hook (compliance plan 08 §2.2 — M1 clock).
 *
 * ILLEGAL_PRIORITY / ILLEGAL route to the operator; POLICY_VIOLATION / FEEDBACK
 * do not. The hook is injectable; the default is best-effort (never throws).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  routingClassAlertsOperator,
  getOperatorAlertHook,
  setOperatorAlertHook,
  __resetOperatorAlertHookForTests,
} from "../../src/lib/report-operator-alert.js";

afterEach(() => __resetOperatorAlertHookForTests());

describe("routingClassAlertsOperator", () => {
  it("is true only for the ILLEGAL_* routing classes", () => {
    expect(routingClassAlertsOperator("ILLEGAL_PRIORITY")).toBe(true);
    expect(routingClassAlertsOperator("ILLEGAL")).toBe(true);
    expect(routingClassAlertsOperator("POLICY_VIOLATION")).toBe(false);
    expect(routingClassAlertsOperator("FEEDBACK")).toBe(false);
  });
});

describe("operator-alert hook injection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the injected hook once set", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    setOperatorAlertHook(spy);
    await getOperatorAlertHook()(
      {
        reportId: "r1",
        routingClass: "ILLEGAL_PRIORITY",
        categoryKey: "illegal-priority",
        resourceType: "media",
        resourceId: "m1",
      },
      {} as Env,
    );
    expect(spy).toHaveBeenCalledOnce();
  });

  it("default hook is best-effort: no MODERATOR_EMAILS => resolves (warn-log only)", async () => {
    await expect(
      getOperatorAlertHook()(
        {
          reportId: "r1",
          routingClass: "ILLEGAL",
          categoryKey: "illegal-content",
          resourceType: "post",
          resourceId: "p1",
        },
        {} as Env,
      ),
    ).resolves.toBeUndefined();
  });
});
