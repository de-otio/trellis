/**
 * Unit tests: `ctx.events.emit` — the extension-facing half of the event seam
 * (plan 034 lane E).
 *
 * The claim being tested is a confinement claim, not a happy path: an
 * extension writes events into the tenant core resolved for it, and has no way
 * to write one into any other tenant. The mechanism is `ctx.db.tenant(tid)`'s,
 * reused: `emit(type, payload)` takes no tenant, and the outbox writer demands
 * a branded `TenantId` whose constructor is core-private and is not
 * re-exported through `@de-otio/trellis-extension-api`.
 *
 * Compile-time half of the same claim (it cannot be asserted at runtime,
 * because the code would not compile to run):
 *
 *   ctx.events.emit("walk.created", payload, "tenant_victim")  // TS2554
 *   emitDomainEvent(tx, { tenantId: "tenant_victim", … })      // TS2322
 *
 * `tsc --build` is the gate for both.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { TrellisExtension } from "@de-otio/trellis-extension-api";
import { runWithTenantContext } from "@de-otio/saas-foundation/tenant";
import { createExtensionContext } from "../../../src/lib/extension-context.js";
import { mintTenantId } from "../../../src/lib/mint-tenant-id.js";

const OWN = mintTenantId("tenant_own", "session");
const OTHER = mintTenantId("tenant_other", "session");

function makeExtension(id = "dog"): TrellisExtension {
  return {
    id,
    terminology: { entity: "dog", entityPlural: "dogs" },
    routes: [],
    metadataSchema: z.object({}),
  };
}

const mockEnv = {
  APP_DOMAIN: "example.com",
  APP_URL: "https://api.example.com",
  STAGE: "dev",
  SESSION_SECRET: "super-secret-do-not-expose-to-extensions!!",
} as never;

/** Prisma double that records the rows a committed transaction produced. */
function recordingPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    rows.push(data);
    return { id: `de_${rows.length}`, ...data };
  });
  return {
    rows,
    create,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ domainEvent: { create } }),
    } as never,
  };
}

function ctxFor(
  db: ReturnType<typeof recordingPrisma>,
  tenant?: typeof OWN,
  id = "dog",
) {
  return createExtensionContext(
    makeExtension(id),
    mockEnv,
    db.prisma,
    undefined,
    undefined,
    tenant,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ctx.events.emit", () => {
  it("is always present — core supplies it, so an extension never needs `?.`", () => {
    const db = recordingPrisma();
    expect(typeof ctxFor(db, OWN).events.emit).toBe("function");
  });

  it("writes a row scoped to the extension's OWN tenant", async () => {
    const db = recordingPrisma();

    await ctxFor(db, OWN).events.emit("walk.created", { walkId: "w_1" });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      type: "walk.created",
      tenantId: "tenant_own",
      subjectKind: "extension",
      subjectId: "dog",
      payload: { walkId: "w_1" },
    });
  });

  it("cannot be steered into another tenant by the payload", async () => {
    const db = recordingPrisma();

    // The only channel an extension controls is `payload`. Naming a tenant in
    // it is inert: the row's tenant comes from the closure core built.
    await ctxFor(db, OWN).events.emit("walk.created", {
      tenantId: "tenant_other",
      tenant_id: "tenant_other",
      walkId: "w_1",
    });

    expect(db.rows[0].tenantId).toBe("tenant_own");
    expect(db.rows[0].tenantId).not.toBe("tenant_other");
  });

  it("keeps two contexts' events in their own tenants", async () => {
    const db = recordingPrisma();

    await ctxFor(db, OWN).events.emit("walk.created", { walkId: "w_1" });
    await ctxFor(db, OTHER).events.emit("walk.created", { walkId: "w_2" });

    expect(db.rows.map((r) => r.tenantId)).toEqual([
      "tenant_own",
      "tenant_other",
    ]);
  });

  it("records the emitting extension as the subject", async () => {
    const db = recordingPrisma();

    await ctxFor(db, OWN, "widget").events.emit("thing.happened", {});

    expect(db.rows[0]).toMatchObject({
      subjectKind: "extension",
      subjectId: "widget",
    });
  });

  it("falls back to the ambient tenant when core passed none", async () => {
    const db = recordingPrisma();
    const ctx = ctxFor(db);

    await runWithTenantContext(OWN, async () => {
      await ctx.events.emit("walk.created", { walkId: "w_1" });
    });

    expect(db.rows[0].tenantId).toBe("tenant_own");
  });

  it("fails closed — no tenant anywhere means no row, not a row scoped to nothing", async () => {
    const db = recordingPrisma();

    await expect(
      ctxFor(db).events.emit("walk.created", { walkId: "w_1" }),
    ).rejects.toThrow(/no active tenant/);
    expect(db.rows).toEqual([]);
  });

  it("rejects an empty or oversized type", async () => {
    const db = recordingPrisma();
    const ctx = ctxFor(db, OWN);

    await expect(ctx.events.emit("", {})).rejects.toThrow(/non-empty/);
    await expect(ctx.events.emit("x".repeat(201), {})).rejects.toThrow(
      /at most 200/,
    );
    expect(db.rows).toEqual([]);
  });

  it("wraps a non-object payload rather than rejecting it", async () => {
    // `payload: unknown` is the published signature; refusing a legal value at
    // runtime would be a contract the types do not state.
    const db = recordingPrisma();

    await ctxFor(db, OWN).events.emit("walk.created", "just-a-string");

    expect(db.rows[0].payload).toEqual({ value: "just-a-string" });
  });
});
