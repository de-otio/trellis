/**
 * M9 — `authMiddleware` honours the session blocklist and per-user epoch.
 *
 * Before this, only `SessionManager.getSession` read `blocked:{hash}` and
 * `sessionepoch:{userId}`; ~32 route files authenticate through
 * `authMiddleware`, which verified the JWT and stopped. A suspension's epoch
 * bump (and any logout-by-blocklist) therefore did nothing on those routes.
 *
 * The KV here is real in-memory storage and the WRITES go through the real
 * `SessionManager.revokeSession` / `revokeAllSessions`, so these tests prove
 * the writer and the `authMiddleware` reader agree on the key formats — not
 * merely that a mock was called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../../src/lib/auth/auth-middleware.js";
import { SessionManager } from "../../../src/lib/session-cookie.js";

const USER = "cabc1234567890abcdefghijk";
const OTHER_USER = "cxyz1234567890abcdefghijk";
const TENANT = "ctnt1234567890abcdefghijk";

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock("../../../src/lib/auth/cognito-jwt", () => ({
  extractBearerToken: (header: string | null) =>
    header?.startsWith("Bearer ") ? header.slice(7) : null,
  verifyJwt: (...args: unknown[]) => mockVerify(...args),
}));

vi.mock("../../../src/db", () => ({
  createPrisma: () => ({ tenantMember: { findMany: vi.fn() } }),
}));

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function throwingKv() {
  return {
    get: vi.fn(async () => {
      throw new Error("KV unreachable");
    }),
    put: vi.fn(),
  };
}

const bearer = (token: string) =>
  new Request("https://api.example.com/api/x", {
    headers: { Authorization: `Bearer ${token}` },
  });

const claims = (over: Record<string, unknown> = {}) => ({
  sub: "sub-1",
  userId: USER,
  activeTenantId: TENANT,
  iat: Math.floor(Date.now() / 1000),
  ...over,
});

describe("authMiddleware — revocation (M9)", () => {
  let kv: ReturnType<typeof memoryKv>;
  let env: any;
  const sm = new SessionManager();

  beforeEach(() => {
    vi.clearAllMocks();
    kv = memoryKv();
    env = { DATABASE_URL: "postgresql://test", SESSION_BLOCKLIST_KV: kv };
    mockVerify.mockResolvedValue(claims());
  });

  it("baseline: a valid, unrevoked token authenticates", async () => {
    const auth = await authMiddleware(bearer("tok-a"), env);
    expect(auth?.userId).toBe(USER);
  });

  it("no KV bound: authenticates (deployment shape, not an outage)", async () => {
    const auth = await authMiddleware(bearer("tok-a"), {
      DATABASE_URL: "postgresql://test",
    } as any);
    expect(auth?.userId).toBe(USER);
  });

  it("no KV bound + SESSION_BLOCKLIST_REQUIRED=true: denies", async () => {
    const auth = await authMiddleware(bearer("tok-a"), {
      DATABASE_URL: "postgresql://test",
      SESSION_BLOCKLIST_REQUIRED: "true",
    } as any);
    expect(auth).toBeNull();
  });

  describe("token blocklist", () => {
    it("a token revoked by SessionManager.revokeSession no longer authenticates", async () => {
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();

      await sm.revokeSession(bearer("tok-a"), env);

      expect(await authMiddleware(bearer("tok-a"), env)).toBeNull();
    });

    it("revoking one token leaves a different token for the same user valid", async () => {
      await sm.revokeSession(bearer("tok-a"), env);
      expect(await authMiddleware(bearer("tok-b"), env)).not.toBeNull();
    });

    it("a KV read failure fails CLOSED", async () => {
      const auth = await authMiddleware(bearer("tok-a"), {
        ...env,
        SESSION_BLOCKLIST_KV: throwingKv(),
      });
      expect(auth).toBeNull();
    });

    it("an invalid token costs no KV read (signature is checked first)", async () => {
      mockVerify.mockRejectedValue(new Error("bad signature"));
      expect(await authMiddleware(bearer("garbage"), env)).toBeNull();
      expect(kv.get).not.toHaveBeenCalled();
    });
  });

  describe("session epoch (revoke all)", () => {
    it("revokeAllSessions kills a token minted before it (end to end)", async () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      mockVerify.mockResolvedValue(claims({ iat: past }));
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();

      await sm.revokeAllSessions(USER, env);

      expect(await authMiddleware(bearer("tok-a"), env)).toBeNull();
    });

    it("a token minted after the revocation is accepted (re-login works)", async () => {
      await sm.revokeAllSessions(USER, env);
      mockVerify.mockResolvedValue(
        claims({ iat: Math.floor(Date.now() / 1000) + 5 }),
      );
      expect(await authMiddleware(bearer("tok-new"), env)).not.toBeNull();
    });

    it("boundary: iat in the same SECOND as the epoch is rejected (cannot be told apart from pre-revoke)", async () => {
      kv.store.set(`sessionepoch:${USER}`, "1700000000500");
      mockVerify.mockResolvedValue(claims({ iat: 1_700_000_000 }));
      expect(await authMiddleware(bearer("tok-a"), env)).toBeNull();
    });

    it("boundary: the next second after the epoch is accepted", async () => {
      kv.store.set(`sessionepoch:${USER}`, "1700000000500");
      mockVerify.mockResolvedValue(claims({ iat: 1_700_000_001 }));
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();
    });

    it("a token with NO iat is revoked by any stored epoch", async () => {
      kv.store.set(`sessionepoch:${USER}`, "1700000000500");
      mockVerify.mockResolvedValue(claims({ iat: undefined }));
      expect(await authMiddleware(bearer("tok-a"), env)).toBeNull();
    });

    it("without a stored epoch an iat-less token is unaffected", async () => {
      mockVerify.mockResolvedValue(claims({ iat: undefined }));
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();
    });

    it("is scoped to one user", async () => {
      kv.store.set(`sessionepoch:${OTHER_USER}`, String(Date.now() + 60_000));
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();
    });

    it("a corrupt stored epoch does not lock the user out", async () => {
      kv.store.set(`sessionepoch:${USER}`, "not-a-number");
      expect(await authMiddleware(bearer("tok-a"), env)).not.toBeNull();
    });

    it("an epoch read failure fails CLOSED even when the blocklist read works", async () => {
      const flaky = {
        get: vi.fn(async (key: string) => {
          if (key.startsWith("sessionepoch:")) throw new Error("KV unreachable");
          return null;
        }),
        put: vi.fn(),
      };
      const auth = await authMiddleware(bearer("tok-a"), {
        ...env,
        SESSION_BLOCKLIST_KV: flaky,
      });
      expect(auth).toBeNull();
    });
  });
});
