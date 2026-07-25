/**
 * WS-2 test-critique finding 3 — the REAL HMAC seam.
 *
 * delete-account.test.ts mocks `deleteUserData`, so the worker-core suite
 * never proves the ctx-resolved secret actually reaches the HMAC tombstone
 * boundary. This suite runs `runDeleteAccount` with the REAL
 * `deleteUserData` (nothing from user-data-deletion.js is mocked) against an
 * in-memory Proxy fake of the Prisma client, far enough that:
 *
 *  - the ACCOUNT-report pseudonymization write (step 15c — the HMAC boundary)
 *    carries a tombstone byte-identical to an independently computed
 *    `deleted:` + HMAC-SHA256(secret, userId).slice(0, 32), proving the
 *    context's secret — not a stub, not process.env — keyed the HMAC;
 *  - the erasure completes through the final `user.delete`;
 *  - a whitespace-only secret is rejected by the hardened gate BEFORE any
 *    database access (zero fake-db calls).
 */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  runDeleteAccount,
  type DeleteAccountContext,
} from "../../../src/lib/workers/delete-account.js";

const USER_ID = "cuser00000000000000000001";
const SECRET = "real-seam-tombstone-key-material";

interface DbCall {
  readonly model: string;
  readonly method: string;
  readonly args: unknown;
}

/**
 * Proxy-based Prisma fake: any `db.<model>.<method>(args)` records the call
 * and answers with a benign empty result; `user.findUnique` returns the
 * subject so the worker proceeds. No model list to maintain — the REAL
 * deleteUserData (and the real eraseUserMedia it calls) drive whatever
 * surface they need.
 */
function makeFakeDb(calls: DbCall[]): unknown {
  const respond = (model: string, method: string): unknown => {
    if (model === "user" && method === "findUnique") {
      return { email: "subject@test.example" };
    }
    switch (method) {
      case "findMany":
      case "groupBy":
        return [];
      case "findUnique":
      case "findFirst":
        return null;
      case "deleteMany":
      case "updateMany":
        return { count: 0 };
      case "delete":
      case "update":
      case "create":
        return {};
      case "count":
        return 0;
      default:
        throw new Error(`fake db: unexpected method ${model}.${method}`);
    }
  };
  return new Proxy(
    {},
    {
      get: (_target, model) => {
        if (typeof model !== "string" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get: (_t, method) => {
              if (typeof method !== "string" || method === "then") return undefined;
              return async (args: unknown) => {
                calls.push({ model, method, args });
                return respond(model, method);
              };
            },
          },
        );
      },
    },
  );
}

function makeCtx(
  calls: DbCall[],
  secret: string,
): DeleteAccountContext & { resolver: ReturnType<typeof vi.fn> } {
  const resolver = vi.fn().mockResolvedValue(secret);
  const ctx: DeleteAccountContext = {
    db: makeFakeDb(calls) as never,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    identity: undefined,
    resolvePseudonymSecret: resolver,
    deleteStagingObjects: vi
      .fn()
      .mockResolvedValue({ requested: 0, failedBatches: 0, truncated: false }),
  };
  return Object.assign(ctx, { resolver });
}

describe("runDeleteAccount with the REAL deleteUserData (critic F3)", () => {
  it("the ctx-resolved secret reaches the HMAC tombstone boundary (step 15c write matches an independent HMAC)", async () => {
    const calls: DbCall[] = [];
    const ctx = makeCtx(calls, SECRET);

    await runDeleteAccount({ userId: USER_ID }, ctx);

    // The resolver on the context was the one consumed.
    expect(ctx.resolver).toHaveBeenCalledTimes(1);

    // Step 15c — the HMAC boundary: the ACCOUNT-report pseudonymization write
    // must carry the tombstone keyed by EXACTLY the ctx secret. Computed
    // independently here (node:crypto), matching pseudonymizeUserId's shape.
    const reportUpdate = calls.find(
      (c) => c.model === "report" && c.method === "updateMany",
    );
    expect(reportUpdate).toBeDefined();
    const args = reportUpdate!.args as {
      where: { reportType: string; resourceType: string; resourceId: string };
      data: { resourceId: string };
    };
    expect(args.where).toEqual({
      reportType: "ACCOUNT",
      resourceType: "user",
      resourceId: USER_ID,
    });
    const expectedTombstone =
      "deleted:" +
      createHmac("sha256", SECRET).update(USER_ID).digest("hex").slice(0, 32);
    expect(args.data.resourceId).toBe(expectedTombstone);
    // Sanity: an unkeyed tombstone would look different — the equality above
    // can only hold if THE secret keyed THE HMAC.
    expect(args.data.resourceId).not.toBe(
      "deleted:" + createHmac("sha256", "").update(USER_ID).digest("hex").slice(0, 32),
    );

    // The erasure ran to completion: the final user.delete happened, and the
    // pseudonymization write happened BEFORE it (step 15c precedes step 16).
    const userDeleteIdx = calls.findIndex(
      (c) => c.model === "user" && c.method === "delete",
    );
    expect(userDeleteIdx).toBeGreaterThan(calls.indexOf(reportUpdate!));
  });

  it("a whitespace-only secret is rejected by the REAL seam BEFORE any database access", async () => {
    const calls: DbCall[] = [];
    const ctx = makeCtx(calls, " \t\n ");

    await expect(runDeleteAccount({ userId: USER_ID }, ctx)).rejects.toThrow(
      /fail-closed/,
    );
    expect(calls).toHaveLength(0); // zero db calls — no side-effect of any kind
    expect(ctx.deleteStagingObjects).not.toHaveBeenCalled();
  });

  it("defense in depth: even if the worker gate were bypassed, the REAL deleteUserData refuses a whitespace secret before any deletion", async () => {
    const calls: DbCall[] = [];
    const { deleteUserData } = await import(
      "../../../src/lib/services/user-data-deletion.js"
    );

    await expect(
      deleteUserData(makeFakeDb(calls) as never, USER_ID, {
        pseudonymSecret: "\t\n",
      }),
    ).rejects.toThrow(/refusing erasure/);
    expect(calls).toHaveLength(0);
  });
});
