import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaimsCache,
  DEFAULT_CACHE_TTL_SECONDS,
  type CachedClaims,
} from "../../src/lib/auth/claims-cache.js";

const sampleClaims: CachedClaims = {
  userId: "u_clxxx",
  globalRole: "B2B_PARTNER",
  activeTenantId: "t_clyyy",
  tenantSlug: "acme",
  tenantRole: "ADMIN",
  handle: "alice",
};

function makeCache() {
  const send = vi.fn();
  const cache = new ClaimsCache({ send } as any, "test-table");
  return { cache, send };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaimsCache.get", () => {
  it("returns null when DDB has no item", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({ Item: undefined });
    const result = await cache.get("sub-1");
    expect(result).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.TableName).toBe("test-table");
    expect(cmd.input.Key.pk.S).toBe("claims:sub-1");
    expect(cmd.input.Key.sk.S).toBe("meta");
  });

  it("returns cached claims when ttl is in the future", async () => {
    const futureTtl = Math.floor(Date.now() / 1000) + 1800;
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        userId: { S: "u_clxxx" },
        globalRole: { S: "B2B_PARTNER" },
        activeTenantId: { S: "t_clyyy" },
        tenantSlug: { S: "acme" },
        tenantRole: { S: "ADMIN" },
        handle: { S: "alice" },
        ttl: { N: String(futureTtl) },
      },
    });
    expect(await cache.get("sub-1")).toEqual(sampleClaims);
  });

  it("returns null when ttl is in the past (stale entry)", async () => {
    const pastTtl = Math.floor(Date.now() / 1000) - 100;
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        userId: { S: "u_old" },
        globalRole: { S: "B2B_PARTNER" },
        activeTenantId: { S: "t_old" },
        tenantSlug: { S: "old" },
        tenantRole: { S: "MEMBER" },
        handle: { S: "old" },
        ttl: { N: String(pastTtl) },
      },
    });
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("returns null when ttl is missing from the item", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        userId: { S: "u_clxxx" },
      },
    });
    expect(await cache.get("sub-1")).toBeNull();
  });

  it("fills missing string fields with empty strings", async () => {
    const futureTtl = Math.floor(Date.now() / 1000) + 1800;
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        userId: { S: "u_clxxx" },
        globalRole: { S: "END_USER" },
        ttl: { N: String(futureTtl) },
      },
    });
    const result = await cache.get("sub-1");
    expect(result).toEqual({
      userId: "u_clxxx",
      globalRole: "END_USER",
      activeTenantId: "",
      tenantSlug: "",
      tenantRole: "",
      handle: "",
    });
  });
});

describe("ClaimsCache.put", () => {
  it("writes the claims with the default TTL when none specified", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({});
    await cache.put("sub-1", sampleClaims);
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    const expectedTtl = Math.floor(Date.now() / 1000) + DEFAULT_CACHE_TTL_SECONDS;
    expect(parseInt(cmd.input.Item.ttl.N, 10)).toBe(expectedTtl);
    expect(cmd.input.ConditionExpression).toContain("ttl");
  });

  it("uses the provided TTL when given", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({});
    await cache.put("sub-1", sampleClaims, 60);
    const cmd = send.mock.calls[0][0];
    const expectedTtl = Math.floor(Date.now() / 1000) + 60;
    expect(parseInt(cmd.input.Item.ttl.N, 10)).toBe(expectedTtl);
  });

  it("swallows ConditionalCheckFailedException (stale-overwrite protection)", async () => {
    const { cache, send } = makeCache();
    const condErr = new Error("conditional check failed");
    condErr.name = "ConditionalCheckFailedException";
    send.mockRejectedValueOnce(condErr);
    await expect(cache.put("sub-1", sampleClaims)).resolves.toBeUndefined();
  });

  it("rethrows non-conditional errors", async () => {
    const { cache, send } = makeCache();
    send.mockRejectedValueOnce(new Error("network down"));
    await expect(cache.put("sub-1", sampleClaims)).rejects.toThrow("network down");
  });

  it("round-trips: put then get returns the same claims", async () => {
    const { cache, send } = makeCache();
    let storedItem: any = null;
    send.mockImplementation(async (cmd: any) => {
      const ctorName = cmd.constructor.name;
      if (ctorName === "PutItemCommand") {
        storedItem = cmd.input.Item;
        return {};
      }
      if (ctorName === "GetItemCommand") {
        return { Item: storedItem };
      }
      return {};
    });
    await cache.put("sub-1", sampleClaims, 600);
    const result = await cache.get("sub-1");
    expect(result).toEqual(sampleClaims);
  });
});

describe("ClaimsCache.getActiveTenantPreference", () => {
  it("returns null when DDB has no item", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({ Item: undefined });
    expect(await cache.getActiveTenantPreference("sub-1")).toBeNull();
  });

  it("returns null when activeTenantId is missing", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
      },
    });
    expect(await cache.getActiveTenantPreference("sub-1")).toBeNull();
  });

  it("returns the activeTenantId even when ttl is in the past", async () => {
    const pastTtl = Math.floor(Date.now() / 1000) - 100;
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        activeTenantId: { S: "t_chosen" },
        ttl: { N: String(pastTtl) },
      },
    });
    expect(await cache.getActiveTenantPreference("sub-1")).toBe("t_chosen");
  });

  it("returns the activeTenantId for a fresh entry", async () => {
    const futureTtl = Math.floor(Date.now() / 1000) + 1800;
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({
      Item: {
        pk: { S: "claims:sub-1" },
        sk: { S: "meta" },
        activeTenantId: { S: "t_chosen" },
        ttl: { N: String(futureTtl) },
      },
    });
    expect(await cache.getActiveTenantPreference("sub-1")).toBe("t_chosen");
  });
});

describe("ClaimsCache.invalidate", () => {
  it("issues a DeleteItemCommand on the right key", async () => {
    const { cache, send } = makeCache();
    send.mockResolvedValueOnce({});
    await cache.invalidate("sub-1");
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe("DeleteItemCommand");
    expect(cmd.input.Key.pk.S).toBe("claims:sub-1");
    expect(cmd.input.Key.sk.S).toBe("meta");
  });
});
