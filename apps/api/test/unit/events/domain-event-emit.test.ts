/**
 * Unit tests: `emitDomainEvent` — the outbox writer (plan 034 lane E).
 *
 * The property under test is transactional, so the double is a transaction
 * double, not a spy: `stagingDb` buffers every write made through the `tx` it
 * hands the callback and only "commits" them when the callback RESOLVES. A
 * callback that throws leaves the buffer discarded, exactly as a rolled-back
 * Postgres transaction leaves no rows. A test written against a plain
 * `vi.fn()` would report "create was called" for a transaction that aborted,
 * which is the failure mode this lane exists to prevent.
 */

import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  emitDomainEvent,
  MINIMISED_PAYLOAD_NOTE,
  type NewDomainEvent,
} from "../../../src/lib/events/emit.js";
import { mintTenantId } from "../../../src/lib/mint-tenant-id.js";

interface Written {
  table: string;
  data: Record<string, unknown>;
}

/**
 * A Prisma-shaped double with real commit/rollback semantics.
 * `committed` holds only what survived a transaction.
 */
function stagingDb() {
  const committed: Written[] = [];

  const makeTx = (staged: Written[]) => {
    const table = (name: string) => ({
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `${name}_${staged.length + 1}`, ...data };
        staged.push({ table: name, data: row });
        return row;
      },
    });
    return {
      domainEvent: table("domainEvent"),
      post: table("post"),
    } as unknown as Prisma.TransactionClient;
  };

  return {
    committed,
    async $transaction<T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      const staged: Written[] = [];
      const result = await fn(makeTx(staged)); // a throw here skips the commit
      committed.push(...staged);
      return result;
    },
  };
}

const TENANT = mintTenantId("tenant_alpha", "session");

function event(overrides: Partial<NewDomainEvent> = {}): NewDomainEvent {
  return {
    type: "post.published",
    tenantId: TENANT,
    subjectKind: "post",
    subjectId: "post_1",
    payload: { postId: "post_1", fields: ["text"] },
    ...overrides,
  };
}

describe("emitDomainEvent", () => {
  it("writes one outbox row with the tenant, subject and payload it was given", async () => {
    const db = stagingDb();

    await db.$transaction(async (tx) => {
      await emitDomainEvent(tx, event());
    });

    expect(db.committed).toHaveLength(1);
    expect(db.committed[0].table).toBe("domainEvent");
    expect(db.committed[0].data).toMatchObject({
      type: "post.published",
      tenantId: "tenant_alpha",
      subjectKind: "post",
      subjectId: "post_1",
      payload: { postId: "post_1", fields: ["text"] },
    });
  });

  it("leaves NO row behind when the surrounding transaction rolls back", async () => {
    const db = stagingDb();

    await expect(
      db.$transaction(async (tx) => {
        await tx.post.create({ data: { id: "post_1", text: "…" } });
        await emitDomainEvent(tx, event());
        // Anything after the emit can still fail — a constraint, a timeout, a
        // later write in the same mutation. The event must go with it.
        throw new Error("mutation failed after the event was staged");
      }),
    ).rejects.toThrow("mutation failed after the event was staged");

    expect(db.committed).toEqual([]);
  });

  it("propagates an outbox failure instead of swallowing it", async () => {
    // A best-effort outbox would let the mutation commit without its event,
    // which is the divergence the outbox exists to prevent. It must throw.
    const exploding = {
      domainEvent: {
        create: async () => {
          throw new Error("unique violation");
        },
      },
    } as unknown as Prisma.TransactionClient;

    await expect(emitDomainEvent(exploding, event())).rejects.toThrow(
      "unique violation",
    );
  });

  it("copies the payload rather than storing the caller's object", async () => {
    const db = stagingDb();
    const payload: Record<string, unknown> = { postId: "post_1" };

    await db.$transaction(async (tx) => {
      await emitDomainEvent(tx, event({ payload }));
    });
    payload.postId = "mutated-after-the-write";

    expect(
      (db.committed[0].data.payload as Record<string, unknown>).postId,
    ).toBe("post_1");
  });

  it("states the minimised-payload posture in one sentence", () => {
    // Load-bearing prose: the erasure posture of this table is "ids and
    // changed field names only". If a future change puts personal data in a
    // payload, this constant is what has to be rewritten — deliberately, in
    // the same diff.
    expect(MINIMISED_PAYLOAD_NOTE).toMatch(/ids and changed field names only/);
  });
});
