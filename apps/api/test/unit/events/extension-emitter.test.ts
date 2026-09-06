/**
 * Unit tests: events/extension-emitter.ts — `createExtensionEventEmitter`,
 * the module directly (as opposed to
 * `test/unit/events/extension-event-emitter.test.ts`, which exercises the
 * SAME behavior indirectly through `ctx.events.emit` via
 * `createExtensionContext`). This suite pins the module's own contract in
 * isolation with a minimal `TransactionRunner` double — no extension-context
 * wiring — including the array-payload wrapping edge case the indirect
 * suite does not cover.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithTenantContext } from "@de-otio/saas-foundation/tenant";
import { createExtensionEventEmitter } from "../../../src/lib/events/extension-emitter.js";
import { mintTenantId } from "../../../src/lib/mint-tenant-id.js";

const TENANT = mintTenantId("tenant_a", "session");
const OTHER_TENANT = mintTenantId("tenant_b", "session");

/** A `TransactionRunner` double that records the rows written inside `$transaction`. */
function recordingRunner() {
  const rows: Array<Record<string, unknown>> = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    rows.push(data);
    return { id: `de_${rows.length}`, ...data };
  });
  return {
    rows,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ domainEvent: { create } }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createExtensionEventEmitter", () => {
  it("writes one row per emit, scoped to the tenant it was built with", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);

    await emitter.emit("walk.created", { walkId: "w_1" });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      type: "walk.created",
      tenantId: "tenant_a",
      subjectKind: "extension",
      subjectId: "dog",
      payload: { walkId: "w_1" },
    });
  });

  it("rejects an empty type string", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await expect(emitter.emit("", {})).rejects.toThrow(/non-empty string/);
    expect(db.rows).toEqual([]);
  });

  it("rejects a type over the 200-character routing-key ceiling", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await expect(emitter.emit("x".repeat(201), {})).rejects.toThrow(/at most 200/);
    expect(db.rows).toEqual([]);
  });

  it("accepts a type at exactly the 200-character boundary", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("x".repeat(200), {});
    expect(db.rows).toHaveLength(1);
  });

  it("wraps a non-object payload (string) as { value }", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("thing", "just-a-string");
    expect(db.rows[0].payload).toEqual({ value: "just-a-string" });
  });

  it("wraps an ARRAY payload too — isPlainObject(v) is false for arrays", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("thing", [1, 2, 3]);
    expect(db.rows[0].payload).toEqual({ value: [1, 2, 3] });
  });

  it("wraps null/undefined payloads as { value: null }", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("thing", null);
    await emitter.emit("thing", undefined);
    expect(db.rows[0].payload).toEqual({ value: null });
    expect(db.rows[1].payload).toEqual({ value: null });
  });

  it("passes a plain-object payload through unwrapped", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("thing", { a: 1, b: "two" });
    expect(db.rows[0].payload).toEqual({ a: 1, b: "two" });
  });

  it("falls back to the ambient tenant context when no tenantId is supplied", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma);
    await runWithTenantContext(TENANT, async () => {
      await emitter.emit("thing", {});
    });
    expect(db.rows[0].tenantId).toBe("tenant_a");
  });

  it("fails closed with no row written when there is no tenant anywhere", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma);
    await expect(emitter.emit("thing", {})).rejects.toThrow(/no active tenant/);
    expect(db.rows).toEqual([]);
  });

  it("the explicit tenantId argument takes precedence over the ambient context", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await runWithTenantContext(OTHER_TENANT, async () => {
      await emitter.emit("thing", {});
    });
    expect(db.rows[0].tenantId).toBe("tenant_a");
  });

  it("payload naming a different tenant is inert — the row's tenant comes only from the closure", async () => {
    const db = recordingRunner();
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("thing", { tenantId: "tenant_other" });
    expect(db.rows[0].tenantId).toBe("tenant_a");
  });

  it("each emit runs in its own transaction (not shared across calls)", async () => {
    const db = recordingRunner();
    const transactionSpy = vi.spyOn(db.prisma, "$transaction");
    const emitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    await emitter.emit("a", {});
    await emitter.emit("b", {});
    expect(transactionSpy).toHaveBeenCalledTimes(2);
  });

  it("records a distinct extensionId as subjectId across two emitters sharing one runner", async () => {
    const db = recordingRunner();
    const dogEmitter = createExtensionEventEmitter("dog", db.prisma, TENANT);
    const catEmitter = createExtensionEventEmitter("cat", db.prisma, TENANT);
    await dogEmitter.emit("walk.created", {});
    await catEmitter.emit("nap.started", {});
    expect(db.rows.map((r) => r.subjectId)).toEqual(["dog", "cat"]);
  });
});
