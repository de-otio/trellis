/**
 * Unit tests — `lib/workers/delete-account.ts` core (WS-2 T1).
 *
 * The core is tested WITHOUT any AWS shape: fake ports on ctx, no aws-sdk
 * mocks. The AWS entrypoint's batch semantics are covered separately by
 * test/unit/lambda/delete-account-worker.test.ts (behavior comparison).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDeleteUserData } = vi.hoisted(() => ({
  mockDeleteUserData: vi.fn(),
}));

vi.mock("../../../src/lib/services/user-data-deletion.js", () => ({
  deleteUserData: mockDeleteUserData,
}));

import {
  runDeleteAccount,
  type DeleteAccountContext,
} from "../../../src/lib/workers/delete-account.js";

function makeCtx(overrides: Partial<DeleteAccountContext> = {}): DeleteAccountContext & {
  _findUnique: ReturnType<typeof vi.fn>;
  _deleteStaging: ReturnType<typeof vi.fn>;
  _identityDelete: ReturnType<typeof vi.fn>;
} {
  const _findUnique = vi.fn().mockResolvedValue({ email: "user@test.com" });
  const _deleteStaging = vi
    .fn()
    .mockResolvedValue({ requested: 0, failedBatches: 0, truncated: false });
  const _identityDelete = vi.fn().mockResolvedValue(undefined);
  const ctx: DeleteAccountContext = {
    db: { user: { findUnique: _findUnique } } as never,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    identity: { deleteUser: _identityDelete },
    resolvePseudonymSecret: vi.fn().mockResolvedValue("test-secret"),
    deleteStagingObjects: _deleteStaging,
    ...overrides,
  };
  return Object.assign(ctx, { _findUnique, _deleteStaging, _identityDelete });
}

describe("runDeleteAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteUserData.mockResolvedValue({
      posts: 1,
      comments: 2,
      entities: 0,
      mediaStagingKeys: [],
    });
  });

  it("runs the full flow: DB erasure -> staging cleanup -> identity deletion", async () => {
    const keys = ["processing/t/x", "pending/t/y"];
    mockDeleteUserData.mockResolvedValueOnce({ posts: 1, mediaStagingKeys: keys });
    const ctx = makeCtx();

    await runDeleteAccount({ userId: "u1" }, ctx);

    expect(ctx._findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { email: true },
    });
    expect(mockDeleteUserData).toHaveBeenCalledWith(ctx.db, "u1", {
      pseudonymSecret: "test-secret",
    });
    expect(ctx._deleteStaging).toHaveBeenCalledWith(keys);
    expect(ctx._identityDelete).toHaveBeenCalledWith({ email: "user@test.com" });
  });

  it("returns (acks) without deleting when the user is not found", async () => {
    const ctx = makeCtx();
    ctx._findUnique.mockResolvedValueOnce(null);

    await expect(runDeleteAccount({ userId: "gone" }, ctx)).resolves.toBeUndefined();

    expect(mockDeleteUserData).not.toHaveBeenCalled();
    expect(ctx._deleteStaging).not.toHaveBeenCalled();
    expect(ctx._identityDelete).not.toHaveBeenCalled();
  });

  it("swallows identity-deletion failure (best-effort — never a batch failure)", async () => {
    const ctx = makeCtx();
    ctx._identityDelete.mockRejectedValueOnce(new Error("UserNotFoundException"));

    await expect(runDeleteAccount({ userId: "u1" }, ctx)).resolves.toBeUndefined();
    expect(mockDeleteUserData).toHaveBeenCalled();
  });

  it("skips identity deletion when no identity port is wired", async () => {
    const ctx = makeCtx({ identity: undefined });

    await expect(runDeleteAccount({ userId: "u1" }, ctx)).resolves.toBeUndefined();
    expect(mockDeleteUserData).toHaveBeenCalled();
  });

  it("throws on transient DB error (message stays un-acked)", async () => {
    const ctx = makeCtx();
    mockDeleteUserData.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(runDeleteAccount({ userId: "u1" }, ctx)).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("calls deleteUserData exactly once per message", async () => {
    const ctx = makeCtx();
    await runDeleteAccount({ userId: "u1" }, ctx);
    expect(mockDeleteUserData).toHaveBeenCalledTimes(1);
  });

  // ── finding 2: fail-closed pseudonym key ─────────────────────────────────
  describe("pseudonym-secret fail-closed (finding 2)", () => {
    it("THROWS before any deletion when the secret resolves empty", async () => {
      const ctx = makeCtx({
        resolvePseudonymSecret: vi.fn().mockResolvedValue(""),
      });

      await expect(runDeleteAccount({ userId: "u1" }, ctx)).rejects.toThrow(
        /fail-closed/,
      );

      // No lookup, no deletion, no staging cleanup, no identity call.
      expect(ctx._findUnique).not.toHaveBeenCalled();
      expect(mockDeleteUserData).not.toHaveBeenCalled();
      expect(ctx._deleteStaging).not.toHaveBeenCalled();
      expect(ctx._identityDelete).not.toHaveBeenCalled();
    });

    it.each([
      ["whitespace-only (tab+newline)", "\t\n"],
      ["whitespace-only (spaces)", "   "],
      ["null", null],
      ["undefined", undefined],
    ])(
      "THROWS before any deletion when the secret resolves %s (critic F3 boundary)",
      async (_label, value) => {
        const ctx = makeCtx({
          resolvePseudonymSecret: vi.fn().mockResolvedValue(value as never),
        });

        await expect(runDeleteAccount({ userId: "u1" }, ctx)).rejects.toThrow(
          /fail-closed/,
        );

        // No lookup, no deletion, no staging cleanup, no identity call.
        expect(ctx._findUnique).not.toHaveBeenCalled();
        expect(mockDeleteUserData).not.toHaveBeenCalled();
        expect(ctx._deleteStaging).not.toHaveBeenCalled();
        expect(ctx._identityDelete).not.toHaveBeenCalled();
      },
    );

    it("THROWS when the secret provider itself fails (resolution error propagates)", async () => {
      const ctx = makeCtx({
        resolvePseudonymSecret: vi.fn().mockRejectedValue(new Error("SSM down")),
      });

      await expect(runDeleteAccount({ userId: "u1" }, ctx)).rejects.toThrow("SSM down");
      expect(mockDeleteUserData).not.toHaveBeenCalled();
    });

    it("threads the secret to deleteUserData by ARGUMENT (finding 7 — never process.env)", async () => {
      const ctx = makeCtx({
        resolvePseudonymSecret: vi.fn().mockResolvedValue("threaded-secret"),
      });

      await runDeleteAccount({ userId: "u1" }, ctx);

      expect(mockDeleteUserData).toHaveBeenCalledWith(expect.anything(), "u1", {
        pseudonymSecret: "threaded-secret",
      });
    });
  });

  it("logs (not throws) when staging cleanup is incomplete", async () => {
    const ctx = makeCtx();
    ctx._deleteStaging.mockResolvedValueOnce({
      requested: 5,
      failedBatches: 1,
      truncated: false,
    });

    await expect(runDeleteAccount({ userId: "u1" }, ctx)).resolves.toBeUndefined();
    // error, not warn. An Art. 17 erasure that left bytes in the bucket is a
    // compliance failure; at warn it sat below every alerting threshold, which
    // is how "account deletion reports success while media remains" persisted.
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Staging object cleanup incomplete",
      expect.objectContaining({ failedBatches: 1 }),
    );
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      "Staging object cleanup incomplete",
      expect.anything(),
    );
  });

  it("qualifies the completion record when staging cleanup was incomplete", async () => {
    // The failed delete is not the whole defect; the unqualified success line
    // is. "Account deleted" is what an operator — or an Art. 17 response —
    // reads, and it said the same thing whether or not the bytes went away.
    const ctx = makeCtx();
    ctx._deleteStaging.mockResolvedValueOnce({
      requested: 5,
      failedBatches: 1,
      truncated: false,
    });

    await runDeleteAccount({ userId: "u1" }, ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Account deleted",
      expect.objectContaining({ userId: "u1", stagingCleanupIncomplete: true }),
    );
  });

  it("marks the completion record complete when cleanup succeeded", async () => {
    // The other half: a flag that is always true carries no information.
    const ctx = makeCtx();
    await runDeleteAccount({ userId: "u1" }, ctx);

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Account deleted",
      expect.objectContaining({ stagingCleanupIncomplete: false }),
    );
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("treats a truncated run as incomplete, not just a failed batch", async () => {
    // `truncated` fires when the 100-batch circuit breaker cuts the run short:
    // every key past 100_000 was never even submitted. Silent by construction,
    // since no batch "failed".
    const ctx = makeCtx();
    ctx._deleteStaging.mockResolvedValueOnce({
      requested: 100_000,
      failedBatches: 0,
      truncated: true,
    });

    await runDeleteAccount({ userId: "u1" }, ctx);

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Staging object cleanup incomplete",
      expect.objectContaining({ truncated: true }),
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Account deleted",
      expect.objectContaining({ stagingCleanupIncomplete: true }),
    );
  });
});
