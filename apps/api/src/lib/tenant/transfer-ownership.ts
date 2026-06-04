/**
 * Atomic OWNER swap.
 *
 * Single-OWNER invariant: exactly one TenantMember row in a tenant has
 * `role = OWNER`. Promotion to OWNER happens only here (and at tenant
 * creation). Both updates run in one Prisma transaction so a mid-transaction
 * failure cannot leave the tenant with zero or two owners.
 *
 * Cache invalidation for both members runs after the transaction commits and
 * is best-effort: a DDB hiccup must not roll back the role swap.
 */

import type { PrismaClient, TenantMember } from "@prisma/client";

export type TransferResult =
  | { ok: true; oldOwnerCognitoSub: string | null; newOwnerCognitoSub: string | null }
  | { ok: false; code: "NOT_MEMBER" | "ALREADY_OWNER" | "INACTIVE" | "OWNER_NOT_FOUND" };

interface TransferOwnershipInput {
  db: PrismaClient;
  tenantId: string;
  currentOwnerUserId: string;
  newOwnerUserId: string;
}

/**
 * Validates the candidate, then swaps roles in one transaction.
 *
 * Validation runs inside the transaction so a concurrent `member-remove`
 * cannot race with us — once we've SELECTed the candidate's status as ACTIVE,
 * the subsequent UPDATE is part of the same TX and either both rows commit
 * or neither does.
 */
export async function transferOwnership(
  input: TransferOwnershipInput,
): Promise<TransferResult> {
  const { db, tenantId, currentOwnerUserId, newOwnerUserId } = input;

  if (currentOwnerUserId === newOwnerUserId) {
    return { ok: false, code: "ALREADY_OWNER" };
  }

  return db.$transaction(async (tx): Promise<TransferResult> => {
    const candidate = await tx.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: newOwnerUserId } },
      select: { status: true, user: { select: { cognitoSub: true } } },
    });

    if (!candidate) return { ok: false, code: "NOT_MEMBER" };
    if (candidate.status !== "ACTIVE") return { ok: false, code: "INACTIVE" };

    const currentOwner = await tx.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: currentOwnerUserId } },
      select: { role: true, user: { select: { cognitoSub: true } } },
    });

    if (!currentOwner || currentOwner.role !== "OWNER") {
      return { ok: false, code: "OWNER_NOT_FOUND" };
    }

    await tx.tenantMember.update({
      where: { tenantId_userId: { tenantId, userId: currentOwnerUserId } },
      data: { role: "ADMIN" },
    });

    await tx.tenantMember.update({
      where: { tenantId_userId: { tenantId, userId: newOwnerUserId } },
      data: { role: "OWNER" },
    });

    return {
      ok: true,
      oldOwnerCognitoSub: currentOwner.user.cognitoSub,
      newOwnerCognitoSub: candidate.user.cognitoSub,
    };
  }) as Promise<TransferResult>;
}

/** Convenience: find the OWNER row for a tenant. Used by self-demotion checks. */
export async function findTenantOwner(
  db: PrismaClient,
  tenantId: string,
): Promise<TenantMember | null> {
  return db.tenantMember.findFirst({
    where: { tenantId, role: "OWNER", status: "ACTIVE" },
  });
}
