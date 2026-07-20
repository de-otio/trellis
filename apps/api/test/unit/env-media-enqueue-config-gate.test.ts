/**
 * WS-2 §4 finding 1 (test-critique F1) — startup/config-time gate:
 * MEDIA_ENQUEUE_ON_COMPLETE=true REQUIRES a MEDIA_PROCESSING_QUEUE binding.
 *
 * Without this gate a flag-on/queue-missing deployment would reach
 * `completeSession`'s enqueue branches with a falsy queue and (pre-fix)
 * silently flip sessions to "uploaded" WITHOUT a moderation job —
 * permanently unmoderated media once Deploy 2 removes the S3 notification.
 * `validateEnv` must refuse to start such a deployment.
 */

import { describe, expect, it } from "vitest";
import { validateEnv, type Env } from "../../src/env.js";

const GATE_RE = /MEDIA_ENQUEUE_ON_COMPLETE is true but MEDIA_PROCESSING_QUEUE is missing/;

function makeEnv(overrides: Partial<Env>): Env {
  return {
    SESSION_SECRET: "0123456789abcdef0123456789abcdef", // 32 chars — passes S1.4
    COGNITO_USER_POOL_ID: "pool",
    COGNITO_APP_CLIENT_ID: "client",
    INVITATIONS_KV: {},
    ...overrides,
  } as unknown as Env;
}

describe("validateEnv — media enqueue-on-complete config gate (finding 1)", () => {
  it("REFUSES startup when the flag is ON but the queue binding is missing", () => {
    const errors = validateEnv(
      makeEnv({
        MEDIA_ENQUEUE_ON_COMPLETE: true,
        MEDIA_PROCESSING_QUEUE: undefined as never,
      }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(true);
  });

  it("passes when the flag is ON and the queue is wired", () => {
    const errors = validateEnv(
      makeEnv({
        MEDIA_ENQUEUE_ON_COMPLETE: true,
        MEDIA_PROCESSING_QUEUE: { send: async () => {} } as never,
      }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(false);
  });

  it("passes when the flag is OFF regardless of the queue binding (AWS default)", () => {
    const errors = validateEnv(
      makeEnv({
        MEDIA_ENQUEUE_ON_COMPLETE: false,
        MEDIA_PROCESSING_QUEUE: undefined as never,
      }),
    );
    expect(errors.some((e) => GATE_RE.test(e))).toBe(false);
  });
});
