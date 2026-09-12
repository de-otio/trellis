/**
 * Unit tests — the three fail-closed stub worker cores (WS-2 T5).
 *
 * These stubs guard live/future security work: the assertion that they
 * THROW (never return, never "ack-drop") on any payload is the load-bearing
 * one — the container dispatcher maps a throw to no-ack (finding 3).
 */

import { describe, expect, it, vi } from "vitest";
import { runLinkCheck } from "../../../src/lib/workers/link-check.js";
import { runFollowersEvents } from "../../../src/lib/workers/followers-events.js";
import { runFederationOutbox } from "../../../src/lib/workers/federation-outbox.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

// link-check is no longer a stub — it resolves a pending LinkCheck row via the
// injected threat-intel port. What survives from the stub era is the
// fail-closed rule: every path that cannot obtain a verdict must throw rather
// than ack, so an unchecked link never looks like a cleared one. Those cases
// are exercised here; the verdict-recording behaviour lives in
// test/unit/workers/link-check.test.ts.
describe("runLinkCheck (LIVE SECURITY CONTROL) — fail-closed paths", () => {
  const message = { linkCheckId: "lc_1", url: "https://example.com", domain: "example.com" };

  function makeDb() {
    return { linkCheck: { update: vi.fn() } } as never;
  }

  it("throws when no threat-intel port is injected", async () => {
    await expect(
      runLinkCheck(message, { logger: makeLogger(), db: makeDb() }),
    ).rejects.toThrow(/failing closed/);
  });

  it("throws on a payload with no linkCheckId — there is no acking path", async () => {
    await expect(
      runLinkCheck(undefined, { logger: makeLogger(), db: makeDb() }),
    ).rejects.toThrow(/not an object/);
  });

  it("throws rather than recording a verdict when the lookup fails transiently", async () => {
    const db = makeDb();
    await expect(
      runLinkCheck(message, {
        logger: makeLogger(),
        db,
        linkThreatIntel: {
          check: async () => ({
            status: "unknown" as const,
            failOpenReason: "api-error",
            retryable: true,
          }),
        },
      }),
    ).rejects.toThrow(/api-error/);
    // The row must stay `pending` — a retry may yet produce a real verdict.
    expect((db as never as { linkCheck: { update: ReturnType<typeof vi.fn> } }).linkCheck.update)
      .not.toHaveBeenCalled();
  });
});

describe("runFollowersEvents", () => {
  it("throws (fail-closed) on any payload", async () => {
    await expect(
      runFollowersEvents({ any: "payload" }, { logger: makeLogger() }),
    ).rejects.toThrow(/failing closed/);
  });
});

describe("runFederationOutbox (two-mode)", () => {
  it("feature OFF (default): RETURNS (ack) and logs a warning — never throws/pages", async () => {
    const logger = makeLogger();
    await expect(
      runFederationOutbox({ any: "payload" }, { logger, federationEnabled: false }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("feature ON: throws (fail-closed) so deliveries are never silently dropped", async () => {
    await expect(
      runFederationOutbox({ any: "payload" }, { logger: makeLogger(), federationEnabled: true }),
    ).rejects.toThrow(/failing closed/);
  });
});
