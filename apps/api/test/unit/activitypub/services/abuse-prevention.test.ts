/**
 * Tests for ActivityPub abuse prevention (F6).
 *
 * The previous suite largely asserted the DEFECT: that `detectAbuse` returns
 * false for everything, and that an error in a check still admits the
 * activity. Those expectations are inverted here, because the behaviour is.
 *
 * What must hold now:
 *   - a blocked instance is refused before any budget is spent
 *   - rate limits are keyed by INSTANCE DOMAIN and shared, not per-actor and
 *     per-process
 *   - a check that cannot run is a REFUSAL, never an admission
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  admitActivity,
  checkRateLimit,
  detectAbuse,
  instanceDomainOf,
  isDomainBlocked,
  parseBlockedDomains,
  validateActivity,
  DEFAULT_RATE_LIMITS,
} from "../../../../src/lib/activitypub/services/abuse-prevention.js";
import type { Env } from "../../../../src/env.js";

const consumeSharedBucket = vi.fn();
vi.mock("../../../../src/lib/rate-limit", () => ({
  consumeSharedBucket: (...args: unknown[]) => consumeSharedBucket(...args),
}));

const allowed = { allowed: true, remaining: 59, resetAt: Date.now() + 60_000 };
const denied = {
  allowed: false,
  remaining: 0,
  resetAt: Date.now() + 60_000,
  retryAfter: 30,
};

const mockEnv: Partial<Env> = {
  LOG_LEVEL: "INFO",
  ACTIVITYPUB_BASE_URL: "https://example.com",
  DATABASE_URL: "postgresql://test",
};

const activity = { type: "Create", actor: "https://remote.example/users/a" };

beforeEach(() => {
  vi.clearAllMocks();
  consumeSharedBucket.mockResolvedValue(allowed);
});

describe("blocklist parsing and matching", () => {
  it("parses comma- and whitespace-separated lists", () => {
    const set = parseBlockedDomains("evil.example, spam.example\nbad.example");
    expect(set).toEqual(
      new Set(["evil.example", "spam.example", "bad.example"]),
    );
  });

  it("normalises leading dots and wildcards, and case", () => {
    expect(parseBlockedDomains(".Evil.Example, *.Spam.Example")).toEqual(
      new Set(["evil.example", "spam.example"]),
    );
  });

  it("returns an empty set for undefined or blank", () => {
    expect(parseBlockedDomains(undefined).size).toBe(0);
    expect(parseBlockedDomains("   ").size).toBe(0);
  });

  it("matches the domain itself and its subdomains", () => {
    const blocked = parseBlockedDomains("evil.example");
    expect(isDomainBlocked("evil.example", blocked)).toBe(true);
    expect(isDomainBlocked("mastodon.evil.example", blocked)).toBe(true);
    expect(isDomainBlocked("EVIL.EXAMPLE", blocked)).toBe(true);
  });

  it("does NOT match on a bare suffix across a label boundary", () => {
    // The classic off-by-one: `notevil.example` must not be caught by a block
    // on `evil.example`.
    const blocked = parseBlockedDomains("evil.example");
    expect(isDomainBlocked("notevil.example", blocked)).toBe(false);
    expect(isDomainBlocked("evil.example.co", blocked)).toBe(false);
  });

  it("matches nothing when the list is empty", () => {
    expect(isDomainBlocked("anything.example", new Set())).toBe(false);
  });
});

describe("instanceDomainOf", () => {
  it("extracts the host", () => {
    expect(instanceDomainOf("https://remote.example/users/a")).toBe(
      "remote.example",
    );
  });

  it("returns null for an unparseable URI", () => {
    expect(instanceDomainOf("not-a-uri")).toBeNull();
  });
});

describe("checkRateLimit — keyed by instance domain, shared store", () => {
  it("consumes a bucket keyed by DOMAIN, not by actor URI", async () => {
    await checkRateLimit("https://remote.example/users/alice", mockEnv as Env);

    expect(consumeSharedBucket).toHaveBeenCalledWith(
      expect.anything(),
      "ap:instance:remote.example",
      DEFAULT_RATE_LIMITS.requestsPerMinute,
      60,
    );
  });

  it("shares one bucket across every actor on an instance", async () => {
    // The old per-actor map gave an attacker a fresh bucket per minted actor
    // URI; the key must not vary with the actor.
    await checkRateLimit("https://remote.example/users/alice", mockEnv as Env);
    await checkRateLimit("https://remote.example/users/bob", mockEnv as Env);

    const keys = consumeSharedBucket.mock.calls.map((c) => c[1]);
    expect(new Set(keys).size).toBe(1);
  });

  it("honours a configured per-instance limit", async () => {
    await checkRateLimit("https://remote.example/users/alice", {
      ...mockEnv,
      ACTIVITYPUB_INSTANCE_RATE_LIMIT: "5",
    } as Env);

    expect(consumeSharedBucket).toHaveBeenCalledWith(
      expect.anything(),
      "ap:instance:remote.example",
      5,
      60,
    );
  });

  it("ignores a nonsense configured limit and uses the default", async () => {
    await checkRateLimit("https://remote.example/users/alice", {
      ...mockEnv,
      ACTIVITYPUB_INSTANCE_RATE_LIMIT: "not-a-number",
    } as Env);

    expect(consumeSharedBucket.mock.calls[0][2]).toBe(
      DEFAULT_RATE_LIMITS.requestsPerMinute,
    );
  });

  it("returns false when the bucket is exhausted", async () => {
    consumeSharedBucket.mockResolvedValue(denied);
    expect(
      await checkRateLimit("https://remote.example/users/a", mockEnv as Env),
    ).toBe(false);
  });

  it("returns false for an unparseable actor URI", async () => {
    expect(await checkRateLimit("nonsense", mockEnv as Env)).toBe(false);
    expect(consumeSharedBucket).not.toHaveBeenCalled();
  });

  it("PROPAGATES a limiter error so the caller can fail closed", async () => {
    consumeSharedBucket.mockRejectedValue(new Error("limiter down"));
    await expect(
      checkRateLimit("https://remote.example/users/a", mockEnv as Env),
    ).rejects.toThrow("limiter down");
  });
});

describe("detectAbuse", () => {
  it("treats a malformed activity as abusive", () => {
    expect(detectAbuse(null, "https://r.example/u", mockEnv as Env)).toBe(true);
    expect(detectAbuse("string", "https://r.example/u", mockEnv as Env)).toBe(
      true,
    );
    expect(detectAbuse({}, "https://r.example/u", mockEnv as Env)).toBe(true);
    expect(
      detectAbuse({ type: "" }, "https://r.example/u", mockEnv as Env),
    ).toBe(true);
  });

  it("passes a well-formed activity", () => {
    expect(detectAbuse(activity, "https://r.example/u", mockEnv as Env)).toBe(
      false,
    );
  });
});

describe("admitActivity — the admission gate", () => {
  it("admits a well-formed activity from an unblocked instance", async () => {
    const result = await admitActivity(
      activity,
      "https://remote.example/users/a",
      mockEnv as Env,
    );
    expect(result.admitted).toBe(true);
  });

  it("REFUSES a blocked instance", async () => {
    const result = await admitActivity(
      activity,
      "https://evil.example/users/a",
      { ...mockEnv, ACTIVITYPUB_BLOCKED_DOMAINS: "evil.example" } as Env,
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("blocked-instance");
  });

  it("REFUSES a subdomain of a blocked instance", async () => {
    const result = await admitActivity(
      activity,
      "https://mastodon.evil.example/users/a",
      { ...mockEnv, ACTIVITYPUB_BLOCKED_DOMAINS: "evil.example" } as Env,
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("blocked-instance");
  });

  it("checks the blocklist BEFORE spending rate-limit budget", async () => {
    await admitActivity(activity, "https://evil.example/users/a", {
      ...mockEnv,
      ACTIVITYPUB_BLOCKED_DOMAINS: "evil.example",
    } as Env);
    expect(consumeSharedBucket).not.toHaveBeenCalled();
  });

  it("REFUSES an actor URI with no derivable origin", async () => {
    const result = await admitActivity(activity, "nonsense", mockEnv as Env);
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("unresolvable-origin");
  });

  it("REFUSES when the instance is over its rate limit", async () => {
    consumeSharedBucket.mockResolvedValue(denied);
    const result = await admitActivity(
      activity,
      "https://remote.example/users/a",
      mockEnv as Env,
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("rate-limited");
  });

  it("FAILS CLOSED when the rate limiter is unavailable", async () => {
    // The old code returned "not abusive" on error, i.e. admitted the
    // activity. A check that could not run is not a pass.
    consumeSharedBucket.mockRejectedValue(new Error("limiter down"));
    const result = await admitActivity(
      activity,
      "https://remote.example/users/a",
      mockEnv as Env,
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("check-failed");
  });

  it("REFUSES a malformed activity", async () => {
    const result = await admitActivity(
      { actor: "https://remote.example/users/a" }, // no type
      "https://remote.example/users/a",
      mockEnv as Env,
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("abusive");
  });
});

describe("validateActivity (boolean wrapper)", () => {
  it("mirrors admitActivity", async () => {
    expect(
      await validateActivity(
        activity,
        "https://remote.example/users/a",
        mockEnv as Env,
      ),
    ).toBe(true);

    consumeSharedBucket.mockResolvedValue(denied);
    expect(
      await validateActivity(
        activity,
        "https://remote.example/users/a",
        mockEnv as Env,
      ),
    ).toBe(false);
  });
});
