/**
 * H5: provisioning must never merge a signup onto an existing User matched
 * only by email when that row is bound to another subject, or when the
 * signup is federated (the IdP self-asserts the email).
 */
import { describe, expect, it, vi } from "vitest";
import {
  provisionConfirmedUser,
  ProvisioningIdentityConflictError,
} from "../../../src/lib/identity/provision-confirmed-user.js";

function makeDeps(byEmail: { id: string; subject: string | null } | null) {
  const update = vi.fn();
  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if ("subject" in where) return null;
    if ("email" in where) return byEmail;
    return null;
  });
  const tx = { user: { findFirst, update, create: vi.fn() } };
  const db = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const deps = {
    db,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    claimsCache: { set: vi.fn(), get: vi.fn(), invalidate: vi.fn() },
    computeAnonymousId: vi.fn(async () => "anon"),
    markInvitationRecordUsed: vi.fn(async () => {}),
  };
  return { deps, update, findFirst };
}

const base = {
  sub: "attacker-sub",
  email: "victim@example.com",
  emailVerified: true,
  dateOfBirthRaw: "1990-01-01",
};

describe("provisionConfirmedUser identity conflict (H5)", () => {
  it("refuses a federated signup whose email matches a subject-less row", async () => {
    const { deps, update } = makeDeps({ id: "victim", subject: null });
    await expect(
      provisionConfirmedUser({ ...base, federated: true }, deps as never),
    ).rejects.toBeInstanceOf(ProvisioningIdentityConflictError);
    expect(update).not.toHaveBeenCalled();
    expect(deps.claimsCache.set).not.toHaveBeenCalled();
  });

  it("refuses any signup whose email matches a row bound to a different subject", async () => {
    const { deps, update } = makeDeps({ id: "victim", subject: "victim-sub" });
    await expect(
      provisionConfirmedUser({ ...base, federated: false }, deps as never),
    ).rejects.toBeInstanceOf(ProvisioningIdentityConflictError);
    expect(update).not.toHaveBeenCalled();
  });

  it("the error message does not reveal that the email is registered (Cognito relays it to the client)", async () => {
    const { deps } = makeDeps({ id: "victim", subject: "victim-sub" });
    const err = await provisionConfirmedUser(
      { ...base, federated: true },
      deps as never,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProvisioningIdentityConflictError);
    expect((err as Error).message).not.toMatch(/email|bound|identity|exist|registered/i);
  });

  it("looks up the existing user by subject, not by email OR subject", async () => {
    const { deps, findFirst } = makeDeps({ id: "victim", subject: "victim-sub" });
    await provisionConfirmedUser({ ...base, federated: true }, deps as never).catch(() => {});
    const first = findFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(first.where).toEqual({ subject: "attacker-sub" });
  });
});
