/**
 * Unit Tests: env.ts SQS queue wiring
 *
 * Regression guard for the media-upload 500. `MediaUploadService` reads
 * `env.MEDIA_RECONCILIATION_QUEUE` in its constructor and calls `.send()` on it
 * during `uploadSingle()`. If `buildEnv()` does not produce that field the queue
 * is `undefined`, and the upload throws "Cannot read properties of undefined
 * (reading 'send')" after the R2 put succeeds — surfaced as a generic 500.
 *
 * These tests assert every SQS-backed queue field on the built env is defined
 * and is a real `SqsQueue` adapter (the same path production uses), with no AWS
 * call: `buildEnv()` constructs the SQS client but does not contact SQS until a
 * `.send()` is issued.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqsQueue } from "@de-otio/saas-foundation/queue";

// ── env isolation ─────────────────────────────────────────────────────────────

const MANAGED_KEYS = ["SESSION_SECRET", "DATABASE_URL"] as const;

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
    ["MEDIA_RECONCILIATION_QUEUE", "media-reconciliation"],
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

  it("MEDIA_RECONCILIATION_QUEUE is present — the exact field MediaUploadService.send() depends on", async () => {
    const { buildEnv } = await import("../../src/env.js");
    const env = await buildEnv();

    // The constructor does `this.queue = env.MEDIA_RECONCILIATION_QUEUE`, then
    // `uploadSingle()` does `await this.queue.send(message)`. A defined queue
    // exposing a `send` function is what keeps that call from throwing.
    expect(env.MEDIA_RECONCILIATION_QUEUE).toBeInstanceOf(SqsQueue);
    expect(
      typeof (env.MEDIA_RECONCILIATION_QUEUE as { send?: unknown }).send,
    ).toBe("function");
  });
});
