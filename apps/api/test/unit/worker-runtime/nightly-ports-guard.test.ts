/**
 * Plan 015 WS-B — nightly-cron boot guard.
 *
 * The scheduled-deletion core deletes the external identity best-effort and
 * SILENTLY skips it when the identity port is absent. This guard turns "nightly
 * enabled without an identity port" into a boot failure (crash-loop + alarm)
 * instead of a silent partial GDPR deletion. Email absence is a warning only —
 * the confirmation email is not part of the erasure.
 */

import { describe, expect, it, vi } from "vitest";
import { assertNightlyPortsWired } from "../../../src/lib/workers/nightly-ports-guard.js";

const port = { deleteUser: vi.fn() }; // any non-nullish stands in for a wired port

function makeLogger() {
  return { warn: vi.fn() };
}

describe("assertNightlyPortsWired", () => {
  it("no-ops when the nightly cron is parked, regardless of ports", () => {
    const logger = makeLogger();
    expect(() =>
      assertNightlyPortsWired({ nightlyEnabled: false, identity: undefined, email: undefined, logger }),
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws when nightly is enabled but the identity port is absent", () => {
    const logger = makeLogger();
    expect(() =>
      assertNightlyPortsWired({ nightlyEnabled: true, identity: undefined, email: port, logger }),
    ).toThrow(/identity-admin port is unwired/);
  });

  it("treats null identity the same as undefined (throws)", () => {
    const logger = makeLogger();
    expect(() =>
      assertNightlyPortsWired({ nightlyEnabled: true, identity: null, email: port, logger }),
    ).toThrow(/identity-admin port is unwired/);
  });

  it("warns (does not throw) when identity is wired but email is absent", () => {
    const logger = makeLogger();
    expect(() =>
      assertNightlyPortsWired({ nightlyEnabled: true, identity: port, email: undefined, logger }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/deletion-email port is unwired/));
  });

  it("passes silently when both ports are wired and nightly is enabled", () => {
    const logger = makeLogger();
    expect(() =>
      assertNightlyPortsWired({ nightlyEnabled: true, identity: port, email: port, logger }),
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
