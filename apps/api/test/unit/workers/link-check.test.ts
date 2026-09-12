/**
 * `runLinkCheck` — the verdict-recording half.
 *
 * The fail-closed paths (no port, transient failure, malformed payload) live in
 * `stub-workers.test.ts`, which is where they were asserted while this worker
 * was a stub. This file covers what the worker now does when it CAN obtain a
 * verdict, and the one case that is easy to get backwards: a non-retryable
 * "unknown" must resolve the row to `warning` rather than being retried
 * forever or silently treated as `safe`.
 */

import { describe, it, expect, vi } from "vitest";
import { runLinkCheck } from "../../../src/lib/workers/link-check.js";
import type { LinkThreatIntelPort } from "../../../src/lib/workers/context.js";

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

function makeDb() {
  const update = vi.fn().mockResolvedValue({});
  return { db: { linkCheck: { update } } as never, update };
}

function portReturning(
  verdict: Awaited<ReturnType<LinkThreatIntelPort["check"]>>,
): LinkThreatIntelPort {
  return { check: vi.fn().mockResolvedValue(verdict) };
}

const message = {
  linkCheckId: "lc_1",
  url: "https://example.com/a",
  domain: "example.com",
};

describe("runLinkCheck — recording a verdict", () => {
  it("resolves a clean link to safe", async () => {
    const { db, update } = makeDb();

    await runLinkCheck(message, {
      logger: makeLogger(),
      db,
      linkThreatIntel: portReturning({ status: "safe", retryable: false }),
    });

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: "lc_1" });
    expect(arg.data.status).toBe("safe");
    expect(arg.data.checkedAt).toBeInstanceOf(Date);
  });

  it("resolves a flagged link to blocked and keeps the threat list", async () => {
    const { db, update } = makeDb();

    await runLinkCheck(message, {
      logger: makeLogger(),
      db,
      linkThreatIntel: portReturning({
        status: "unsafe",
        threats: ["SOCIAL_ENGINEERING"],
        retryable: false,
      }),
    });

    const arg = update.mock.calls[0]![0];
    expect(arg.data.status).toBe("blocked");
    expect(arg.data.threatIntel).toMatchObject({
      status: "unsafe",
      threats: ["SOCIAL_ENGINEERING"],
    });
  });

  it("resolves a non-retryable unknown to warning, not safe", async () => {
    // A missing API key cannot be fixed by redelivering the message. Leaving
    // the row `pending` forever is worse than recording the link as
    // unverified, and `warning` is the status the synchronous path produces
    // for an unverified link — it drives the safety interstitial.
    const { db, update } = makeDb();

    await runLinkCheck(message, {
      logger: makeLogger(),
      db,
      linkThreatIntel: portReturning({
        status: "unknown",
        failOpenReason: "api-key-missing",
        retryable: false,
      }),
    });

    const arg = update.mock.calls[0]![0];
    expect(arg.data.status).toBe("warning");
    expect(arg.data.status).not.toBe("safe");
    expect(arg.data.threatIntel).toMatchObject({
      status: "unknown",
      failOpenReason: "api-key-missing",
    });
  });

  it("checks the url from the message, not the domain", async () => {
    // The domain is carried for logging; checking it instead of the full URL
    // would clear every path on a host whose root happens to be clean.
    const { db } = makeDb();
    const port = portReturning({ status: "safe", retryable: false });

    await runLinkCheck(message, {
      logger: makeLogger(),
      db,
      linkThreatIntel: port,
    });

    expect(port.check).toHaveBeenCalledWith("https://example.com/a");
  });

  it("rejects a payload whose linkCheckId is missing", async () => {
    const { db, update } = makeDb();

    await expect(
      runLinkCheck(
        { url: "https://example.com", domain: "example.com" },
        {
          logger: makeLogger(),
          db,
          linkThreatIntel: portReturning({ status: "safe", retryable: false }),
        },
      ),
    ).rejects.toThrow(/linkCheckId/);
    expect(update).not.toHaveBeenCalled();
  });
});
