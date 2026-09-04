/**
 * Unit Tests: Statement of Reasons (plan 08 §2.4 / §5).
 *
 * - params NEVER carry raw classifier output (sanitized defensively).
 * - suppressed=true WRITES the record but does NOT deliver (non-tip-off).
 * - a normal statement writes AND delivers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import {
  sanitizeStatementParams,
  writeStatementOfReasons,
  setStatementDelivery,
  __resetStatementDeliveryForTests,
  FORBIDDEN_STATEMENT_PARAM_KEYS,
  type StatementOfReasonsDb,
} from "../../../src/lib/compliance/statement-of-reasons.js";

const env = { DEFAULT_REGION: "EU" } as unknown as Env;

function mockDb(): { db: StatementOfReasonsDb; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (args: any) => ({
    id: "sor1",
    suppressed: args.data.suppressed,
  }));
  return { db: { statementOfReasons: { create } } as any, create };
}

describe("sanitizeStatementParams", () => {
  it("strips every forbidden raw-classifier key", () => {
    const out = sanitizeStatementParams({
      policyRef: "4.4",
      labels: [{ category: "x", confidence: 0.9 }],
      confidence: 0.9,
      decision: "quarantine",
      provider: "openai",
      blockClass: "illegal-suspected",
      category: "sexual/minors",
    });
    expect(out).toEqual({ policyRef: "4.4" });
    for (const k of FORBIDDEN_STATEMENT_PARAM_KEYS) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("is case-insensitive on forbidden keys", () => {
    expect(sanitizeStatementParams({ Confidence: 0.9, LABELS: [], keep: 1 })).toEqual({
      keep: 1,
    });
  });

  it("returns undefined for empty/non-object input", () => {
    expect(sanitizeStatementParams(null)).toBeUndefined();
    expect(sanitizeStatementParams({})).toBeUndefined();
    expect(sanitizeStatementParams({ confidence: 1 })).toBeUndefined();
  });
});

describe("writeStatementOfReasons", () => {
  beforeEach(() => __resetStatementDeliveryForTests());
  afterEach(() => __resetStatementDeliveryForTests());

  it("writes with sanitized params — never persists raw classifier output", async () => {
    const { db, create } = mockDb();
    const delivered = vi.fn(async () => {});
    setStatementDelivery(delivered);

    await writeStatementOfReasons(
      db,
      {
        affectedUserId: "u1",
        resourceType: "media",
        resourceId: "m1",
        restriction: "hidden",
        templateKey: "sor.default",
        params: { policyRef: "4.4", labels: ["a"], confidence: 0.99 },
      },
      env,
    );

    const persisted = create.mock.calls[0][0].data;
    expect(persisted.params).toEqual({ policyRef: "4.4" });
    expect(persisted.params).not.toHaveProperty("labels");
    expect(persisted.params).not.toHaveProperty("confidence");
    // Delivered because not suppressed.
    expect(delivered).toHaveBeenCalledTimes(1);
    const deliveredArg = delivered.mock.calls[0][0];
    expect(deliveredArg.params).not.toHaveProperty("confidence");
  });

  it("suppressed=true WRITES the record but does NOT deliver", async () => {
    const { db, create } = mockDb();
    const delivered = vi.fn(async () => {});
    setStatementDelivery(delivered);

    const result = await writeStatementOfReasons(
      db,
      {
        affectedUserId: "u1",
        resourceType: "media",
        resourceId: "m1",
        restriction: "removed",
        templateKey: "sor.csam",
        suppress: { reasonKey: "non-tip-off" },
      },
      env,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.suppressed).toBe(true);
    expect(create.mock.calls[0][0].data.suppressReason).toBe("non-tip-off");
    expect(result.suppressed).toBe(true);
    expect(result.delivered).toBe(false);
    // The load-bearing assertion: NOTHING was delivered.
    expect(delivered).not.toHaveBeenCalled();
  });

  it("a delivery fault never throws into the caller (best-effort)", async () => {
    const { db } = mockDb();
    setStatementDelivery(async () => {
      throw new Error("transport down");
    });
    const result = await writeStatementOfReasons(
      db,
      {
        affectedUserId: "u1",
        resourceType: "post",
        resourceId: "p1",
        restriction: "hidden",
        templateKey: "sor.default",
      },
      env,
    );
    expect(result.delivered).toBe(false);
    expect(result.suppressed).toBe(false);
  });
});
