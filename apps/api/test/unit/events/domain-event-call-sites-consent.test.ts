/**
 * Unit tests: the consent emission point (plan 034 lane E).
 *
 * `POST /api/user/cross-region-consent` records an append-only consent
 * decision in one transaction — supersede the active row, insert the new one.
 * The domain event goes in that same transaction, so a consent record and the
 * event announcing it cannot disagree.
 *
 * The transaction double stages its writes and commits them only when the
 * callback resolves, so "the row is gone when the transaction aborts" is a
 * property this file can actually observe rather than assume.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/env.js";
import { userRoutes } from "../../../src/lib/routes/user.js";

const mockGetSession = vi.fn();
vi.mock("../../../src/lib/session-cookie", () => ({
  SessionManager: class {
    getSession = mockGetSession;
    setSession = vi.fn();
  },
}));

vi.mock("../../../src/lib/security-headers", () => ({
  SecurityHeaders: class {
    createSecureResponse = (body: string, init: ResponseInit) =>
      new Response(body, init);
  },
}));

vi.mock("../../../src/worker", () => ({
  addCorsHeaders: (res: Response) => res,
}));

vi.mock("../../../src/lib/region-detection", () => ({
  detectRegionSync: () => "EU",
  isValidRegion: (r: string) => ["US", "EU", "CN"].includes(r),
}));

vi.mock("../../../src/lib/database-connection-manager", () => ({
  sharedDatabaseConnectionManager: {},
}));

vi.mock("../../../src/lib/ip-scrubber", () => ({
  getIPAddress: () => "127.0.0.1",
}));

vi.mock("../../../src/lib/audit-composer", () => ({
  createAuditLogger: () => ({ log: () => Promise.resolve() }),
}));

// The real helper just runs the callback with a client; the double does the
// same, handing over this test's fake database.
vi.mock("../../../src/lib/db-query-helper", () => ({
  QueryTimeoutPresets: { USER_FACING: 5000 },
  withQueryTimeoutAndRetry: (
    _mgr: unknown,
    _region: unknown,
    _env: unknown,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn(fakeDb),
}));

interface Written {
  table: string;
  data: Record<string, unknown>;
}

let committed: Written[] = [];
let userRow: Record<string, unknown> | null = null;
let priorConsent: Record<string, unknown> | null = null;
/** When set, the consent INSERT throws — the whole transaction aborts. */
let consentCreateFailure: string | null = null;

const fakeDb = {
  user: { findUnique: async () => userRow },
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    const staged: Written[] = [];
    const tx = {
      consent: {
        findFirst: async () => priorConsent,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          staged.push({ table: "consentUpdate", data });
          return data;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (consentCreateFailure) throw new Error(consentCreateFailure);
          const row = { id: "consent_new", ...data };
          staged.push({ table: "consent", data: row });
          return row;
        },
      },
      domainEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: "de_1", ...data };
          staged.push({ table: "domainEvent", data: row });
          return row;
        },
      },
    };
    const result = await cb(tx);
    committed.push(...staged);
    return result;
  },
};

const env = { SESSION_SECRET: "test-secret-32-characters-long!!" } as Env;

const route = userRoutes.find(
  (r) => r.path === "/api/user/cross-region-consent" && r.method === "POST",
)!;

function consentRequest(consented: boolean) {
  return new Request("https://api.example.com/api/user/cross-region-consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataRegion: "US",
      accessRegion: "EU",
      consented,
    }),
  });
}

const outboxRows = () => committed.filter((w) => w.table === "domainEvent");

describe("consent emission point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    committed = [];
    priorConsent = null;
    consentCreateFailure = null;
    userRow = { dataRegion: "US", personalTenantId: "tenant_personal" };
    mockGetSession.mockResolvedValue({
      userId: "user_1",
      email: "u@example.com",
      role: "END_USER",
      activeTenantId: "tenant_active",
      expiresAt: Date.now() + 3_600_000,
    });
  });

  it("emits consent.granted alongside the consent row", async () => {
    const res = await route.handler(consentRequest(true), env, {} as never);

    expect(res.status).toBe(200);
    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows()[0].data).toMatchObject({
      type: "consent.granted",
      tenantId: "tenant_active",
      subjectKind: "consent",
      subjectId: "consent_new",
    });
  });

  it("emits consent.withdrawn on a withdrawal, naming the superseded row", async () => {
    priorConsent = { id: "consent_old", consented: true, consentedAt: null };

    await route.handler(consentRequest(false), env, {} as never);

    expect(outboxRows()[0].data).toMatchObject({ type: "consent.withdrawn" });
    expect(outboxRows()[0].data.payload).toMatchObject({
      consentId: "consent_new",
      userId: "user_1",
      purpose: "CROSS_REGION",
      supersededConsentId: "consent_old",
    });
  });

  it("carries no regions, no IP and no user agent", async () => {
    await route.handler(consentRequest(true), env, {} as never);

    const serialised = JSON.stringify(outboxRows()[0].data);
    expect(serialised).not.toContain("127.0.0.1");
    // "US"/"EU" are the consent's own regions — they stay in the row, not in
    // the event; a subscriber fetches the consent with a scoped token.
    const payload = outboxRows()[0].data.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("dataRegion");
    expect(payload).not.toHaveProperty("accessRegion");
    expect(payload.fields).toEqual([
      "consented",
      "consentedAt",
      "withdrawnAt",
      "active",
    ]);
  });

  it("falls back to the user's personal tenant when the session has no claim", async () => {
    mockGetSession.mockResolvedValue({
      userId: "user_1",
      email: "u@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3_600_000,
    });

    await route.handler(consentRequest(true), env, {} as never);

    expect(outboxRows()[0].data.tenantId).toBe("tenant_personal");
  });

  it("records the consent and skips the event when no tenant resolves", async () => {
    // `personalTenantId` is nullable for legacy rows. A missing event is
    // recoverable from the append-only consent history; an event scoped to a
    // guessed tenant is not.
    mockGetSession.mockResolvedValue({
      userId: "user_1",
      email: "u@example.com",
      role: "END_USER",
      expiresAt: Date.now() + 3_600_000,
    });
    userRow = { dataRegion: "US", personalTenantId: null };

    const res = await route.handler(consentRequest(true), env, {} as never);

    expect(res.status).toBe(200);
    expect(committed.some((w) => w.table === "consent")).toBe(true);
    expect(outboxRows()).toEqual([]);
  });

  it("leaves NO event behind when the consent transaction aborts", async () => {
    consentCreateFailure = "consent insert exploded";

    const res = await route.handler(consentRequest(true), env, {} as never);

    expect(res.status).toBe(500);
    expect(committed).toEqual([]);
  });
});
