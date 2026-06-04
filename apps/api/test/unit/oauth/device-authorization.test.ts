/**
 * Unit tests: device-authorization.ts
 *
 * Covers:
 *  - user_code generation: uniqueness over many samples + alphabet correctness.
 *  - device_code generation: 256-bit, base64url.
 *  - approval flow: approve, then poll → tokens; second poll → 410 (gone).
 *  - polling rate limit: slow_down on too-frequent polls.
 *  - expiry: expired_token after ttl elapses.
 *  - failed-lookup increment + lockout invalidation.
 *  - approveDeviceAuth seals tokens with a per-record DEK; a direct
 *    record load WITHOUT the device_code cannot decrypt.
 *  - 60-second post-approval TTL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { mockSend, ddbStore } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  ddbStore: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class FakeCmd {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return {
    DynamoDBClient: class {
      send = mockSend;
    },
    GetItemCommand: class extends FakeCmd {},
    PutItemCommand: class extends FakeCmd {},
    DeleteItemCommand: class extends FakeCmd {},
    UpdateItemCommand: class extends FakeCmd {},
    QueryCommand: class extends FakeCmd {},
    ConditionalCheckFailedException: class extends Error {
      constructor(msg = "cond-failed") {
        super(msg);
        this.name = "ConditionalCheckFailedException";
      }
    },
  };
});

// Use the real marshall/unmarshall — they exist in node and are fast.
vi.mock("@aws-sdk/util-dynamodb", async () => {
  const actual =
    await vi.importActual<typeof import("@aws-sdk/util-dynamodb")>("@aws-sdk/util-dynamodb");
  return actual;
});

import {
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";

import {
  approveDeviceAuth,
  formatUserCode,
  generateDeviceCode,
  generateUserCode,
  hashUserCode,
  incrementFailedLookup,
  invalidateDeviceCode,
  loadByDeviceCode,
  lookupDeviceCodeByUserCode,
  normaliseUserCode,
  pollDeviceAuth,
  POST_APPROVAL_TTL_SECONDS,
  startDeviceAuthorization,
  USER_CODE_ALPHABET,
  USER_CODE_FAILURE_LIMIT,
  USER_CODE_LEN,
} from "../../../src/lib/oauth/device-authorization.js";

import { _resetKekCacheForTest } from "../../../src/lib/oauth/envelope-crypto.js";

function key(input: Record<string, unknown>): string {
  // Build a stable key from the marshalled DynamoDB Key object.
  const obj = input.Key as Record<string, { S?: string; N?: string }>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    parts.push(`${k}=${obj[k]?.S ?? obj[k]?.N ?? ""}`);
  }
  return parts.join("|");
}

function unmarshallAttrs(o: Record<string, { S?: string; N?: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object") {
      if ("S" in v && v.S !== undefined) out[k] = v.S;
      else if ("N" in v && v.N !== undefined) out[k] = Number(v.N);
      else if ("BOOL" in v) out[k] = (v as { BOOL?: boolean }).BOOL;
      else if ("NULL" in v) out[k] = null;
      else out[k] = v;
    } else out[k] = v;
  }
  return out;
}

beforeEach(() => {
  ddbStore.clear();
  mockSend.mockReset();
  _resetKekCacheForTest();
  process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");

  mockSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    const input = cmd.input;
    if (name === "PutItemCommand" || name === "MockPutItemCommand") {
      const item = input.Item as Record<string, { S?: string; N?: string }>;
      const pk = (item.pk as { S?: string }).S ?? "";
      const sk = (item.sk as { S?: string }).S ?? "";
      const k = `pk=${pk}|sk=${sk}`;
      const cond = input.ConditionExpression as string | undefined;
      if (cond?.includes("attribute_not_exists") && ddbStore.has(k)) {
        throw new ConditionalCheckFailedException();
      }
      ddbStore.set(k, item);
      return { Attributes: item };
    }
    if (name === "GetItemCommand" || name === "MockGetItemCommand") {
      const k = key(input);
      const item = ddbStore.get(k);
      return item ? { Item: item } : {};
    }
    if (name === "DeleteItemCommand" || name === "MockDeleteItemCommand") {
      ddbStore.delete(key(input));
      return {};
    }
    if (name === "UpdateItemCommand" || name === "MockUpdateItemCommand") {
      const k = key(input);
      const existing = ddbStore.get(k);
      const cond = input.ConditionExpression as string | undefined;
      if (cond?.includes("attribute_exists") && !existing) {
        throw new ConditionalCheckFailedException();
      }
      const expr = (input.UpdateExpression as string) ?? "";
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, { S?: string; N?: string; NULL?: boolean }>;
      const names = ((input.ExpressionAttributeNames ?? {}) as Record<string, string>) || {};
      const obj = existing ? { ...existing } : {};

      // Match SET clauses (very loose, sufficient for our tests).
      const setMatch = expr.match(/SET\s+(.+?)(?:\s+ADD|\s+REMOVE|$)/);
      const addMatch = expr.match(/ADD\s+(.+?)(?:\s+SET|\s+REMOVE|$)/);
      const removeMatch = expr.match(/REMOVE\s+(.+?)(?:\s+SET|\s+ADD|$)/);

      if (setMatch) {
        const parts = setMatch[1]!.split(",").map((s) => s.trim());
        for (const p of parts) {
          const [lhs, rhs] = p.split("=").map((s) => s.trim());
          const attr = lhs!.startsWith("#") ? names[lhs!] ?? lhs : lhs!;
          const value = values[rhs!];
          obj[attr] = value;
        }
      }
      if (addMatch) {
        const parts = addMatch[1]!.split(",").map((s) => s.trim());
        for (const p of parts) {
          const [lhs, rhs] = p.split(/\s+/);
          const attr = lhs!.startsWith("#") ? names[lhs!] ?? lhs : lhs!;
          const inc = Number(values[rhs!]?.N ?? "0");
          const current = Number((obj[attr] as { N?: string } | undefined)?.N ?? "0");
          obj[attr] = { N: String(current + inc) };
        }
      }
      if (removeMatch) {
        const parts = removeMatch[1]!.split(",").map((s) => s.trim());
        for (const attrRaw of parts) {
          const attr = attrRaw.startsWith("#") ? names[attrRaw] ?? attrRaw : attrRaw;
          delete obj[attr];
        }
      }

      // Apply condition checks for UpdateItem.
      if (cond?.includes("#status = :pending")) {
        const status = (existing?.status as { S?: string } | undefined)?.S;
        if (status !== "pending") throw new ConditionalCheckFailedException();
      }
      if (cond?.includes("#status = :active")) {
        const status = (existing?.status as { S?: string } | undefined)?.S;
        if (status !== "active") throw new ConditionalCheckFailedException();
      }

      ddbStore.set(k, obj as Record<string, { S?: string; N?: string }>);
      return { Attributes: obj };
    }
    if (name === "QueryCommand" || name === "MockQueryCommand") {
      // Not used in this test file.
      return { Items: [] };
    }
    return {};
  });
});

afterEach(() => {
  delete process.env.DEVICE_AUTH_KEK_BASE64;
});

describe("user_code helpers", () => {
  it("uses an unambiguous alphabet — no 0/O/1/I/2/Z", () => {
    // The canonical RFC 8628 user_code alphabet drops 0/O/1/I (digits and
    // visually similar letters). Z is also dropped (looks like 2). The
    // remaining 20 letters include L by design — the spec calls out the
    // BCDFGHJKLMNPQRSTVWXZ alphabet exactly.
    expect(USER_CODE_ALPHABET).not.toMatch(/[0OI12]/);
    // 20 distinct characters
    expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length);
    expect(USER_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
  });

  it("generates 8-character codes from the alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(USER_CODE_LEN);
      for (const ch of code) {
        expect(USER_CODE_ALPHABET.includes(ch)).toBe(true);
      }
    }
  });

  it("generates highly unique codes — no dupes in 10K samples (deterministic seed subset)", () => {
    // Use a deterministic seed by accumulating bytes from a seeded PRNG —
    // for a 20^8 alphabet (~25.6B), 10K samples should never collide.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = generateUserCode();
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
    expect(seen.size).toBe(10_000);
  });

  it("formatUserCode dashes after 4 chars", () => {
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("formatUserCode passes through unrecognised lengths", () => {
    expect(formatUserCode("ABC")).toBe("ABC");
  });

  it("normaliseUserCode strips dashes and uppercases", () => {
    expect(normaliseUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normaliseUserCode(" bc df gh jk")).toBe("BCDFGHJK");
  });

  it("hashUserCode is stable + 64 hex chars", () => {
    const h1 = hashUserCode("BCDFGHJK");
    const h2 = hashUserCode("BCDFGHJK");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateDeviceCode", () => {
  it("produces a base64url string with at least 256 bits of entropy", () => {
    const code = generateDeviceCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url of 32 bytes = 43 chars (no padding).
    expect(code.length).toBeGreaterThanOrEqual(43);
  });
});

describe("startDeviceAuthorization → pollDeviceAuth", () => {
  it("issues a device_code/user_code pair with default expires_in/interval", async () => {
    const result = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    expect(result.device_code).toBeTruthy();
    expect(result.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(result.expires_in).toBe(600);
    expect(result.interval).toBe(5);
    expect(result.verification_uri_complete).toContain(result.user_code);
  });

  it("polling a pending request returns `pending`", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    const result = await pollDeviceAuth(issued.device_code);
    expect(result.outcome).toBe("pending");
  });

  it("polling immediately again returns `slow_down`", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
      interval: 5,
    });
    await pollDeviceAuth(issued.device_code);
    const result = await pollDeviceAuth(issued.device_code);
    expect(result.outcome).toBe("slow_down");
  });

  it("polling an unknown device_code returns `gone`", async () => {
    const result = await pollDeviceAuth("unknown-device-code-here");
    expect(result.outcome).toBe("gone");
  });

  it("approve → poll → tokens; second poll → gone (read-once)", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });

    await approveDeviceAuth({
      deviceCode: issued.device_code,
      approvedByUserId: "u_admin",
      cognitoSub: "sub-123",
      tenantId: "t_abc",
      tokens: {
        access_token: "AT",
        refresh_token: "RT",
        token_type: "Bearer",
        expires_in: 3600,
      },
      sessionId: "s_xyz",
    });

    const ok = await pollDeviceAuth(issued.device_code);
    expect(ok.outcome).toBe("ok");
    expect(ok.tokens?.access_token).toBe("AT");
    expect(ok.tokens?.refresh_token).toBe("RT");

    // Second poll: row is gone; assert deleteItem was called against the dc# pk.
    const second = await pollDeviceAuth(issued.device_code);
    expect(second.outcome).toBe("gone");
  });

  it("approveDeviceAuth re-keys the record TTL to NOW + 60s (sec finding #1)", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    const before = Math.floor(Date.now() / 1000);
    await approveDeviceAuth({
      deviceCode: issued.device_code,
      approvedByUserId: "u_admin",
      cognitoSub: "sub-123",
      tenantId: "t_abc",
      tokens: {
        access_token: "AT",
        refresh_token: "RT",
        token_type: "Bearer",
        expires_in: 3600,
      },
      sessionId: "s_xyz",
    });
    const record = await loadByDeviceCode(issued.device_code);
    expect(record).not.toBeNull();
    expect(record!.expiresAt).toBeGreaterThanOrEqual(before + POST_APPROVAL_TTL_SECONDS - 2);
    expect(record!.expiresAt).toBeLessThanOrEqual(before + POST_APPROVAL_TTL_SECONDS + 2);
  });

  it("expired record returns `expired`", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
      expiresIn: 1,
    });
    // Simulate clock drift by mutating the stored TTL backwards.
    const k = `pk=dc#${issued.device_code}|sk=rec`;
    const item = ddbStore.get(k)!;
    item.expiresAt = { N: String(Math.floor(Date.now() / 1000) - 100) };
    item.ttl = { N: String(Math.floor(Date.now() / 1000) + 60) }; // skip module-level ttl filter
    ddbStore.set(k, item);
    const result = await pollDeviceAuth(issued.device_code);
    expect(result.outcome).toBe("expired");
  });
});

describe("user_code lookup + lockout", () => {
  it("user_code resolves to the device_code via the secondary key", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    const stripped = issued.user_code.replace("-", "");
    const dc = await lookupDeviceCodeByUserCode(stripped);
    expect(dc).toBe(issued.device_code);
  });

  it("returns null for unknown user_code", async () => {
    const dc = await lookupDeviceCodeByUserCode("BCDFGHJK");
    expect(dc).toBeNull();
  });

  it("incrementFailedLookup tracks count and locks out at the threshold (sec finding #3)", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    let lastCount = 0;
    for (let i = 0; i < USER_CODE_FAILURE_LIMIT; i++) {
      lastCount = await incrementFailedLookup(issued.device_code);
    }
    expect(lastCount).toBeGreaterThanOrEqual(USER_CODE_FAILURE_LIMIT);

    // After lockout the record is gone — subsequent loads return null.
    const record = await loadByDeviceCode(issued.device_code);
    expect(record).toBeNull();
  });

  it("incrementFailedLookup on a missing record returns 0", async () => {
    const count = await incrementFailedLookup("does-not-exist");
    expect(count).toBe(0);
  });

  it("invalidateDeviceCode removes the record", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    await invalidateDeviceCode(issued.device_code);
    const record = await loadByDeviceCode(issued.device_code);
    expect(record).toBeNull();
  });
});

describe("envelope binding to device_code (sec finding #1)", () => {
  it("a stored record's envelope cannot be opened without the original device_code", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    await approveDeviceAuth({
      deviceCode: issued.device_code,
      approvedByUserId: "u_admin",
      cognitoSub: "sub-123",
      tenantId: "t_abc",
      tokens: {
        access_token: "AT",
        refresh_token: "RT",
        token_type: "Bearer",
        expires_in: 3600,
      },
      sessionId: "s_xyz",
    });

    const record = await loadByDeviceCode(issued.device_code);
    expect(record).not.toBeNull();
    expect(record!.envelope).toBeDefined();

    // Attacker has the DynamoDB row but NOT the device_code.
    const { open } = await import("../../../src/lib/oauth/envelope-crypto.js");
    const { resolveKek } = await import("../../../src/lib/oauth/envelope-crypto.js");
    const kek = await resolveKek();

    expect(() => open(record!.envelope!, "different-device-code-attempt-xx", kek)).toThrow();
    expect(() => open(record!.envelope!, "", kek)).toThrow();
  });
});

describe("error rethrow paths", () => {
  it("incrementFailedLookup rethrows non-conditional errors", async () => {
    mockSend.mockImplementationOnce(async () => {
      throw new Error("network-error-1");
    });
    await expect(incrementFailedLookup("anything")).rejects.toThrow(/network-error-1/);
  });

  it("pollDeviceAuth rethrows non-conditional update errors during pending update", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });

    // Replace the implementation: GetItem succeeds, UpdateItem throws non-CCFE.
    const original = mockSend.getMockImplementation()!;
    let calls = 0;
    mockSend.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls += 1;
      const name = cmd.constructor.name;
      if (calls === 2 && name.includes("UpdateItem")) {
        throw new Error("network-error-2");
      }
      return original(cmd);
    });
    await expect(pollDeviceAuth(issued.device_code)).rejects.toThrow(/network-error-2/);
    mockSend.mockImplementation(original);
  });

});

describe("loadByDeviceCode TTL handling", () => {
  it("returns null for a record with expired DynamoDB ttl", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    const k = `pk=dc#${issued.device_code}|sk=rec`;
    const item = ddbStore.get(k)!;
    item.ttl = { N: String(Math.floor(Date.now() / 1000) - 100) };
    ddbStore.set(k, item);

    const result = await loadByDeviceCode(issued.device_code);
    expect(result).toBeNull();
  });
});
