/**
 * Unit Tests: Database Wrapper Helper
 *
 * Verifies that the transparent monitoring Proxy correctly:
 *   - Constructs a DatabaseWrapper with (prisma, env, region)
 *   - Routes model method calls through wrapper.execute with the correct
 *     operation label ("modelName.methodName")
 *   - Passes region, request, userId, and env in the ctx object
 *   - Returns the underlying method's resolved value
 *   - Passes top-level $connect / $disconnect through WITHOUT routing through execute
 *   - Passes other top-level non-model properties as-is
 *   - Returns non-function model properties without wrapping
 *   - getUnwrappedDatabase returns raw prisma without constructing a DatabaseWrapper
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks — must be set up before any module under test is imported.
// ---------------------------------------------------------------------------
const {
  createPrismaMock,
  DatabaseWrapperMock,
  wrapperInstancesCreated,
  executeCalls,
} = vi.hoisted(() => {
  // Track every DatabaseWrapper instance created so tests can assert on it.
  const wrapperInstancesCreated: Array<{
    prisma: any;
    env: any;
    region: string;
    instance: any;
  }> = [];

  // Each call record for wrapper.execute: { fn, ctx }
  const executeCalls: Array<{ fn: () => any; ctx: any }> = [];

  // Fake Prisma object returned by createPrismaForRegion
  const fakePrisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "u1", name: "Alice" }),
      create: vi.fn().mockResolvedValue({ id: "u2", name: "Bob" }),
    },
    post: {
      findMany: vi.fn().mockResolvedValue([{ id: "p1" }]),
      // Non-function property on a model
      modelName: "post",
    },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn().mockResolvedValue([]),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };

  const createPrismaMock = vi.fn().mockReturnValue(fakePrisma);

  class DatabaseWrapperMock {
    prisma: any;
    env: any;
    region: string;

    constructor(prisma: any, env: any, region: string) {
      this.prisma = prisma;
      this.env = env;
      this.region = region;
      wrapperInstancesCreated.push({ prisma, env, region, instance: this });
    }

    getClient() {
      return this.prisma;
    }

    // execute: by default calls fn() and returns the result; also records the ctx.
    execute = vi.fn().mockImplementation(async (fn: () => any, ctx: any) => {
      executeCalls.push({ fn, ctx });
      return fn();
    });
  }

  return {
    createPrismaMock,
    DatabaseWrapperMock,
    wrapperInstancesCreated,
    executeCalls,
  };
});

// ---------------------------------------------------------------------------
// Register the mocks (paths relative to this test file: test/unit/)
// ---------------------------------------------------------------------------
vi.mock("../../src/db", () => ({
  createPrismaForRegion: createPrismaMock,
}));

vi.mock("../../src/lib/database-wrapper", () => ({
  DatabaseWrapper: DatabaseWrapperMock,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are registered.
// ---------------------------------------------------------------------------
import {
  getWrappedDatabase,
  getUnwrappedDatabase,
} from "../../src/lib/database-wrapper-helper.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const TEST_REGION = "EU";

function makeEnv() {
  return {
    DATABASE_URL: "postgresql://test:test@localhost:5432/testdb",
    LOG_LEVEL: "silent",
  } as any;
}

function makeRequest(path = "/api/test") {
  return new Request(`https://api.example.com${path}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("getWrappedDatabase", () => {
  let env: ReturnType<typeof makeEnv>;
  let request: Request;

  beforeEach(() => {
    vi.clearAllMocks();
    wrapperInstancesCreated.length = 0;
    executeCalls.length = 0;
    env = makeEnv();
    request = makeRequest();
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------
  describe("construction", () => {
    it("calls createPrismaForRegion with (region, env)", () => {
      getWrappedDatabase(TEST_REGION, env, request);

      expect(createPrismaMock).toHaveBeenCalledOnce();
      expect(createPrismaMock).toHaveBeenCalledWith(TEST_REGION, env);
    });

    it("constructs a DatabaseWrapper with the prisma returned by createPrismaForRegion, env, and region", () => {
      const fakePrisma = createPrismaMock.getMockImplementation()!();
      // Reset so the above call is not counted.
      createPrismaMock.mockClear();

      getWrappedDatabase(TEST_REGION, env, request);

      expect(wrapperInstancesCreated).toHaveLength(1);
      const { prisma, region } = wrapperInstancesCreated[0];
      expect(prisma).toBe(createPrismaMock.mock.results[0].value);
      expect(region).toBe(TEST_REGION);
    });

    it("returns a Proxy (not the raw prisma object)", () => {
      const fakePrisma = createPrismaMock();
      createPrismaMock.mockClear();

      const db = getWrappedDatabase(TEST_REGION, env, request);

      // The proxy wraps prisma; it should not be the same reference.
      expect(db).not.toBe(fakePrisma);
    });
  });

  // -------------------------------------------------------------------------
  // Model method routing through execute
  // -------------------------------------------------------------------------
  describe("model method proxy", () => {
    it("routes user.findUnique through wrapper.execute", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request, "user-42") as any;

      const result = await db.user.findUnique({ where: { id: "u1" } });

      const wrapper = wrapperInstancesCreated[0].instance;
      expect(wrapper.execute).toHaveBeenCalledOnce();
      // Result comes from the underlying mock method
      expect(result).toEqual({ id: "u1", name: "Alice" });
    });

    it("passes operation label as 'user.findUnique' in ctx", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request, "user-42") as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].ctx.operation).toBe("user.findUnique");
    });

    it("passes operation label as 'user.create' for a different method", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await db.user.create({ data: { name: "Bob" } });

      expect(executeCalls[0].ctx.operation).toBe("user.create");
    });

    it("passes operation label as 'post.findMany' for a different model", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await db.post.findMany({});

      expect(executeCalls[0].ctx.operation).toBe("post.findMany");
    });

    it("ctx.region matches the region passed to getWrappedDatabase", async () => {
      const db = getWrappedDatabase("CN", env, request, "u1") as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls[0].ctx.region).toBe("CN");
    });

    it("ctx.userId matches the userId passed to getWrappedDatabase", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request, "user-99") as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls[0].ctx.userId).toBe("user-99");
    });

    it("ctx.userId is undefined when userId is omitted", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls[0].ctx.userId).toBeUndefined();
    });

    it("ctx.request is the request passed to getWrappedDatabase", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request, "u1") as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls[0].ctx.request).toBe(request);
    });

    it("ctx.env is the env passed to getWrappedDatabase", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request, "u1") as any;

      await db.user.findUnique({ where: { id: "u1" } });

      expect(executeCalls[0].ctx.env).toBe(env);
    });

    it("the underlying model method receives the original arguments", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;
      const args = { where: { id: "u1" } };

      await db.user.findUnique(args);

      // Retrieve the underlying findUnique mock from the fake prisma
      const fakePrisma = createPrismaMock.mock.results[0].value;
      expect(fakePrisma.user.findUnique).toHaveBeenCalledWith(args);
    });

    it("returns the resolved value from the underlying method", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      const result = await db.user.findUnique({ where: { id: "u1" } });

      expect(result).toEqual({ id: "u1", name: "Alice" });
    });

    it("propagates errors thrown by the underlying model method", async () => {
      const fakePrisma = createPrismaMock.mock.results[0]?.value ??
        createPrismaMock();
      const dbError = new Error("DB connection refused");
      fakePrisma.user.findUnique.mockRejectedValueOnce(dbError);

      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await expect(db.user.findUnique({ where: { id: "u1" } })).rejects.toThrow(
        "DB connection refused",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Non-function model properties pass through as-is
  // -------------------------------------------------------------------------
  describe("non-function model property passthrough", () => {
    it("returns a non-function property from a model without routing through execute", () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      // post.modelName is a string, not a function
      const val = db.post.modelName;

      expect(val).toBe("post");
      expect(executeCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Top-level control properties bypass model-proxying
  // -------------------------------------------------------------------------
  describe("$connect and $disconnect bypass the model proxy", () => {
    it("$connect is returned as-is without routing through execute", () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      const connectFn = db.$connect;

      // It should be the raw $connect function (not a proxied version)
      const fakePrisma = wrapperInstancesCreated[0].instance.getClient();
      expect(connectFn).toBe(fakePrisma.$connect);
      // Accessing $connect must NOT have triggered wrapper.execute
      expect(executeCalls).toHaveLength(0);
    });

    it("calling $connect does NOT invoke wrapper.execute", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await db.$connect();

      expect(executeCalls).toHaveLength(0);
    });

    it("$disconnect is returned as-is without routing through execute", () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      const disconnectFn = db.$disconnect;

      const fakePrisma = wrapperInstancesCreated[0].instance.getClient();
      expect(disconnectFn).toBe(fakePrisma.$disconnect);
      expect(executeCalls).toHaveLength(0);
    });

    it("calling $disconnect does NOT invoke wrapper.execute", async () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      await db.$disconnect();

      expect(executeCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Other top-level non-model properties pass through (e.g. $transaction)
  // -------------------------------------------------------------------------
  describe("top-level non-model property passthrough", () => {
    it("$transaction is returned as the raw value from prisma", () => {
      const db = getWrappedDatabase(TEST_REGION, env, request) as any;

      const txFn = db.$transaction;

      const fakePrisma = wrapperInstancesCreated[0].instance.getClient();
      // $transaction is a function on the fake prisma, so it comes back as-is
      // (no model proxy, because the outer proxy guard returns value directly for
      //  anything that is not an object, or is $connect/$disconnect).
      expect(txFn).toBe(fakePrisma.$transaction);
    });
  });
});

// ---------------------------------------------------------------------------
// getUnwrappedDatabase
// ---------------------------------------------------------------------------
describe("getUnwrappedDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wrapperInstancesCreated.length = 0;
    executeCalls.length = 0;
  });

  it("calls createPrismaForRegion with (region, env)", () => {
    const env = makeEnv();
    getUnwrappedDatabase("US", env);

    expect(createPrismaMock).toHaveBeenCalledOnce();
    expect(createPrismaMock).toHaveBeenCalledWith("US", env);
  });

  it("returns the raw prisma client from createPrismaForRegion", () => {
    const env = makeEnv();
    const result = getUnwrappedDatabase("US", env);

    expect(result).toBe(createPrismaMock.mock.results[0].value);
  });

  it("does NOT construct a DatabaseWrapper", () => {
    const env = makeEnv();
    getUnwrappedDatabase("US", env);

    expect(wrapperInstancesCreated).toHaveLength(0);
  });

  it("does NOT route any calls through execute", () => {
    const env = makeEnv();
    getUnwrappedDatabase("US", env);

    expect(executeCalls).toHaveLength(0);
  });
});
