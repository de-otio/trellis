/**
 * Unit Tests: Lambda Prisma helper (connection-exhaustion hardening)
 *
 * The Lambda DB path must cap each warm execution environment to a single
 * connection (so burst demand = concurrency, not concurrency × pg-default-10),
 * fail fast on connect, optionally route through an RDS Proxy, and trip a
 * circuit breaker under sustained DB failure. See trellis-internal
 * analysis/db-connection-management/signup-burst-connection-exhaustion.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveSecret, PoolMock, PrismaPgMock, PrismaClientMock } = vi.hoisted(
  () => ({
    mockResolveSecret: vi.fn(),
    // Pool instances need .on (finding-8 error handler) and .end (teardown).
    PoolMock: vi.fn(function (this: { on: unknown; end: unknown }) {
      this.on = vi.fn();
      this.end = vi.fn().mockResolvedValue(undefined);
    }),
    PrismaPgMock: vi.fn(),
    PrismaClientMock: vi.fn(),
  }),
);

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: PrismaPgMock }));
vi.mock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));
// WS-2 §5.3: the DB secret now resolves via the ONE foundation secrets port.
vi.mock("@de-otio/saas-foundation/secrets", () => ({
  resolveSecret: mockResolveSecret,
  secretRef: vi.fn((arn: string) => ({ arn })),
  SecretCache: class {
    private store = new Map<string, Buffer>();
    get(key: string) {
      return this.store.get(key) ?? null;
    }
    set(key: string, value: Buffer) {
      this.store.set(key, value);
    }
    invalidate(key: string) {
      this.store.delete(key);
    }
    clear() {
      this.store.clear();
    }
  },
}));

const SECRET = {
  username: "u",
  password: "p@ss/word",
  host: "db.internal",
  port: 5432,
  dbname: "app",
};

const IMPORT = "../../../src/lib/lambda-prisma.js";

describe("lambda-prisma", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockResolveSecret.mockResolvedValue(Buffer.from(JSON.stringify(SECRET), "utf-8"));
    process.env.DB_SECRET_ARN = "arn:secret";
    delete process.env.LAMBDA_DATABASE_POOL_MAX;
    delete process.env.LAMBDA_DATABASE_CONNECT_TIMEOUT_MS;
    delete process.env.LAMBDA_DATABASE_PROXY_HOST;
    delete process.env.LAMBDA_DATABASE_BREAKER_THRESHOLD;
    delete process.env.LAMBDA_DATABASE_BREAKER_COOLDOWN_MS;
    // Cross-profile DB inputs — cleared so the ARN path (above) is the default
    // and per-test overrides don't leak between cases.
    delete process.env.DATABASE_URL;
    delete process.env.DB_SECRET_USERNAME;
    delete process.env.DB_SECRET_PASSWORD;
    delete process.env.DB_SECRET_HOST;
    delete process.env.DB_SECRET_PORT;
    delete process.env.DB_NAME;
  });

  it("caps the pool at max:1 by default with a fail-fast connect timeout", async () => {
    const { getLambdaPrisma } = await import(IMPORT);
    await getLambdaPrisma();

    expect(PoolMock).toHaveBeenCalledTimes(1);
    const opts = PoolMock.mock.calls[0][0];
    expect(opts.max).toBe(1);
    expect(opts.connectionTimeoutMillis).toBe(2000);
    expect(opts.ssl).toEqual({ rejectUnauthorized: false });

    // PrismaPg must receive the explicit Pool instance, NOT a connection-string
    // config (the only place `max` actually takes effect under @prisma/adapter-pg).
    expect(PrismaPgMock).toHaveBeenCalledTimes(1);
    expect(PrismaPgMock.mock.calls[0][0]).toBe(PoolMock.mock.instances[0]);
  });

  it("honours pool-max and connect-timeout env overrides", async () => {
    process.env.LAMBDA_DATABASE_POOL_MAX = "3";
    process.env.LAMBDA_DATABASE_CONNECT_TIMEOUT_MS = "1500";
    const { getLambdaPrisma } = await import(IMPORT);
    await getLambdaPrisma();

    const opts = PoolMock.mock.calls[0][0];
    expect(opts.max).toBe(3);
    expect(opts.connectionTimeoutMillis).toBe(1500);
  });

  it("connects to the direct instance host when no proxy host is set", async () => {
    const { getLambdaPrisma } = await import(IMPORT);
    await getLambdaPrisma();
    expect(PoolMock.mock.calls[0][0].connectionString).toContain(
      "@db.internal:5432/app",
    );
  });

  it("routes through LAMBDA_DATABASE_PROXY_HOST when set", async () => {
    process.env.LAMBDA_DATABASE_PROXY_HOST = "proxy.internal";
    const { getLambdaPrisma } = await import(IMPORT);
    await getLambdaPrisma();

    const cs = PoolMock.mock.calls[0][0].connectionString;
    expect(cs).toContain("@proxy.internal:5432/app");
    expect(cs).not.toContain("@db.internal");
  });

  it("caches the client across calls (one pool per warm environment)", async () => {
    const { getLambdaPrisma } = await import(IMPORT);
    await getLambdaPrisma();
    await getLambdaPrisma();
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(mockResolveSecret).toHaveBeenCalledTimes(1);
  });

  // ── WS-2 finding 8: DB-password rotation self-heal ────────────────────────
  describe("finding 8 — rotation self-heals in one failed connection, not one TTL", () => {
    const ROTATED = { ...SECRET, password: "rotated-password" };

    it("a 28P01 pool error invalidates the cached secret; the NEXT call rebuilds with the fresh credential", async () => {
      const { getLambdaPrisma } = await import(IMPORT);
      await getLambdaPrisma();
      expect(PoolMock).toHaveBeenCalledTimes(1);

      // Rotation lands behind the resolver…
      mockResolveSecret.mockResolvedValue(
        Buffer.from(JSON.stringify(ROTATED), "utf-8"),
      );
      // …and the pool reports an auth failure on an idle client.
      const poolInstance = PoolMock.mock.instances[0] as unknown as {
        on: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const errorHandler = poolInstance.on.mock.calls.find(
        (c: unknown[]) => c[0] === "error",
      )?.[1] as (err: unknown) => void;
      expect(errorHandler).toBeDefined();
      errorHandler({ code: "28P01", message: "password authentication failed" });

      // Next attempt: fresh resolve + rebuilt pool with the NEW password.
      const client = await getLambdaPrisma();
      expect(client).toBeDefined();
      expect(PoolMock).toHaveBeenCalledTimes(2);
      expect(PoolMock.mock.calls[1][0].connectionString).toContain(
        encodeURIComponent("rotated-password"),
      );
      // The stale pool was torn down best-effort.
      expect(poolInstance.end).toHaveBeenCalled();
    });

    it("a NON-auth pool error does NOT invalidate (no rebuild churn)", async () => {
      const { getLambdaPrisma, invalidateDbCredentialsOnAuthError } = await import(IMPORT);
      await getLambdaPrisma();
      expect(
        invalidateDbCredentialsOnAuthError(new Error("connection reset")),
      ).toBe(false);
      await getLambdaPrisma();
      expect(PoolMock).toHaveBeenCalledTimes(1); // still cached
    });

    it("withLambdaDbBreaker routes a 28P01 into the invalidation", async () => {
      const { getLambdaPrisma, withLambdaDbBreaker } = await import(IMPORT);
      await getLambdaPrisma();
      const authErr = Object.assign(new Error("auth failed"), { code: "28P01" });
      await expect(
        withLambdaDbBreaker(async () => {
          throw authErr;
        }),
      ).rejects.toThrow("auth failed");
      // Invalidated: the next call rebuilds.
      await getLambdaPrisma();
      expect(PoolMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Cross-profile DB credential resolution (worker portability) ───────────
  // The container must boot on Scaleway (no AWS Secrets Manager ARN) as well as
  // AWS. Precedence mirrors env.ts resolveDatabaseUrl: DATABASE_URL → ARN →
  // decomposed DB_SECRET_* env.
  describe("DB credential resolution across deployment profiles", () => {
    it("DATABASE_URL wins verbatim — no Secrets Manager call, no proxy rewrite", async () => {
      process.env.DATABASE_URL = "postgresql://u:p@explicit.host:6543/db";
      process.env.LAMBDA_DATABASE_PROXY_HOST = "proxy.internal"; // must be ignored
      const { getLambdaPrisma } = await import(IMPORT);
      await getLambdaPrisma();

      expect(mockResolveSecret).not.toHaveBeenCalled();
      const cs = PoolMock.mock.calls[0][0].connectionString;
      expect(cs).toBe("postgresql://u:p@explicit.host:6543/db");
      expect(cs).not.toContain("proxy.internal");
    });

    it("decomposed DB_SECRET_* env (Scaleway) builds the string without Secrets Manager", async () => {
      delete process.env.DB_SECRET_ARN; // no ARN on Scaleway
      process.env.DB_SECRET_USERNAME = "sky";
      process.env.DB_SECRET_PASSWORD = "p@ss/word";
      process.env.DB_SECRET_HOST = "10.0.0.5";
      process.env.DB_SECRET_PORT = "5432";
      process.env.DB_NAME = "skybber";
      const { getLambdaPrisma } = await import(IMPORT);
      await getLambdaPrisma();

      expect(mockResolveSecret).not.toHaveBeenCalled();
      const cs = PoolMock.mock.calls[0][0].connectionString;
      // Password is percent-encoded; host/port/db land as given.
      expect(cs).toBe(
        `postgresql://sky:${encodeURIComponent("p@ss/word")}@10.0.0.5:5432/skybber`,
      );
    });

    it("decomposed path defaults port 5432 and db 'trellis' when unset", async () => {
      delete process.env.DB_SECRET_ARN;
      process.env.DB_SECRET_USERNAME = "u";
      process.env.DB_SECRET_PASSWORD = "pw";
      process.env.DB_SECRET_HOST = "h.internal";
      const { getLambdaPrisma } = await import(IMPORT);
      await getLambdaPrisma();
      expect(PoolMock.mock.calls[0][0].connectionString).toBe(
        "postgresql://u:pw@h.internal:5432/trellis",
      );
    });

    it("fails closed when no DB config is set (worker exits rather than boots credential-less)", async () => {
      delete process.env.DB_SECRET_ARN;
      const { getLambdaPrisma } = await import(IMPORT);
      await expect(getLambdaPrisma()).rejects.toThrow(/Database config missing/);
      expect(PoolMock).not.toHaveBeenCalled();
    });

    it("rejects a non-numeric decomposed port (fail-closed validation)", async () => {
      delete process.env.DB_SECRET_ARN;
      process.env.DB_SECRET_USERNAME = "u";
      process.env.DB_SECRET_PASSWORD = "pw";
      process.env.DB_SECRET_HOST = "h.internal";
      process.env.DB_SECRET_PORT = "not-a-port";
      const { getLambdaPrisma } = await import(IMPORT);
      await expect(getLambdaPrisma()).rejects.toThrow(/Invalid DB_SECRET_PORT/);
    });
  });

  describe("withLambdaDbBreaker", () => {
    it("passes results through on success", async () => {
      const { withLambdaDbBreaker } = await import(IMPORT);
      await expect(withLambdaDbBreaker(async () => "ok")).resolves.toBe("ok");
    });

    it("opens after the threshold, then fails fast without invoking fn", async () => {
      process.env.LAMBDA_DATABASE_BREAKER_THRESHOLD = "3";
      const { withLambdaDbBreaker } = await import(IMPORT);

      const boom = vi.fn(async () => {
        throw new Error("connect ETIMEDOUT");
      });
      for (let i = 0; i < 3; i++) {
        await expect(withLambdaDbBreaker(boom, "op")).rejects.toThrow();
      }
      expect(boom).toHaveBeenCalledTimes(3);

      // Breaker is OPEN — the next call short-circuits (fn NOT invoked again).
      await expect(withLambdaDbBreaker(boom, "op")).rejects.toThrow(
        /Circuit breaker is OPEN/,
      );
      expect(boom).toHaveBeenCalledTimes(3);
    });
  });
});
