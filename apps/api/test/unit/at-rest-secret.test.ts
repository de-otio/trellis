/**
 * Unit tests: lib/at-rest-secret.ts (DP-3 / DP-8).
 *
 * Real crypto throughout — a test that mocks the cipher proves nothing about
 * a wrapping scheme. The cases are the rotation story: legacy rows still open,
 * new rows round-trip, the previous session secret opens rows via the
 * fallback, a dedicated key takes over, and a keyed backup-code hash still
 * matches rows hashed the old way.
 */

import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import {
  decodeDedicatedKey,
  hashBackupCodeKeyed,
  matchBackupCode,
  needsReseal,
  openSecret,
  resolveKeyring,
  sealSecret,
} from "../../src/lib/at-rest-secret.js";
import {
  encryptSecret as legacyEncrypt,
  hashBackupCode as legacyHash,
} from "../../src/lib/mfa/totp-service.js";

const SECRET_A = "session-secret-A-32-characters-!";
const SECRET_B = "session-secret-B-32-characters-!";
const KEK = randomBytes(32).toString("base64");

const env = (over: Partial<Env>): Env =>
  ({ SESSION_SECRET: SECRET_A, ...over }) as unknown as Env;

describe("resolveKeyring", () => {
  it("derives per-purpose keys from the session secret, never the raw bytes", () => {
    const mfa = resolveKeyring(env({}), "mfa");
    const push = resolveKeyring(env({}), "push");
    expect(mfa.kek).toBeNull();
    expect(mfa.derived).toHaveLength(32);
    expect(mfa.derived.equals(push.derived)).toBe(false); // domain separation
    expect(mfa.derived.toString("utf8")).not.toContain("session-secret");
  });

  it("refuses a short session secret", () => {
    expect(() => resolveKeyring(env({ SESSION_SECRET: "short" }), "mfa")).toThrow(
      /at least 32 characters/,
    );
  });

  it("decodes a dedicated key and rejects anything but 32 bytes", () => {
    expect(resolveKeyring(env({ MFA_ENC_KEY: KEK }), "mfa").kek).toHaveLength(32);
    expect(decodeDedicatedKey("MFA_ENC_KEY", undefined)).toBeNull();
    expect(() => decodeDedicatedKey("MFA_ENC_KEY", "not-a-key")).toThrow(/exactly 32 bytes/);
    expect(() =>
      decodeDedicatedKey("PUSH_TOKEN_ENC_KEY", randomBytes(16).toString("base64")),
    ).toThrow(/PUSH_TOKEN_ENC_KEY/);
  });
});

describe("sealSecret / openSecret — session-derived mode", () => {
  it("round-trips a new row with the h1 format", async () => {
    const kr = resolveKeyring(env({}), "mfa");
    const sealed = await sealSecret("JBSWY3DPEHPK3PXP", kr);
    expect(sealed.startsWith("h1:")).toBe(true);
    expect(sealed).not.toContain("JBSWY3DP");
    await expect(openSecret(sealed, kr)).resolves.toBe("JBSWY3DPEHPK3PXP");
    expect(needsReseal(sealed, kr)).toBe(false);
  });

  it("opens an EXISTING legacy row (raw-key wrap) and flags it for re-seal", async () => {
    const legacyRow = await legacyEncrypt("JBSWY3DPEHPK3PXP", SECRET_A);
    expect(legacyRow.startsWith("h1:")).toBe(false);
    const kr = resolveKeyring(env({}), "mfa");
    await expect(openSecret(legacyRow, kr)).resolves.toBe("JBSWY3DPEHPK3PXP");
    expect(needsReseal(legacyRow, kr)).toBe(true);
  });

  it("opens a row sealed under the PREVIOUS session secret via the fallback", async () => {
    const before = resolveKeyring(env({ SESSION_SECRET: SECRET_A }), "mfa");
    const sealedUnderA = await sealSecret("seed", before);

    // Rotation: B is current, A is the fallback.
    const after = resolveKeyring(
      env({ SESSION_SECRET: SECRET_B, SESSION_SECRET_FALLBACK: SECRET_A }),
      "mfa",
    );
    await expect(openSecret(sealedUnderA, after)).resolves.toBe("seed");
    expect(needsReseal(sealedUnderA, after)).toBe(true);

    // Legacy rows written under A survive the same rotation.
    const legacyUnderA = await legacyEncrypt("seed", SECRET_A);
    await expect(openSecret(legacyUnderA, after)).resolves.toBe("seed");
  });

  it("refuses a row sealed under a secret that is neither current nor fallback", async () => {
    const other = resolveKeyring(env({ SESSION_SECRET: SECRET_B }), "mfa");
    const sealed = await sealSecret("seed", other);
    const kr = resolveKeyring(env({}), "mfa");
    await expect(openSecret(sealed, kr)).rejects.toThrow();
    const legacy = await legacyEncrypt("seed", SECRET_B);
    await expect(openSecret(legacy, kr)).rejects.toThrow();
  });

  it("does not open a push row with the mfa keyring (domain separation)", async () => {
    const sealed = await sealSecret("device-token", resolveKeyring(env({}), "push"));
    await expect(openSecret(sealed, resolveKeyring(env({}), "mfa"))).rejects.toThrow();
  });
});

