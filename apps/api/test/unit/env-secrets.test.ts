/**
 * Unit Tests: env.ts secret resolution
 *
 * Covers buildEnv()'s secret resolution deterministically, without AWS:
 *
 *   1. Local SESSION_SECRET in process.env wins (no AWS call).
 *   2. ARN path: SESSION_SECRET_ARN set → resolved from Secrets Manager via the
 *      foundation resolver. Driven by foundation's MemorySecretStore injected
 *      through buildEnv(context) — the same real resolveSecret code path as
 *      production, no mocks.
 *   3. Fail-closed: neither SESSION_SECRET nor SESSION_SECRET_ARN → rejects.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretStore, SecretCache } from "@de-otio/saas-foundation/secrets";

// ── env isolation ─────────────────────────────────────────────────────────────

/** Save and restore the process.env keys touched by these tests. */
const MANAGED_KEYS = [
  "SESSION_SECRET",
  "SESSION_SECRET_ARN",
  "SESSION_SECRET_FALLBACK",
  "SESSION_SECRET_FALLBACK_ARN",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_ARN",
  "DATABASE_URL",
  "DB_SECRET_ARN",
  "DB_SECRET_USERNAME",
  "DB_SECRET_PASSWORD",
  "DB_SECRET_HOST",
] as const;

let savedEnv: Partial<Record<string, string>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // buildEnv() → resolveDatabaseUrl() requires at least DATABASE_URL to avoid
  // an unrelated throw; set a minimal placeholder for all tests.
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  // Reset module-level cache in env.ts between tests so each test starts clean.
  // The cache (cachedDatabaseUrl) lives at module scope; vitest re-uses the
  // module between tests in the same file.  We can't reset it without DI, so
  // tests that care about database resolution should use a fresh import or
  // accept that the cached value from beforeEach persists.  For these tests
  // we only assert on SESSION_SECRET, which is not cached.
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildEnv — secret resolution", () => {
  it("local SESSION_SECRET wins (no AWS call)", async () => {
    const expectedSecret = "local-session-secret-minimum-32-chars!!";
    process.env.SESSION_SECRET = expectedSecret;

    // Dynamic import so the module cache doesn't confuse us with a previous run.
    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    expect(env.SESSION_SECRET).toBe(expectedSecret);
  });

  it("ARN path: resolves SESSION_SECRET from Secrets Manager when only the ARN is set", async () => {
    const arn =
      "arn:aws:secretsmanager:eu-central-1:123456789012:secret:trellis/session-AbCdEf";
    const expectedSecret = "sm-resolved-session-secret-32-chars-x";
    process.env.SESSION_SECRET_ARN = arn;

    const store = new MemorySecretStore();
    store.setSecret(arn, { value: expectedSecret });

    const { buildEnv } = await import("../../src/env.js");
    // Inject the in-memory store's clients — exercises the real resolveSecret
    // path through Secrets Manager, deterministically, with no AWS call. A
    // fresh cache guarantees a miss so the call count is order-independent.
    const env = await buildEnv({
      secretsClient: store.secretsClient,
      cache: new SecretCache(),
    });

    expect(env.SESSION_SECRET).toBe(expectedSecret);
    expect(store.calls("secret", arn)).toBe(1);
  });

  it("local SESSION_SECRET wins over the ARN (no Secrets Manager call)", async () => {
    const arn =
      "arn:aws:secretsmanager:eu-central-1:123456789012:secret:trellis/session-AbCdEf";
    const localSecret = "local-session-secret-minimum-32-chars!!";
    process.env.SESSION_SECRET = localSecret;
    process.env.SESSION_SECRET_ARN = arn;

    const store = new MemorySecretStore();
    store.setSecret(arn, { value: "should-not-be-used" });

    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv({ secretsClient: store.secretsClient });

    expect(env.SESSION_SECRET).toBe(localSecret);
    expect(store.calls("secret", arn)).toBe(0);
  });

  it("fail-closed: rejects when SESSION_SECRET and SESSION_SECRET_ARN are both absent", async () => {
    // Both already deleted in beforeEach.
    const { buildEnv } = await import("../../src/env.js");

    await expect(buildEnv()).rejects.toThrow(/SESSION_SECRET not resolved/);
  });
});
