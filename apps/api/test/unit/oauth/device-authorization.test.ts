/**
 * Unit tests: device-authorization.ts — behavior-comparison suite (WS-1 §3.8).
 *
 * The pre-port suite mocked `@aws-sdk/client-dynamodb`. Post-port the storage is
 * two injected `MemoryKvStore`s (device rows + the manual user-code index row),
 * and the status-conditioned writes are read(consistent)→compareAndSet — so this
 * suite asserts OUTCOME EQUIVALENCE:
 *  - user_code / device_code generation (pure helpers, unchanged).
 *  - approve → poll → tokens; second poll → gone (read-once delete).
 *  - slow_down on too-frequent polls; expired after the record's expiry passes.
 *  - failed-lookup increment + lockout invalidation; missing → 0.
 *  - envelope binding: a stored record cannot be opened without the device_code
 *    (real seal/open, unchanged).
 *  - 60-second post-approval TTL re-key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { MemoryKvStore, type KvStore } from "@de-otio/saas-foundation/kv";

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
  _setDeviceStoresForTest,
} from "../../../src/lib/oauth/device-authorization.js";

import { _resetKekCacheForTest } from "../../../src/lib/oauth/envelope-crypto.js";

/**
 * Deterministic RNG for the uniqueness test below (pins the nondeterminism
 * instead of gambling on it). `generateUserCode` already takes its entropy
 * source as a dependency (defaulting to `randomBytes` for production); this
 * substitutes a counter-driven source so the "no dupes" assertion is a
 * mathematical guarantee, not a birthday-paradox roll against real crypto
 * randomness.
 *
 * The k-th call returns the base-`ALPHABET_LEN` digit expansion of k, one
 * digit per byte. Every digit is < the alphabet length (well under the
 * generator's modulo-bias rejection cutoff of 240), so each byte is accepted
 * verbatim on the first pass — the produced code is exactly the alphabet
 * characters at those digit indices. Because base-N digit tuples are unique
 * for k in [0, ALPHABET_LEN^USER_CODE_LEN), and that space is ~2.56e10 here,
 * calling this for any run size we'd plausibly use in a test is guaranteed
 * collision-free BY CONSTRUCTION — it deterministically exercises the real
 * alphabet-mapping logic in `generateUserCode` for distinct inputs, rather
 * than asserting that sampling real randomness never collides (which it
 * occasionally will, at the birthday-bound rate for the sample size).
 */
function makeInjectiveUserCodeRng(): (n: number) => Buffer {
  const alphaLen = USER_CODE_ALPHABET.length;
  let counter = 0;
  return (n: number) => {
    let k = counter++;
    const buf = Buffer.alloc(n, 0);
    for (let i = 0; i < USER_CODE_LEN; i++) {
      buf[i] = k % alphaLen;
      k = Math.floor(k / alphaLen);
    }
    return buf;
  };
}

let deviceStore: MemoryKvStore;
let indexStore: MemoryKvStore;

beforeEach(() => {
  deviceStore = new MemoryKvStore();
  indexStore = new MemoryKvStore();
  _setDeviceStoresForTest(deviceStore, indexStore);
  _resetKekCacheForTest();
  process.env.DEVICE_AUTH_KEK_BASE64 = randomBytes(32).toString("base64");
});

afterEach(() => {
  delete process.env.DEVICE_AUTH_KEK_BASE64;
});