describe("sealSecret / openSecret — dedicated key mode", () => {
  it("seals with field-encryption (v1) and re-seals h1/legacy rows on read", async () => {
    const derivedOnly = resolveKeyring(env({}), "mfa");
    const h1Row = await sealSecret("seed", derivedOnly);
    const legacyRow = await legacyEncrypt("seed", SECRET_A);

    const withKek = resolveKeyring(env({ MFA_ENC_KEY: KEK }), "mfa");
    const v1Row = await sealSecret("seed", withKek);
    expect(v1Row.startsWith("v1:")).toBe(true);
    await expect(openSecret(v1Row, withKek)).resolves.toBe("seed");
    expect(needsReseal(v1Row, withKek)).toBe(false);

    // Rows from before the key was provisioned still open, and are flagged.
    await expect(openSecret(h1Row, withKek)).resolves.toBe("seed");
    await expect(openSecret(legacyRow, withKek)).resolves.toBe("seed");
    expect(needsReseal(h1Row, withKek)).toBe(true);
    expect(needsReseal(legacyRow, withKek)).toBe(true);
  });

  it("fails closed when a v1 row meets a keyring without the dedicated key", async () => {
    const withKek = resolveKeyring(env({ MFA_ENC_KEY: KEK }), "mfa");
    const v1Row = await sealSecret("seed", withKek);
    await expect(openSecret(v1Row, resolveKeyring(env({}), "mfa"))).rejects.toThrow(
      /MFA_ENC_KEY/,
    );
  });

  it("the session secret no longer reaches a v1 row", async () => {
    const withKek = resolveKeyring(env({ MFA_ENC_KEY: KEK }), "mfa");
    const v1Row = await sealSecret("seed", withKek);
    const rotated = resolveKeyring(env({ SESSION_SECRET: SECRET_B, MFA_ENC_KEY: KEK }), "mfa");
    await expect(openSecret(v1Row, rotated)).resolves.toBe("seed");
  });
});

describe("backup codes — keyed hash with legacy match", () => {
  it("keyed hashes are prefixed, deterministic per key, and not the plain SHA-256", async () => {
    const kr = resolveKeyring(env({}), "mfa");
    const a = hashBackupCodeKeyed("ABCD-EFGH", kr);
    expect(a.startsWith("k1:")).toBe(true);
    expect(hashBackupCodeKeyed("abcdefgh", kr)).toBe(a); // normalised
    expect(a).not.toBe(await legacyHash("ABCD-EFGH"));
    const other = resolveKeyring(env({ SESSION_SECRET: SECRET_B }), "mfa");
    expect(hashBackupCodeKeyed("ABCD-EFGH", other)).not.toBe(a);
  });

  it("matches a keyed row, a row keyed under the fallback secret, and a legacy row", async () => {
    const before = resolveKeyring(env({ SESSION_SECRET: SECRET_A }), "mfa");
    const after = resolveKeyring(
      env({ SESSION_SECRET: SECRET_B, SESSION_SECRET_FALLBACK: SECRET_A }),
      "mfa",
    );
    const stored = [
      hashBackupCodeKeyed("AAAA-AAAA", after), // current key
      hashBackupCodeKeyed("BBBB-BBBB", before), // previous secret
      await legacyHash("CCCC-CCCC"), // pre-DP-8 row
    ];
    expect(await matchBackupCode("AAAA-AAAA", stored, after)).toBe(0);
    expect(await matchBackupCode("BBBB-BBBB", stored, after)).toBe(1);
    expect(await matchBackupCode("CCCC-CCCC", stored, after)).toBe(2);
    expect(await matchBackupCode("DDDD-DDDD", stored, after)).toBe(-1);
  });

  it("a legacy hash does not match under a different code", async () => {
    const kr = resolveKeyring(env({}), "mfa");
    const stored = [await legacyHash("CCCC-CCCC")];
    expect(await matchBackupCode("CCCC-CCCD", stored, kr)).toBe(-1);
  });
});
