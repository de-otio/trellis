/**
 * Unit Tests: boot-time env validation (AR12, src/env-schema.ts)
 *
 * The validator is pure — it reads only the object passed in, never
 * process.env — so these tests build explicit env fixtures and never touch or
 * restore global state.
 *
 * Covers:
 *   - a valid dev env and a valid prod env parse cleanly;
 *   - each required key missing → an issue NAMING the key;
 *   - dev-only-overridable keys (SESSION_SALT, MEDIA_THRESHOLDS_JSON) absent
 *     in dev are fine, absent in prod fail;
 *   - format checks on optional keys (numeric MEDIA_* caps, JSON allowlists,
 *     canonical format/quality, ACTIVITYPUB_ENABLED, thresholds map);
 *   - assertBootEnv throws EnvBootValidationError carrying the issues;
 *   - stage resolution from STAGE.
 */

import { describe, expect, it } from "vitest";
import {
  assertBootEnv,
  EnvBootValidationError,
  resolveBootStage,
  validateBootEnv,
} from "../../src/env-schema.js";

/** Minimal valid dev env (mirrors the standalone lane's shape). */
function validDevEnv(): Record<string, string | undefined> {
  return {
    STAGE: "dev",
    DATABASE_URL: "postgresql://test:test@localhost:5432/testdb",
    SESSION_SECRET: "test-secret-key-32-characters-long!!",
    COGNITO_USER_POOL_ID: "local_test_pool",
    COGNITO_APP_CLIENT_ID: "localtestclient0000000000",
  };
}

/** Minimal valid prod env (secrets by ARN, thresholds + salt present). */
function validProdEnv(): Record<string, string | undefined> {
  return {
    STAGE: "prod",
    DB_SECRET_ARN: "arn:aws:secretsmanager:eu-central-1:000000000000:secret:db-abc123",
    SESSION_SECRET_ARN:
      "arn:aws:secretsmanager:eu-central-1:000000000000:secret:session-abc123",
    SESSION_SALT: "prod-salt-value-32-characters-minimum!!",
    COGNITO_USER_POOL_ID: "eu-central-1_ABCdef123",
    COGNITO_APP_CLIENT_ID: "abcdefghijklmnopqrstuvwxy",
    MEDIA_THRESHOLDS_JSON: JSON.stringify({
      // Test-fixture values only — not operative thresholds.
      test_category: { review: 0.5, quarantine: 0.9 },
    }),
  };
}

describe("resolveBootStage", () => {
  it("returns prod only for STAGE === 'prod'", () => {
    expect(resolveBootStage({ STAGE: "prod" })).toBe("prod");
    expect(resolveBootStage({ STAGE: "dev" })).toBe("dev");
    expect(resolveBootStage({ STAGE: "test" })).toBe("dev");
    expect(resolveBootStage({})).toBe("dev");
  });
});

