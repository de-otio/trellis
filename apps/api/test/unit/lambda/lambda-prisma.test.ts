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

const { mockGetSecret, PoolMock, PrismaPgMock, PrismaClientMock } = vi.hoisted(
  () => ({
    mockGetSecret: vi.fn(),
    PoolMock: vi.fn(),
    PrismaPgMock: vi.fn(),
    PrismaClientMock: vi.fn(),
  }),
);

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: PrismaPgMock }));
vi.mock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));
vi.mock("@aws-lambda-powertools/parameters/secrets", () => ({
  getSecret: mockGetSecret,
}));
vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
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
    mockGetSecret.mockResolvedValue(SECRET);
    process.env.DB_SECRET_ARN = "arn:secret";
    delete process.env.LAMBDA_DATABASE_POOL_MAX;
    delete process.env.LAMBDA_DATABASE_CONNECT_TIMEOUT_MS;
    delete process.env.LAMBDA_DATABASE_PROXY_HOST;
    delete process.env.LAMBDA_DATABASE_BREAKER_THRESHOLD;
    delete process.env.LAMBDA_DATABASE_BREAKER_COOLDOWN_MS;
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
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
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
