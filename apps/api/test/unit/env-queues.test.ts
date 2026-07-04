/**
 * Unit Tests: env.ts SQS queue wiring
 *
 * Regression guard against a queue field on the built env being `undefined`:
 * a service that does `this.queue = env.SOME_QUEUE` and later
 * `await this.queue.send(...)` throws "Cannot read properties of undefined
 * (reading 'send')" — surfaced as a generic 500.
 *
 * These tests assert every SQS-backed queue field on the built env is defined
 * and is a real `SqsQueue` adapter (the same path production uses), with no AWS
 * call: `buildEnv()` constructs the SQS client but does not contact SQS until a
 * `.send()` is issued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqsQueue } from "@de-otio/saas-foundation/queue";

// ── env isolation ─────────────────────────────────────────────────────────────

const MANAGED_KEYS = [
  "SESSION_SECRET",
  "DATABASE_URL",
  "MEDIA_BUCKET_NAME",
  "STAGE",
  "APP_NAME",
] as const;

let savedEnv: Partial<Record<string, string>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_KEYS) {
    savedEnv[key] = process.env[key];
  }
  // Minimal env for buildEnv() to return without throwing: a local
  // SESSION_SECRET (skips Secrets Manager) and a DATABASE_URL placeholder.
  process.env.SESSION_SECRET = "local-session-secret-minimum-32-chars!!";
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
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildEnv — SQS queue wiring", () => {
  // Every queue field the application's services read off env, paired with the
  // queue-name constituent `sqsUrl()` builds for it.
  const QUEUE_FIELDS = [
    ["EXPORT_QUEUE", "user-export"],
    ["DELETE_ACCOUNT_QUEUE", "delete-account"],
    ["FOLLOWERS_EVENTS_QUEUE", "followers-events"],
    ["LINK_CHECK_QUEUE", "link-check"],
    ["MEDIA_PROCESSING_QUEUE", "media-processing"],
  ] as const;

  it.each(QUEUE_FIELDS)(
    "wires %s as a defined SqsQueue (so .send() does not throw on undefined)",
    async (field) => {
      const { buildEnv } = await import("../../src/env.js");
      const env = await buildEnv();

      const queue = (env as Record<string, unknown>)[field];
      expect(queue, `${field} must be defined`).toBeDefined();
      expect(queue).toBeInstanceOf(SqsQueue);
    },
  );
});

describe("buildEnv — MEDIA_BUCKET_NAME resolution (image-moderation ref bucket)", () => {
  // Regression guard for the silent fail-closed bug: the staging WRITE goes to
  // the MEDIA_BUCKET_R2 binding (which wraps the `${stage}-${appName}-media`
  // fallback when MEDIA_BUCKET_NAME is unset), while the moderation READ ref
  // must use the SAME resolved name. If the call site re-derived the name (or
  // used `process.env.MEDIA_BUCKET_NAME ?? ""`), the ref would be "" when the
  // env var is unset, every image would fail-closed to REVIEW, and nothing
  // would serve. env.MEDIA_BUCKET_NAME must therefore expose the resolved
  // fallback, never "".

  it("falls back to ${stage}-${appName}-media when MEDIA_BUCKET_NAME is unset (NOT empty string)", async () => {
    // Unset all three so the fallback is fully deterministic. STAGE is read into
    // a module-level const at import time, so reset the module graph first.
    delete process.env.MEDIA_BUCKET_NAME;
    delete process.env.STAGE;
    delete process.env.APP_NAME;
    vi.resetModules();

    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    // stage defaults to "dev", appName defaults to "trellis".
    expect(env.MEDIA_BUCKET_NAME).toBe("dev-trellis-media");
    // The load-bearing invariant: the resolved name is never the empty string
    // (which is what `?? ""` would have produced and what fail-closes uploads).
    expect(env.MEDIA_BUCKET_NAME).not.toBe("");
    expect(env.MEDIA_BUCKET_NAME.length).toBeGreaterThan(0);
  });

  it("honours an explicit MEDIA_BUCKET_NAME", async () => {
    process.env.MEDIA_BUCKET_NAME = "explicit-media-bucket";
    vi.resetModules();

    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    expect(env.MEDIA_BUCKET_NAME).toBe("explicit-media-bucket");
  });
});
