/**
 * Unit Tests: withTenantTx (P3 tenant-scoped transaction wrapper)
 */

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  getCurrentTenantId,
  runWithTenantContext,
  tenantId,
} from "@de-otio/saas-foundation/tenant";
import { withTenantTx } from "../../src/lib/database-connection-manager.js";

// A fake tx whose $executeRaw is a spy; $transaction invokes its callback
// with this object so we can assert the GUC statement and passthrough.
function makeFakePrisma() {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const tx = { $executeRaw: executeRaw };
  const transaction = vi.fn(async (cb: (tx: typeof tx) => unknown) => cb(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { prisma, transaction, tx, executeRaw };
}

describe("withTenantTx", () => {
  it("opens a transaction, sets the RLS GUC transaction-locally, and returns fn's result", async () => {
    const { prisma, transaction, tx, executeRaw } = makeFakePrisma();
    const tid = "tenant-abc";

    const result = await runWithTenantContext(tenantId(tid), () =>
      withTenantTx(prisma, async (passed) => {
        // The wrapper hands fn the tx from $transaction's callback.
        expect(passed).toBe(tx);
        return "fn-result";
      }),
    );

    expect(result).toBe("fn-result");
    expect(transaction).toHaveBeenCalledTimes(1);

    // The first (only) statement is the transaction-local set_config.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join("?")).toContain("set_config('app.current_tenant',");
    // is_local = true → transaction-local (not session-level SET).
    expect(strings.join("")).toContain(", true)");
    // The interpolated value is the ambient tenant id.
    expect(values).toEqual([tid]);
  });

  it("fails closed with no tenant context and never opens a transaction", async () => {
    const { prisma, transaction } = makeFakePrisma();

    // Sanity: outside any runWithTenantContext scope there is no tenant.
    expect(getCurrentTenantId()).toBeUndefined();

    await expect(
      withTenantTx(prisma, async () => "should-not-run"),
    ).rejects.toThrow("no tenant context");

    expect(transaction).not.toHaveBeenCalled();
  });
});