describe("user_code helpers", () => {
  it("uses an unambiguous alphabet — no 0/O/1/I/2/Z", () => {
    expect(USER_CODE_ALPHABET).not.toMatch(/[0OI12]/);
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

  it("generates highly unique codes — deterministic injectivity proof, 10K samples", () => {
    // A prior version of this test called generateUserCode() with the real
    // CSPRNG for 10K samples and asserted no collision — a birthday-paradox
    // bet (~0.2% collision chance for 10K draws over a 20^8 keyspace) that
    // flaked in CI. Injecting a deterministic, collision-free-by-construction
    // source (see makeInjectiveUserCodeRng above) keeps the assertion but
    // removes the gamble; production callers still default to randomBytes.
    const rng = makeInjectiveUserCodeRng();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = generateUserCode(rng);
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
      sub: "sub-123",
      tenantId: "t_abc",
      tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 },
      sessionId: "s_xyz",
    });

    const ok = await pollDeviceAuth(issued.device_code);
    expect(ok.outcome).toBe("ok");
    expect(ok.tokens?.access_token).toBe("AT");
    expect(ok.tokens?.refresh_token).toBe("RT");

    // Second poll: the row was deleted before the first returned (read-once).
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
      sub: "sub-123",
      tenantId: "t_abc",
      tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 },
      sessionId: "s_xyz",
    });
    const record = await loadByDeviceCode(issued.device_code);
    expect(record).not.toBeNull();
    expect(record!.expiresAt).toBeGreaterThanOrEqual(before + POST_APPROVAL_TTL_SECONDS - 2);
    expect(record!.expiresAt).toBeLessThanOrEqual(before + POST_APPROVAL_TTL_SECONDS + 2);
    // userCode was removed on approval.
    expect(record!.userCode).toBeUndefined();
  });

  it("expired record returns `expired`", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
      expiresIn: 600,
    });
    // Simulate clock drift: push the record's own expiresAt into the past while
    // keeping the KV TTL in the future so the row is still readable.
    const raw = await deviceStore.get<Record<string, unknown>>(issued.device_code);
    await deviceStore.put(
      issued.device_code,
      { ...raw!.value, expiresAt: Math.floor(Date.now() / 1000) - 100 },
      { expiresAt: Math.floor(Date.now() / 1000) + 60 },
    );
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

  it("incrementFailedLookup on a missing record returns 0 (no phantom row created)", async () => {
    const count = await incrementFailedLookup("does-not-exist");
    expect(count).toBe(0);
    expect(await loadByDeviceCode("does-not-exist")).toBeNull();
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
      sub: "sub-123",
      tenantId: "t_abc",
      tokens: { access_token: "AT", refresh_token: "RT", token_type: "Bearer", expires_in: 3600 },
      sessionId: "s_xyz",
    });

    const record = await loadByDeviceCode(issued.device_code);
    expect(record).not.toBeNull();
    expect(record!.envelope).toBeDefined();

    // Attacker has the stored row but NOT the device_code.
    const { open, resolveKek } = await import("../../../src/lib/oauth/envelope-crypto.js");
    const kek = await resolveKek();
    expect(() => open(record!.envelope!, "different-device-code-attempt-xx", kek)).toThrow();
    expect(() => open(record!.envelope!, "", kek)).toThrow();
  });
});

describe("error rethrow paths", () => {
  it("incrementFailedLookup rethrows non-conditional store errors", async () => {
    const failing: KvStore = {
      ...new MemoryKvStore(),
      get: () => Promise.reject(new Error("network-error-1")),
    } as unknown as KvStore;
    _setDeviceStoresForTest(failing, indexStore);
    await expect(incrementFailedLookup("anything")).rejects.toThrow(/network-error-1/);
  });

  it("pollDeviceAuth rethrows non-conditional errors during the pending update", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    // A store that reads fine but throws on the best-effort lastPolledAt CAS.
    const throwingCas: KvStore = {
      ...deviceStore,
      get: deviceStore.get.bind(deviceStore),
      compareAndSet: () => Promise.reject(new Error("network-error-2")),
    } as unknown as KvStore;
    _setDeviceStoresForTest(throwingCas, indexStore);
    await expect(pollDeviceAuth(issued.device_code)).rejects.toThrow(/network-error-2/);
  });
});

describe("loadByDeviceCode TTL handling", () => {
  it("returns null for a record whose KV TTL has expired", async () => {
    const issued = await startDeviceAuthorization({
      verificationUriBase: "https://example.com/agents/authorize",
    });
    const raw = await deviceStore.get<Record<string, unknown>>(issued.device_code);
    // Re-write with a KV expiry in the past → the port filters it on read.
    await deviceStore.put(issued.device_code, raw!.value, {
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    expect(await loadByDeviceCode(issued.device_code)).toBeNull();
  });
});
