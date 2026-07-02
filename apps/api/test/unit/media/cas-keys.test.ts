/**
 * Unit + Property Tests: cas-keys.ts
 *
 * Covers:
 * - validateContentHash: anchored allowlist, lowercase normalization, traversal/encoded/non-hex rejection
 * - casKey (with and without preset): isolation invariant, path shape
 * - pendingKey: path shape, invalid inputs
 * - Preset exhaustiveness
 *
 * Fast-check is seeded for determinism (CLAUDE.md rule: pin nondeterminism).
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  casKey,
  pendingKey,
  processingKey,
  validateContentHash,
  allPresets,
  isCasKeyError,
  type CasKeyError,
  type CasPreset,
} from "../../../src/lib/media/cas-keys.js";

// ---------------------------------------------------------------------------
// Fast-check seed (pin nondeterminism)
// ---------------------------------------------------------------------------
const FC_SEED = 0xca5_1e45;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// A valid 64-char lowercase hex string
const VALID_HASH =
  "a".repeat(64);

// A valid CUID: 'c' + 24 lowercase alphanumeric
const VALID_TENANT_A = "cabc1234567890abcdefghijk";
const VALID_TENANT_B = "ctnt9876543210zyxwvutsrqp";
const VALID_UPLOAD_ID = "cupld123456789abcdefghijk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHex(len: number): string {
  return "deadbeef".repeat(Math.ceil(len / 8)).slice(0, len);
}

const VALID_HASH_64 = makeHex(64);

// Arbitrary: valid 64-char hex string (lowercase)
const validHashArb = fc.string({
  unit: fc.constantFrom(...("0123456789abcdef".split(""))),
  minLength: 64,
  maxLength: 64,
});

// Arbitrary: valid CUID string (c + 24 lowercase alphanum)
const validCuidArb = fc
  .string({
    unit: fc.constantFrom(...("0123456789abcdefghijklmnopqrstuvwxyz".split(""))),
    minLength: 24,
    maxLength: 24,
  })
  .map((s) => `c${s}`);

// ---------------------------------------------------------------------------
// validateContentHash
// ---------------------------------------------------------------------------

describe("validateContentHash", () => {
  beforeEach(() => {
    // stateless; nothing to reset
  });

  it("accepts a valid lowercase 64-char hex string", () => {
    const result = validateContentHash(VALID_HASH_64);
    expect(typeof result).toBe("string");
    expect(result).toBe(VALID_HASH_64);
  });

  it("accepts uppercase hex and normalizes to lowercase", () => {
    const upper = VALID_HASH_64.toUpperCase();
    const result = validateContentHash(upper);
    expect(typeof result).toBe("string");
    expect(result).toBe(VALID_HASH_64);
  });

  it("accepts mixed-case hex and normalizes to lowercase", () => {
    const mixed = "ABCDEF" + "0123456789abcdef".repeat(3) + "abcde";
    // ensure exactly 64 chars
    const padded = (mixed + VALID_HASH_64).slice(0, 64);
    const result = validateContentHash(padded);
    expect(typeof result).toBe("string");
    expect((result as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a string shorter than 64 characters", () => {
    const result = validateContentHash("abc123");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects a string longer than 64 characters", () => {
    const result = validateContentHash(VALID_HASH_64 + "a");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects a string with non-hex characters (g-z)", () => {
    const withG = "g" + VALID_HASH_64.slice(1);
    const result = validateContentHash(withG);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects an empty string", () => {
    const result = validateContentHash("");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  // ----- traversal / encoded / injection inputs -----

  it("rejects a path traversal attempt: '..'", () => {
    const result = validateContentHash("..");
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a percent-encoded traversal: '%2e%2e'", () => {
    const result = validateContentHash("%2e%2e");
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a Windows-style traversal: '..\\\\path'", () => {
    const result = validateContentHash("..\\path");
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a string containing a slash", () => {
    const withSlash = VALID_HASH_64.slice(0, 30) + "/" + VALID_HASH_64.slice(31);
    const result = validateContentHash(withSlash);
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a null byte injection", () => {
    const withNull = VALID_HASH_64.slice(0, 60) + "\x00abc";
    const result = validateContentHash(withNull);
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a unicode dot-leader (U+2024)", () => {
    // ․ is '․' (ONE DOT LEADER) — not a hex char
    const withDotLeader = "․".repeat(64);
    const result = validateContentHash(withDotLeader);
    expect(isCasKeyError(result)).toBe(true);
  });

  it("rejects a string containing spaces", () => {
    const withSpace = " " + VALID_HASH_64.slice(1);
    const result = validateContentHash(withSpace);
    expect(isCasKeyError(result)).toBe(true);
  });

  // ----- property tests -----

  it("property: any input with a non-[0-9a-f] byte (post-lowercase) yields an error", () => {
    // Generate strings that include at least one non-hex character
    const nonHexCharArb = fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }).filter(
      (c) => !/^[0-9a-fA-F]$/.test(c),
    );
    const stringWithNonHexArb = fc.tuple(
      nonHexCharArb,
      fc.string({ minLength: 0, maxLength: 200 }),
    ).map(([badChar, rest]) => badChar + rest);

    fc.assert(
      fc.property(stringWithNonHexArb, (s) => {
        const result = validateContentHash(s);
        return isCasKeyError(result);
      }),
      { seed: FC_SEED, numRuns: 1000 },
    );
  });

  it("property: percent-encoded inputs (containing %) always yield an error", () => {
    const encodedArb = fc.string({ minLength: 1, maxLength: 200 }).map(
      (s) => `%${s}`,
    );

    fc.assert(
      fc.property(encodedArb, (s) => {
        const result = validateContentHash(s);
        return isCasKeyError(result);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: valid hex strings are accepted and returned lowercase", () => {
    fc.assert(
      fc.property(validHashArb, (hash) => {
        const result = validateContentHash(hash);
        if (isCasKeyError(result)) return false;
        return result === hash.toLowerCase() && /^[0-9a-f]{64}$/.test(result);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: normalization is idempotent (lowercase(lowercase(x)) === lowercase(x))", () => {
    fc.assert(
      fc.property(validHashArb, (hash) => {
        const r1 = validateContentHash(hash);
        if (isCasKeyError(r1)) return true; // skipped
        const r2 = validateContentHash(r1 as string);
        return !isCasKeyError(r2) && r1 === r2;
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// casKey (without preset)
// ---------------------------------------------------------------------------

describe("casKey (no preset)", () => {
  it("returns the canonical path for valid inputs", () => {
    const result = casKey(VALID_TENANT_A, VALID_HASH_64);
    expect(result).toBe(`cas/${VALID_TENANT_A}/${VALID_HASH_64}`);
  });

  it("accepts uppercase hash and returns lowercase-normalized key", () => {
    const result = casKey(VALID_TENANT_A, VALID_HASH_64.toUpperCase());
    expect(result).toBe(`cas/${VALID_TENANT_A}/${VALID_HASH_64}`);
  });

  it("rejects an invalid tenantId (too short)", () => {
    const result = casKey("short", VALID_HASH_64);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects an invalid tenantId (contains uppercase)", () => {
    // CUID starts with 'c' + 24 lowercase alphanum; uppercase forbidden
    const upperTenant = "CABC1234567890ABCDEFGHIJK";
    const result = casKey(upperTenant, VALID_HASH_64);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects an invalid tenantId (path traversal)", () => {
    const result = casKey("../etc/passwd", VALID_HASH_64);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects an invalid tenantId (contains slash)", () => {
    const result = casKey("ctenant/evil", VALID_HASH_64);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects an invalid hash (non-hex character)", () => {
    const result = casKey(VALID_TENANT_A, "g".repeat(64));
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects an invalid hash (wrong length)", () => {
    const result = casKey(VALID_TENANT_A, "abc");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects an invalid hash with traversal characters", () => {
    const result = casKey(VALID_TENANT_A, "../" + VALID_HASH_64);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  // ----- isolation invariant -----

  it("two tenants with the same hash produce different keys", () => {
    const keyA = casKey(VALID_TENANT_A, VALID_HASH_64);
    const keyB = casKey(VALID_TENANT_B, VALID_HASH_64);
    expect(keyA).not.toBe(keyB);
    expect(typeof keyA).toBe("string");
    expect(typeof keyB).toBe("string");
  });

  // ----- property tests -----

  it("property: two tenants with the same hash always yield different keys", () => {
    fc.assert(
      fc.property(
        validCuidArb,
        validCuidArb,
        validHashArb,
        (tenantA, tenantB, hash) => {
          if (tenantA === tenantB) return true; // skip same-tenant case
          const keyA = casKey(tenantA, hash);
          const keyB = casKey(tenantB, hash);
          if (isCasKeyError(keyA) || isCasKeyError(keyB)) return true; // skip invalid
          return keyA !== keyB;
        },
      ),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: a non-hex byte in the hash always yields an error", () => {
    const nonHexCharArb = fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }).filter((c) => !/^[0-9a-fA-F]$/.test(c));
    const badHashArb = fc.tuple(
      nonHexCharArb,
      fc.string({ minLength: 0, maxLength: 100 }),
    ).map(([bad, rest]) => bad + rest);

    fc.assert(
      fc.property(validCuidArb, badHashArb, (tenant, hash) => {
        const result = casKey(tenant, hash);
        return isCasKeyError(result);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: valid inputs always produce a key starting with cas/", () => {
    fc.assert(
      fc.property(validCuidArb, validHashArb, (tenant, hash) => {
        const result = casKey(tenant, hash);
        if (isCasKeyError(result)) return true;
        return (result as string).startsWith("cas/");
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: key contains tenantId and normalized hash as path segments", () => {
    fc.assert(
      fc.property(validCuidArb, validHashArb, (tenant, hash) => {
        const result = casKey(tenant, hash);
        if (isCasKeyError(result)) return true;
        const key = result as string;
        return (
          key === `cas/${tenant}/${hash.toLowerCase()}` &&
          !key.includes("..") &&
          key.split("/").length === 3
        );
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// casKey (with preset)
// ---------------------------------------------------------------------------

describe("casKey (with preset)", () => {
  it("returns the canonical preset path for thumbnail", () => {
    const result = casKey(VALID_TENANT_A, VALID_HASH_64, "thumbnail");
    expect(result).toBe(
      `cas/${VALID_TENANT_A}/${VALID_HASH_64}/thumbnail`,
    );
  });

  it("returns the canonical preset path for optimized", () => {
    const result = casKey(VALID_TENANT_A, VALID_HASH_64, "optimized");
    expect(result).toBe(
      `cas/${VALID_TENANT_A}/${VALID_HASH_64}/optimized`,
    );
  });

  it("preset exhaustiveness: all presets from allPresets() are accepted", () => {
    for (const preset of allPresets()) {
      const result = casKey(VALID_TENANT_A, VALID_HASH_64, preset);
      expect(isCasKeyError(result)).toBe(false);
      expect(result).toContain(`/${preset}`);
    }
  });

  it("rejects an invalid preset value", () => {
    // Cast to CasPreset to simulate a runtime injection of an unknown string
    const result = casKey(VALID_TENANT_A, VALID_HASH_64, "raw" as CasPreset);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_preset");
  });

  it("rejects a path-traversal preset", () => {
    const result = casKey(
      VALID_TENANT_A,
      VALID_HASH_64,
      "../secrets" as CasPreset,
    );
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_preset");
  });

  it("property: all presets from allPresets() produce 4-segment keys", () => {
    fc.assert(
      fc.property(
        validCuidArb,
        validHashArb,
        fc.constantFrom(...allPresets()),
        (tenant, hash, preset) => {
          const result = casKey(tenant, hash, preset);
          if (isCasKeyError(result)) return true;
          const segments = (result as string).split("/");
          return segments.length === 4 && segments[3] === preset;
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it("property: two tenants same hash same preset => different keys", () => {
    fc.assert(
      fc.property(
        validCuidArb,
        validCuidArb,
        validHashArb,
        fc.constantFrom(...allPresets()),
        (tenantA, tenantB, hash, preset) => {
          if (tenantA === tenantB) return true;
          const keyA = casKey(tenantA, hash, preset);
          const keyB = casKey(tenantB, hash, preset);
          if (isCasKeyError(keyA) || isCasKeyError(keyB)) return true;
          return keyA !== keyB;
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// pendingKey
// ---------------------------------------------------------------------------

describe("pendingKey", () => {
  it("returns the canonical pending path for valid inputs", () => {
    const result = pendingKey(VALID_TENANT_A, VALID_UPLOAD_ID);
    expect(result).toBe(`pending/${VALID_TENANT_A}/${VALID_UPLOAD_ID}`);
  });

  it("rejects an invalid tenantId", () => {
    const result = pendingKey("bad-tenant", VALID_UPLOAD_ID);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects an invalid uploadId (too short)", () => {
    const result = pendingKey(VALID_TENANT_A, "short");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_upload_id");
  });

  it("rejects an uploadId with path traversal characters", () => {
    const result = pendingKey(VALID_TENANT_A, "../etc/evil");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_upload_id");
  });

  it("rejects an uploadId containing a slash", () => {
    const result = pendingKey(VALID_TENANT_A, "c" + "a".repeat(23) + "/evil");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_upload_id");
  });

  it("rejects an uploadId that does not start with c", () => {
    // A 25-char string that is all lowercase alphanum but doesn't start with 'c'
    const noC = "a" + "b".repeat(24);
    const result = pendingKey(VALID_TENANT_A, noC);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_upload_id");
  });

  it("property: valid inputs produce keys starting with pending/", () => {
    fc.assert(
      fc.property(validCuidArb, validCuidArb, (tenant, uploadId) => {
        const result = pendingKey(tenant, uploadId);
        if (isCasKeyError(result)) return true;
        return (result as string).startsWith("pending/");
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: valid inputs produce 3-segment keys", () => {
    fc.assert(
      fc.property(validCuidArb, validCuidArb, (tenant, uploadId) => {
        const result = pendingKey(tenant, uploadId);
        if (isCasKeyError(result)) return true;
        const segments = (result as string).split("/");
        return segments.length === 3;
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});

describe("processingKey (T3 — sync-image staging key)", () => {
  it("returns the canonical processing path (content-addressed) for valid inputs", () => {
    const result = processingKey(VALID_TENANT_A, VALID_HASH);
    expect(result).toBe(`processing/${VALID_TENANT_A}/${VALID_HASH}`);
  });

  it("lowercase-normalizes the hash (single processing keyspace)", () => {
    const result = processingKey(VALID_TENANT_A, "A".repeat(64));
    expect(result).toBe(`processing/${VALID_TENANT_A}/${"a".repeat(64)}`);
  });

  it("rejects an invalid tenantId with a typed error", () => {
    const result = processingKey("bad-tenant", VALID_HASH);
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_tenant_id");
  });

  it("rejects a non-hex / wrong-length hash with a typed error", () => {
    const result = processingKey(VALID_TENANT_A, "short");
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("rejects a hash containing path-traversal characters", () => {
    const result = processingKey(VALID_TENANT_A, "../" + "a".repeat(61));
    expect(isCasKeyError(result)).toBe(true);
    expect((result as CasKeyError).kind).toBe("invalid_hash");
  });

  it("property: valid inputs produce 3-segment keys under processing/", () => {
    fc.assert(
      fc.property(validCuidArb, validHashArb, (tenant, hash) => {
        const result = processingKey(tenant, hash);
        if (isCasKeyError(result)) return true;
        const key = result as string;
        return key.startsWith("processing/") && key.split("/").length === 3;
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it("property: a tenant's processing key and cas key differ only by prefix", () => {
    fc.assert(
      fc.property(validCuidArb, validHashArb, (tenant, hash) => {
        const proc = processingKey(tenant, hash);
        const cas = casKey(tenant, hash);
        if (isCasKeyError(proc) || isCasKeyError(cas)) return true;
        return (
          (proc as string) === `processing/${tenant}/${(hash as string).toLowerCase()}` &&
          (cas as string) === `cas/${tenant}/${(hash as string).toLowerCase()}`
        );
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-function: isolation invariant summary
// ---------------------------------------------------------------------------

describe("Tenant isolation invariant", () => {
  it("property: any two distinct tenants always get distinct casKey outputs for any hash", () => {
    fc.assert(
      fc.property(
        validCuidArb,
        validCuidArb.filter((t) => t !== VALID_TENANT_A),
        validHashArb,
        (tenantA, tenantB, hash) => {
          if (tenantA === tenantB) return true;
          const a = casKey(tenantA, hash);
          const b = casKey(tenantB, hash);
          if (isCasKeyError(a) || isCasKeyError(b)) return true;
          return a !== b;
        },
      ),
      { seed: FC_SEED, numRuns: 1000 },
    );
  });

  it("property: different tenants never share a pending key", () => {
    fc.assert(
      fc.property(validCuidArb, validCuidArb, validCuidArb, (t1, t2, uid) => {
        if (t1 === t2) return true;
        const k1 = pendingKey(t1, uid);
        const k2 = pendingKey(t2, uid);
        if (isCasKeyError(k1) || isCasKeyError(k2)) return true;
        return k1 !== k2;
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });
});
