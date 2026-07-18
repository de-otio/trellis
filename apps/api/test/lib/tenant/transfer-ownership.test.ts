/**
 * Unit tests — transferOwnership.
 *
 * Pure transaction logic: atomic, validation runs inside the TX, the
 * single-OWNER invariant is preserved on every error path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { transferOwnership, findTenantOwner } from "../../../src/lib/tenant/transfer-ownership.js";
import type { PrismaClient } from "@prisma/client";

interface MockTx {
  tenantMember: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
}

function makeMockDb(): { db: PrismaClient; tx: MockTx } {
  const tx: MockTx = {
    tenantMember: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") return fn(tx);
      return fn;
    }),
    tenantMember: tx.tenantMember,
  } as unknown as PrismaClient;
  return { db, tx };
}

describe("transferOwnership", () => {
  let mock: { db: PrismaClient; tx: MockTx };

  beforeEach(() => {
    mock = makeMockDb();
  });

  it("swaps roles atomically when candidate is ACTIVE and current owner is OWNER", async () => {
    mock.tx.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "old-sub" } });

    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "old",
      newOwnerUserId: "new",
    });

    expect(result).toEqual({ ok: true, oldOwnerCognitoSub: "old-sub", newOwnerCognitoSub: "new-sub" });
    expect(mock.tx.tenantMember.update).toHaveBeenCalledTimes(2);
    expect(mock.tx.tenantMember.update).toHaveBeenNthCalledWith(1, {
      where: { tenantId_userId: { tenantId: "t", userId: "old" } },
      data: { role: "ADMIN" },
    });
    expect(mock.tx.tenantMember.update).toHaveBeenNthCalledWith(2, {
      where: { tenantId_userId: { tenantId: "t", userId: "new" } },
      data: { role: "OWNER" },
    });
  });

  it("returns ALREADY_OWNER when same user", async () => {
    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "u",
      newOwnerUserId: "u",
    });
    expect(result).toEqual({ ok: false, code: "ALREADY_OWNER" });
  });

  it("returns NOT_MEMBER when candidate row missing", async () => {
    mock.tx.tenantMember.findUnique.mockResolvedValueOnce(null);
    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "old",
      newOwnerUserId: "ghost",
    });
    expect(result).toEqual({ ok: false, code: "NOT_MEMBER" });
    expect(mock.tx.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns INACTIVE when candidate is SUSPENDED", async () => {
    mock.tx.tenantMember.findUnique.mockResolvedValueOnce({
      status: "SUSPENDED",
      user: { subject: "new-sub" },
    });
    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "old",
      newOwnerUserId: "suspended",
    });
    expect(result).toEqual({ ok: false, code: "INACTIVE" });
    expect(mock.tx.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns OWNER_NOT_FOUND when current owner row missing", async () => {
    mock.tx.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce(null);
    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "missing",
      newOwnerUserId: "new",
    });
    expect(result).toEqual({ ok: false, code: "OWNER_NOT_FOUND" });
    expect(mock.tx.tenantMember.update).not.toHaveBeenCalled();
  });

  it("returns OWNER_NOT_FOUND when 'current owner' is actually ADMIN (drift)", async () => {
    mock.tx.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "ADMIN", user: { subject: "drifted-sub" } });
    const result = await transferOwnership({
      db: mock.db,
      tenantId: "t",
      currentOwnerUserId: "drifted",
      newOwnerUserId: "new",
    });
    expect(result).toEqual({ ok: false, code: "OWNER_NOT_FOUND" });
    expect(mock.tx.tenantMember.update).not.toHaveBeenCalled();
  });

  it("propagates a thrown error from inside the transaction (atomicity)", async () => {
    mock.tx.tenantMember.findUnique
      .mockResolvedValueOnce({ status: "ACTIVE", user: { subject: "new-sub" } })
      .mockResolvedValueOnce({ role: "OWNER", user: { subject: "old-sub" } });
    mock.tx.tenantMember.update.mockRejectedValueOnce(new Error("DB lock"));

    await expect(
      transferOwnership({
        db: mock.db,
        tenantId: "t",
        currentOwnerUserId: "old",
        newOwnerUserId: "new",
      }),
    ).rejects.toThrow("DB lock");
  });
});

describe("findTenantOwner", () => {
  it("queries with role=OWNER and status=ACTIVE", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "owner-row" });
    const db = { tenantMember: { findFirst } } as unknown as PrismaClient;
    const result = await findTenantOwner(db, "t");
    expect(result).toEqual({ id: "owner-row" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: "t", role: "OWNER", status: "ACTIVE" },
    });
  });
});
