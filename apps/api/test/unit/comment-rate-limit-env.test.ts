/**
 * The comment rate-limit config seam (`resolveCommentRateLimitEnv`).
 *
 * The middleware's own suite proves it HONOURS whatever config it is handed.
 * This proves the config arrives — the seam is the single writer of the
 * COMMENT_RATE_LIMIT_* vars, and a typo'd var name here would silently restore
 * the compiled-in numbers (and, worse, could restore fail-open) while every
 * middleware test still passed.
 */

import { describe, expect, it } from "vitest";
import { resolveCommentRateLimitEnv } from "../../src/env.js";

const empty = {} as NodeJS.ProcessEnv;

describe("resolveCommentRateLimitEnv", () => {
  it("defaults reproduce the previous compiled-in behaviour", () => {
    // A config seam, not a policy change — except failMode, below.
    expect(resolveCommentRateLimitEnv(empty).commentRateLimit).toEqual({
      perMinute: 10,
      postCooldownSeconds: 30,
      failMode: "closed",
    });
  });

  it("reads the documented env var names", () => {
    const { commentRateLimit } = resolveCommentRateLimitEnv({
      COMMENT_RATE_LIMIT_PER_MINUTE: "3",
      COMMENT_RATE_LIMIT_POST_COOLDOWN_SECONDS: "120",
      COMMENT_RATE_LIMIT_FAIL_MODE: "open",
    } as NodeJS.ProcessEnv);

    expect(commentRateLimit).toEqual({
      perMinute: 3,
      postCooldownSeconds: 120,
      failMode: "open",
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["misspelt", "opne"],
    ["uppercase", "OPEN"],
    ["padded", " open "],
    ["truthy-but-wrong", "true"],
  ])("resolves a %s fail-mode to closed", (_label, raw) => {
    expect(
      resolveCommentRateLimitEnv({
        COMMENT_RATE_LIMIT_FAIL_MODE: raw,
      } as NodeJS.ProcessEnv).commentRateLimit.failMode,
    ).toBe("closed");
  });

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "lots"],
    ["empty", ""],
  ])("falls back to the default ceiling on a %s value", (_label, raw) => {
    // A ceiling of 0 would block every comment; a negative one is nonsense.
    // Both must land on the default rather than be taken literally.
    expect(
      resolveCommentRateLimitEnv({
        COMMENT_RATE_LIMIT_PER_MINUTE: raw,
      } as NodeJS.ProcessEnv).commentRateLimit.perMinute,
    ).toBe(10);
  });

  it("does not read process.env when a source is injected", () => {
    // Single-writer discipline: the seam must be pure in its argument, or
    // tests and multi-tenant callers cannot reason about it.
    const before = process.env.COMMENT_RATE_LIMIT_PER_MINUTE;
    process.env.COMMENT_RATE_LIMIT_PER_MINUTE = "999";
    try {
      expect(resolveCommentRateLimitEnv(empty).commentRateLimit.perMinute).toBe(10);
    } finally {
      if (before === undefined) delete process.env.COMMENT_RATE_LIMIT_PER_MINUTE;
      else process.env.COMMENT_RATE_LIMIT_PER_MINUTE = before;
    }
  });
});
