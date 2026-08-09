/**
 * Unit tests: boot validation of the four client-version-policy env vars
 * (tier 3 — format-if-set) in src/env-schema.ts.
 *
 * Kept in its own file (rather than appended to env-boot-schema.test.ts) so
 * the forced-upgrade mechanism's boot contract is legible on its own: a
 * malformed value here is the difference between an armed mechanism and one
 * that silently does nothing, which is why it refuses the boot instead of
 * degrading at runtime.
 */

import { describe, expect, it } from "vitest";

import { assertBootEnv, validateBootEnv } from "../../src/env-schema.js";

/** Minimal valid dev env; the CLIENT_* keys are layered on top. */
function devEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    STAGE: "dev",
    DATABASE_URL: "postgresql://test:test@localhost:5432/testdb",
    SESSION_SECRET: "test-secret-key-32-characters-long!!",
    COGNITO_USER_POOL_ID: "local_test_pool",
    COGNITO_APP_CLIENT_ID: "localtestclient0000000000",
    ...extra,
  };
}

const ANDROID_URL =
  "https://play.google.com/store/apps/details?id=org.example.app";
const IOS_URL = "https://apps.apple.com/app/id123456789";

describe("client-version policy env (boot validation)", () => {
  it("all four unset is valid — the mechanism ships dormant", () => {
    expect(validateBootEnv(devEnv())).toEqual([]);
  });

  it("accepts a fully configured policy", () => {
    expect(
      validateBootEnv(
        devEnv({
          CLIENT_MIN_SUPPORTED_VERSION: "1.0.0",
          CLIENT_RECOMMENDED_VERSION: "1.4.2-rc.1",
          CLIENT_STORE_URL_ANDROID: ANDROID_URL,
          CLIENT_STORE_URL_IOS: IOS_URL,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ["CLIENT_MIN_SUPPORTED_VERSION", "not-a-version"],
    ["CLIENT_MIN_SUPPORTED_VERSION", "1.2"],
    ["CLIENT_MIN_SUPPORTED_VERSION", "10000.0.0"],
    ["CLIENT_RECOMMENDED_VERSION", "v1.2.3"],
    ["CLIENT_RECOMMENDED_VERSION", ""],
  ])("rejects %s=%j and names the key", (key, value) => {
    const issues = validateBootEnv(devEnv({ [key]: value }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(key);
  });

  it("rejects an over-long version string", () => {
    const issues = validateBootEnv(
      devEnv({ CLIENT_MIN_SUPPORTED_VERSION: `1.0.0-${"a".repeat(200)}` }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("CLIENT_MIN_SUPPORTED_VERSION");
  });

  it.each([
    ["CLIENT_STORE_URL_ANDROID", "http://play.google.com/store/apps"],
    ["CLIENT_STORE_URL_ANDROID", "https://play.google.com.evil.example/store"],
    ["CLIENT_STORE_URL_IOS", "https://example.com/download"],
    ["CLIENT_STORE_URL_IOS", "market://details?id=org.example.app"],
    ["CLIENT_STORE_URL_IOS", "definitely not a url"],
  ])("boot-fails on %s=%j (non-https or non-allow-listed host)", (key, value) => {
    const issues = validateBootEnv(devEnv({ [key]: value }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(key);
    expect(issues[0]).toContain("play.google.com");
    expect(issues[0]).toContain("apps.apple.com");
  });

  it("assertBootEnv throws on a bad store URL", () => {
    expect(() =>
      assertBootEnv(devEnv({ CLIENT_STORE_URL_IOS: "https://evil.example/app" })),
    ).toThrow(/CLIENT_STORE_URL_IOS/);
  });

  it("applies the same rules in prod (these keys are not stage-dependent)", () => {
    const prod: Record<string, string | undefined> = {
      STAGE: "prod",
      DB_SECRET_ARN:
        "arn:aws:secretsmanager:eu-central-1:000000000000:secret:db-abc123",
      SESSION_SECRET_ARN:
        "arn:aws:secretsmanager:eu-central-1:000000000000:secret:session-abc123",
      SESSION_SALT: "prod-salt-value-32-characters-minimum!!",
      COGNITO_USER_POOL_ID: "eu-central-1_ABCdef123",
      COGNITO_APP_CLIENT_ID: "abcdefghijklmnopqrstuvwxy",
      APP_DOMAIN: "app.example.test",
      MEDIA_THRESHOLDS_JSON: JSON.stringify({
        test_category: { review: 0.5, quarantine: 0.9 },
      }),
      CLIENT_MIN_SUPPORTED_VERSION: "2.0.0",
      CLIENT_STORE_URL_ANDROID: ANDROID_URL,
    };
    expect(validateBootEnv(prod)).toEqual([]);
    expect(
      validateBootEnv({ ...prod, CLIENT_MIN_SUPPORTED_VERSION: "two" }),
    ).toHaveLength(1);
  });
});