describe("validateBootEnv — valid environments", () => {
  it("accepts a valid dev env", () => {
    expect(validateBootEnv(validDevEnv())).toEqual([]);
  });

  it("accepts a valid prod env", () => {
    expect(validateBootEnv(validProdEnv())).toEqual([]);
  });

  it("accepts the legacy DB_SECRET_USERNAME/PASSWORD/HOST triple", () => {
    const env = validDevEnv();
    delete env.DATABASE_URL;
    env.DB_SECRET_USERNAME = "user";
    env.DB_SECRET_PASSWORD = "pass";
    env.DB_SECRET_HOST = "db.internal";
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("accepts DB_SECRET_ARN as the database source", () => {
    const env = validDevEnv();
    delete env.DATABASE_URL;
    env.DB_SECRET_ARN = "arn:aws:secretsmanager:eu-central-1:000000000000:secret:db";
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("ignores unrelated env keys", () => {
    const env = { ...validDevEnv(), SOME_RANDOM_KEY: "whatever", PATH: "/usr/bin" };
    expect(validateBootEnv(env)).toEqual([]);
  });
});

describe("validateBootEnv — required keys fail fast, naming the key", () => {
  it("no database config at all → names DATABASE_URL and the alternatives", () => {
    const env = validDevEnv();
    delete env.DATABASE_URL;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DATABASE_URL");
    expect(issues[0]).toContain("DB_SECRET_ARN");
  });

  it("partial legacy DB triple → incomplete-config issue naming the missing pieces", () => {
    const env = validDevEnv();
    delete env.DATABASE_URL;
    env.DB_SECRET_USERNAME = "user";
    env.DB_SECRET_HOST = "db.internal"; // no password
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("DB_SECRET_PASSWORD");
    expect(issues[0]).toContain("incomplete");
  });

  it("non-postgres DATABASE_URL → invalid, naming the key", () => {
    const env = validDevEnv();
    env.DATABASE_URL = "mysql://test:test@localhost:3306/testdb";
    const issues = validateBootEnv(env);
    expect(issues.some((i) => i.startsWith("DATABASE_URL:"))).toBe(true);
  });

  it("missing session secret (value and ARN) → names SESSION_SECRET and SESSION_SECRET_ARN", () => {
    const env = validDevEnv();
    delete env.SESSION_SECRET;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("SESSION_SECRET");
    expect(issues[0]).toContain("SESSION_SECRET_ARN");
  });

  it("SESSION_SECRET shorter than 32 characters → names the key", () => {
    const env = validDevEnv();
    env.SESSION_SECRET = "too-short";
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("SESSION_SECRET:")).toBe(true);
    expect(issues[0]).toContain("32");
  });

  it("missing COGNITO_USER_POOL_ID → names the key", () => {
    const env = validDevEnv();
    delete env.COGNITO_USER_POOL_ID;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("COGNITO_USER_POOL_ID:")).toBe(true);
  });

  it("missing COGNITO_APP_CLIENT_ID → names the key", () => {
    const env = validDevEnv();
    delete env.COGNITO_APP_CLIENT_ID;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("COGNITO_APP_CLIENT_ID:")).toBe(true);
  });

  it("reports every missing key at once (not just the first)", () => {
    const issues = validateBootEnv({ STAGE: "dev" });
    const keysNamed = issues.map((i) => i.split(":")[0]);
    expect(keysNamed).toContain("DATABASE_URL");
    expect(keysNamed).toContain("SESSION_SECRET");
    expect(keysNamed).toContain("COGNITO_USER_POOL_ID");
    expect(keysNamed).toContain("COGNITO_APP_CLIENT_ID");
  });
});

describe("validateBootEnv — dev-only-overridable keys (required in prod, optional in dev)", () => {
  it("SESSION_SALT absent in dev is fine", () => {
    const env = validDevEnv();
    expect(env.SESSION_SALT).toBeUndefined();
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("MEDIA_THRESHOLDS_JSON absent in dev is fine (fail-closed at runtime)", () => {
    const env = validDevEnv();
    expect(env.MEDIA_THRESHOLDS_JSON).toBeUndefined();
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("SESSION_SALT absent in prod → names the key", () => {
    const env = validProdEnv();
    delete env.SESSION_SALT;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("SESSION_SALT:")).toBe(true);
    expect(issues[0]).toContain("required in prod");
  });

  it("MEDIA_THRESHOLDS_JSON absent in prod → names the key", () => {
    const env = validProdEnv();
    delete env.MEDIA_THRESHOLDS_JSON;
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_THRESHOLDS_JSON:")).toBe(true);
    expect(issues[0]).toContain("required in prod");
  });

  it("empty thresholds map is fine in dev but rejected in prod", () => {
    const dev = { ...validDevEnv(), MEDIA_THRESHOLDS_JSON: "{}" };
    expect(validateBootEnv(dev)).toEqual([]);

    const prod = { ...validProdEnv(), MEDIA_THRESHOLDS_JSON: "{}" };
    const issues = validateBootEnv(prod);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_THRESHOLDS_JSON:")).toBe(true);
    expect(issues[0]).toContain("at least one category");
  });
});

describe("validateBootEnv — optional keys are format-checked when set", () => {
  it("MEDIA_THRESHOLDS_JSON that is not JSON → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_THRESHOLDS_JSON: "not-json{" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_THRESHOLDS_JSON:")).toBe(true);
    expect(issues[0]).toContain("valid JSON");
  });

  it("MEDIA_THRESHOLDS_JSON with an out-of-range entry → names key and category", () => {
    const env = {
      ...validDevEnv(),
      MEDIA_THRESHOLDS_JSON: JSON.stringify({
        ok_cat: { review: 0.4, quarantine: 0.8 },
        bad_cat: { review: 1.5, quarantine: 0.8 },
      }),
    };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_THRESHOLDS_JSON:")).toBe(true);
    expect(issues[0]).toContain("bad_cat");
  });

  it("MEDIA_THRESHOLDS_JSON that is a JSON array → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_THRESHOLDS_JSON: "[1,2]" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_THRESHOLDS_JSON:")).toBe(true);
  });

  it("non-numeric MEDIA_MAX_BYTES_IMAGE → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_MAX_BYTES_IMAGE: "ten megabytes" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_MAX_BYTES_IMAGE:")).toBe(true);
    expect(issues[0]).toContain("positive integer");
  });

  it("zero MEDIA_RATE_UPLOAD_PER_MIN → rejected (must be positive)", () => {
    const env = { ...validDevEnv(), MEDIA_RATE_UPLOAD_PER_MIN: "0" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_RATE_UPLOAD_PER_MIN:")).toBe(true);
  });

  it("valid numeric MEDIA_* values pass", () => {
    const env = {
      ...validDevEnv(),
      MEDIA_MAX_BYTES_IMAGE: "10485760",
      MEDIA_MAX_PIXELS: "25000000",
      MEDIA_MAX_DURATION_SECONDS: "60",
      MEDIA_REVIEW_RATE_CAP: "20",
      MEDIA_QUOTA_MAX_OBJECTS: "1000",
      MEDIA_QUOTA_MAX_BYTES: "1073741824",
    };
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("MEDIA_CANONICAL_QUALITY out of 1..100 → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_CANONICAL_QUALITY: "150" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_CANONICAL_QUALITY:")).toBe(true);
  });

  it("non-numeric MEDIA_CANONICAL_QUALITY → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_CANONICAL_QUALITY: "high" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_CANONICAL_QUALITY:")).toBe(true);
  });

  it("MEDIA_CANONICAL_FORMAT outside jpeg|png|webp → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_CANONICAL_FORMAT: "avif" };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_CANONICAL_FORMAT:")).toBe(true);
  });

  it("valid canonical format/quality pass", () => {
    const env = {
      ...validDevEnv(),
      MEDIA_CANONICAL_FORMAT: "webp",
      MEDIA_CANONICAL_QUALITY: "85",
    };
    expect(validateBootEnv(env)).toEqual([]);
  });

  it("MEDIA_ALLOWLIST_IMAGE_JSON that is not a JSON string array → names the key", () => {
    const env = { ...validDevEnv(), MEDIA_ALLOWLIST_IMAGE_JSON: '{"image/jpeg":true}' };
    const issues = validateBootEnv(env);
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("MEDIA_ALLOWLIST_IMAGE_JSON:")).toBe(true);
    expect(issues[0]).toContain("JSON array of strings");
  });

  it("valid allowlists and presets pass", () => {
    const env = {
      ...validDevEnv(),
      MEDIA_ALLOWLIST_IMAGE_JSON: '["image/jpeg","image/png"]',
      MEDIA_ALLOWLIST_VIDEO_JSON: '["video/mp4"]',
      MEDIA_ALLOWLIST_AUDIO_JSON: '["audio/mpeg"]',
      MEDIA_PRESETS_JSON: "[]",
    };
    expect(validateBootEnv(env)).toEqual([]);
  });

  it('ACTIVITYPUB_ENABLED must be exactly "true" or "false" when set', () => {
    expect(validateBootEnv({ ...validDevEnv(), ACTIVITYPUB_ENABLED: "true" })).toEqual([]);
    expect(validateBootEnv({ ...validDevEnv(), ACTIVITYPUB_ENABLED: "false" })).toEqual([]);
    const issues = validateBootEnv({ ...validDevEnv(), ACTIVITYPUB_ENABLED: "TRUE" });
    expect(issues).toHaveLength(1);
    expect(issues[0].startsWith("ACTIVITYPUB_ENABLED:")).toBe(true);
  });
});

describe("assertBootEnv", () => {
  it("does not throw on a valid env", () => {
    expect(() => assertBootEnv(validDevEnv())).not.toThrow();
  });

  it("throws EnvBootValidationError carrying the issues, each naming its key", () => {
    const env = validDevEnv();
    delete env.SESSION_SECRET;
    delete env.COGNITO_USER_POOL_ID;
    let caught: unknown;
    try {
      assertBootEnv(env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvBootValidationError);
    const e = caught as EnvBootValidationError;
    expect(e.issues).toHaveLength(2);
    expect(e.issues.some((i) => i.startsWith("SESSION_SECRET:"))).toBe(true);
    expect(e.issues.some((i) => i.startsWith("COGNITO_USER_POOL_ID:"))).toBe(true);
    expect(e.message).toContain("SESSION_SECRET");
    expect(e.message).toContain("COGNITO_USER_POOL_ID");
  });

  it("an explicit stage argument overrides STAGE-based detection", () => {
    // Dev-shaped env, forced through the prod rules: salt + thresholds missing.
    const env = validDevEnv();
    expect(() => assertBootEnv(env, "prod")).toThrow(EnvBootValidationError);
    expect(() => assertBootEnv(env, "dev")).not.toThrow();
  });
});
