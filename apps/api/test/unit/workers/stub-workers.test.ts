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

describe("runLinkCheck (LIVE SECURITY CONTROL)", () => {
  it("throws (fail-closed) on any payload", async () => {
    await expect(runLinkCheck({ any: "payload" }, { logger: makeLogger() })).rejects.toThrow(
      /failing closed/,
    );
  });

  it("throws even on an empty payload — there is no acking path at all", async () => {
    await expect(runLinkCheck(undefined, { logger: makeLogger() })).rejects.toThrow(
      /not implemented/,
    );
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
