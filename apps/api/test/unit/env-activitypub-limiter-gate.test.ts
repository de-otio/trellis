/**
 * DP-13 — startup gate: ACTIVITYPUB_ENABLED requires a SHARED rate limiter.
 *
 * Without KV_PROVIDER=postgres (or a RATE_LIMIT_TABLE) the token-bucket
 * limiter silently becomes per-process memory, so the federation inbox's
 * per-instance ceiling is really `limit × replicas` and a rolling deploy
 * clears it. `validateEnv` must refuse to start such a deployment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnv, type Env } from "../../src/env.js";

const GATE_RE = /rate limiter would be per-process memory/;

function makeEnv(overrides: Partial<Env>): Env {
  return {
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    COGNITO_USER_POOL_ID: "pool",
    COGNITO_APP_CLIENT_ID: "client",
    INVITATIONS_KV: {},
    // A valid 32-byte KEK so the sibling federation assert stays quiet.
    ACTIVITYPUB_KEY_ENCRYPTION_KEY: "00".repeat(32),
    ...overrides,
  } as unknown as Env;
}

describe("validateEnv — ActivityPub shared-limiter gate (DP-13)", () => {
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.KV_PROVIDER;
    delete process.env.KV_PROVIDER;
  });

  afterEach(() => {
    if (savedProvider === undefined) delete process.env.KV_PROVIDER;
    else process.env.KV_PROVIDER = savedProvider;
  });

  it("REFUSES startup when federation is on and the limiter is memory-only", () => {
    const errors = validateEnv(
      makeEnv({ ACTIVITYPUB_ENABLED: true, RATE_LIMIT_TABLE: undefined }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(true);
  });

  it("passes with KV_PROVIDER=postgres", () => {
    process.env.KV_PROVIDER = "postgres";
    const errors = validateEnv(
      makeEnv({ ACTIVITYPUB_ENABLED: true, RATE_LIMIT_TABLE: undefined }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(false);
  });

  it("passes with a RATE_LIMIT_TABLE", () => {
    const errors = validateEnv(
      makeEnv({ ACTIVITYPUB_ENABLED: true, RATE_LIMIT_TABLE: "buckets" }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(false);
  });

  it("does not fire when federation is off", () => {
    const errors = validateEnv(
      makeEnv({ ACTIVITYPUB_ENABLED: false, RATE_LIMIT_TABLE: undefined }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(false);
  });
});
