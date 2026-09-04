/**
 * Plan 034 F-6 — `ctx.events.emit` driven through the real extension route.
 *
 * `cross-lane-seams.test.ts` asserts the composition at the context level and
 * reads the wrapper's call shape off the source. This file closes the last gap
 * between the two: it builds a route with `wrapExtensionRoute`, calls its
 * `handler` with an authenticated session on a **stock env** — no
 * `TENANT_SCOPE_MODE`, no ambient tenant context — and checks the row the
 * handler's `ctx.events.emit` actually wrote.
 *
 * That is the exact scenario that used to 500: the wrapper built the context
 * before resolving the tenant, so the emitter fell back to an ambient tenant
 * that only exists when `TENANT_SCOPE_MODE !== "off"`.
 *
 * `extension-context.ts` is deliberately NOT mocked here (unlike
 * `extension-route-wrapper.test.ts`, which stubs it to isolate the HTTP shell)
 * — the whole point is the real emitter reaching a real Prisma double.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** Rows the recording `$transaction` double committed, newest last. */
const rows: Array<Record<string, unknown>> = [];
const userFindUnique = vi.fn();

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {
    acquireClient: () => ({
      client: {
        user: { findUnique: userFindUnique },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            domainEvent: {
              create: async ({ data }: { data: Record<string, unknown> }) => {
                rows.push(data);
                return { id: `de_${rows.length}`, ...data };
              },
            },
          }),
      },
    }),
  },
}));

const getSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = getSession;
  },
}));

// Resolves `undefined` on purpose: `createExtensionContext` then omits
// `ctx.graphService` entirely rather than building a read-only proxy that
// binds methods a stub does not have. The event seam is what is under test.
vi.mock("../../../src/lib/graph", () => ({
  createGraphServiceFromEnv: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: () => "EU",
}));

import { wrapExtensionRoute } from "../../../src/lib/extension-route-wrapper.js";
import type { ExtensionContext, TrellisExtension } from "@de-otio/trellis-extension-api";
import type { Env } from "../../../src/env.js";

/** cuid-shaped, because `resolveTenantId` CUID-validates before minting. */
const SESSION_TENANT = "clm1n2o3p4q5r6s7t8u9v0w1x";
const OTHER_TENANT = "clzz1yy2xx3ww4vv5uu6tt7ss";

const env = { STAGE: "test", SESSION_SECRET: "x".repeat(40) } as unknown as Env;

const ext = {
  id: "dog",
  terminology: { entity: "dog", entityPlural: "dogs" },
  routes: [],
  metadataSchema: z.object({}),
} as unknown as TrellisExtension;

/**
 * A route whose handler emits. `emitted` captures what `emit` resolved or
 * threw, because the wrapper swallows a handler throw into an opaque 500 and
 * the failure mode under test is exactly that 500.
 */
function emittingRoute(payload: Record<string, unknown> = { walkId: "w_1" }) {
  const emitted: { error?: unknown } = {};
  const route = wrapExtensionRoute(ext, {
    path: "walks",
    method: "POST",
    auth: "required",
    handle: async (
      _request: Request,
      _params: Record<string, string>,
      _session: unknown,
      ctx: ExtensionContext,
    ) => {
      try {
        await ctx.events.emit("walk.created", payload);
      } catch (error) {
        emitted.error = error;
        throw error;
      }
      return { status: 201, body: { ok: true } };
    },
  } as never);
  return { route, emitted };
}

async function call(route: ReturnType<typeof wrapExtensionRoute>): Promise<Response> {
  const url = new URL("https://api.example.com/api/ext/dog/walks");
  const request = new Request(url.toString(), {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  return route.handler(request, env, {
    url,
    pathname: url.pathname,
    params: {},
  } as never);
}

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ personalTenantId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an extension route's ctx.events.emit, on a stock deployment", () => {
  it("writes a row scoped to the session's tenant and does not throw", async () => {
    // Stock env: no TENANT_SCOPE_MODE, so `lib/app.ts` establishes no ambient
    // tenant. Before the F-6 fix the emitter had nothing to bind to and the
    // route answered 500 `{"error":"Internal server error"}`.
    expect(process.env.TENANT_SCOPE_MODE ?? "off").toBe("off");
    getSession.mockResolvedValue({
      userId: "u_1",
      email: "u1@example.com",
      activeTenantId: SESSION_TENANT,
    });

    const { route, emitted } = emittingRoute();
    const response = await call(route);

    expect(emitted.error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "walk.created",
      tenantId: SESSION_TENANT,
      subjectKind: "extension",
      subjectId: "dog",
      payload: { walkId: "w_1" },
    });
  });

  it("uses the cookie fallback tenant when the session carries no active-tenant claim", async () => {
    // The (c) branch of `resolveTenantId`: a pure cookie session has no JWT
    // claim, so core reads the user's personal tenant server-side. That value
    // must reach the emitter too, not just `ExtensionSession.tenantId`.
    getSession.mockResolvedValue({ userId: "u_1", email: "u1@example.com" });
    userFindUnique.mockResolvedValue({ personalTenantId: SESSION_TENANT });

    const { route } = emittingRoute();
    const response = await call(route);

    expect(response.status).toBe(201);
    expect(rows[0]).toMatchObject({ tenantId: SESSION_TENANT });
  });

  it("cannot emit into another tenant — the payload names one and is inert", async () => {
    // The confinement property, driven end-to-end rather than at the context
    // level. `emit(type, payload)` takes no tenant, so the only channel the
    // extension controls is the payload; the row's tenant comes from the
    // session core verified.
    getSession.mockResolvedValue({
      userId: "u_1",
      email: "u1@example.com",
      activeTenantId: SESSION_TENANT,
    });

    const { route } = emittingRoute({
      tenantId: OTHER_TENANT,
      tenant_id: OTHER_TENANT,
      walkId: "w_1",
    });
    const response = await call(route);

    expect(response.status).toBe(201);
    expect(rows[0].tenantId).toBe(SESSION_TENANT);
    expect(rows[0].tenantId).not.toBe(OTHER_TENANT);
  });

  it("still fails closed when no tenant can be verified for the caller", async () => {
    // A legacy cookie whose user row is gone: `resolveTenantId` returns
    // undefined, there is no ambient tenant, and the emitter refuses rather
    // than writing a row scoped to nothing. Loud 500 over silent corruption.
    getSession.mockResolvedValue({ userId: "u_gone", email: "gone@example.com" });
    userFindUnique.mockResolvedValue(null);

    const { route, emitted } = emittingRoute();
    const response = await call(route);

    expect(response.status).toBe(500);
    expect(String((emitted.error as Error).message)).toMatch(/no active tenant/);
    expect(rows).toEqual([]);
  });
});
