/**
 * Unit Tests: ActivityPub federation route gate (production serving path)
 *
 * Hono is the sole production router (`buildHonoApp`). Federation is disabled by
 * default; the federation-facing routes (actor / inbox / outbox / webfinger /
 * public AP-object endpoints) must NOT be mounted unless
 * `ACTIVITYPUB_ENABLED === "true"`, so a federation-off deploy exposes no AP
 * surface — including to a request that bypasses CloudFront and hits an
 * internet-facing ALB directly. The authenticated `/api/*` app endpoints (the
 * DM API, the audiences API) stay mounted in both modes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildHonoApp } from "../../src/lib/app.js";

// Public, federation-facing endpoints that must NOT be mounted when off.
const FEDERATION_PATHS = [
  "/.well-known/webfinger",
  "/users/:username",
  "/users/:username/inbox", // unauthenticated ingress — the highest-risk one
  "/users/:username/outbox",
  "/users/:username/followers",
  "/groups/:groupId/inbox",
  "/entities/:entityType/:entityId",
  "/posts/:postId",
  "/messages/:messageId", // public AP-object form of a DM (unauthenticated)
  "/audiences/:audienceId",
];

// Authenticated app endpoints that must stay mounted regardless of the flag.
const APP_PATHS = ["/api/messages", "/api/audiences", "/health"];

function registeredPaths(value: string | undefined): Set<string> {
  if (value === undefined) delete process.env.ACTIVITYPUB_ENABLED;
  else process.env.ACTIVITYPUB_ENABLED = value;
  try {
    // buildHonoApp reads ACTIVITYPUB_ENABLED at call time.
    return new Set(buildHonoApp().routes.map((r) => r.path));
  } finally {
    delete process.env.ACTIVITYPUB_ENABLED;
  }
}

afterEach(() => {
  delete process.env.ACTIVITYPUB_ENABLED;
});

describe("ActivityPub route gate (buildHonoApp)", () => {
  it("does not mount federation-facing routes when the flag is unset (default)", () => {
    const paths = registeredPaths(undefined);
    for (const p of FEDERATION_PATHS) {
      expect(paths.has(p), `${p} should NOT be mounted`).toBe(false);
    }
  });

  it('does not mount federation routes unless the flag is exactly "true"', () => {
    for (const value of ["false", "1", "yes", "TRUE", " true "]) {
      const paths = registeredPaths(value);
      expect(
        paths.has("/users/:username/inbox"),
        `inbox should be absent for ACTIVITYPUB_ENABLED=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it('mounts all federation-facing routes when the flag is "true"', () => {
    const paths = registeredPaths("true");
    for (const p of FEDERATION_PATHS) {
      expect(paths.has(p), `${p} should be mounted`).toBe(true);
    }
  });

  it("keeps authenticated /api app endpoints mounted in both modes", () => {
    const off = registeredPaths(undefined);
    const on = registeredPaths("true");
    for (const p of APP_PATHS) {
      expect(off.has(p), `${p} mounted when off`).toBe(true);
      expect(on.has(p), `${p} mounted when on`).toBe(true);
    }
  });
});
