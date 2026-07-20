/**
 * [F3] verifyKeycloakProfileLockdownAtBoot — the trellis boot wiring for the
 * foundation KeycloakIdentityProvider.verifyProfileLockdown() health-check.
 *
 * Covers the three boot outcomes:
 *  - Cognito (default) → no-op, the check never runs;
 *  - Keycloak + KC_SKIP_PROFILE_LOCKDOWN_CHECK=true → skipped with a loud warn;
 *  - Keycloak (no skip flag) → the check runs and a lockdown failure propagates
 *    (so startServer fails boot).
 *
 * The port is injected via the identity-provider seam; the fake exposes
 * `verifyProfileLockdown` so the wiring is exercised without a real provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setIdentityProviderForTest,
  verifyKeycloakProfileLockdownAtBoot,
} from "../../../src/lib/identity/identity-provider.js";

const ENV_KEYS = ["IDENTITY_PROVIDER", "KC_SKIP_PROFILE_LOCKDOWN_CHECK"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

/** A port exposing a spied verifyProfileLockdown (present on the Keycloak adapter). */
function lockdownPort(behavior: () => Promise<void>) {
  const verifyProfileLockdown = vi.fn(behavior);
  return {
    verifyProfileLockdown,
    port: {
      initiateMagicLink: async () => ({ emailSent: true }),
      deleteUser: async () => {},
      verifyProfileLockdown,
    } as any,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __setIdentityProviderForTest(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setIdentityProviderForTest(null);
  vi.restoreAllMocks();
});

describe("verifyKeycloakProfileLockdownAtBoot (F3)", () => {
  it("no-ops on the default (cognito) provider — the check never runs", async () => {
    const { verifyProfileLockdown, port } = lockdownPort(async () => {});
    __setIdentityProviderForTest(port); // cachedKind = cognito (flag unset)
    const logger = fakeLogger();

    await expect(verifyKeycloakProfileLockdownAtBoot(logger)).resolves.toBeUndefined();
    expect(verifyProfileLockdown).not.toHaveBeenCalled();
  });

  it("runs the check on keycloak and RESOLVES when the lockdown holds", async () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    const { verifyProfileLockdown, port } = lockdownPort(async () => {});
    __setIdentityProviderForTest(port);
    const logger = fakeLogger();

    await expect(verifyKeycloakProfileLockdownAtBoot(logger)).resolves.toBeUndefined();
    expect(verifyProfileLockdown).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it("PROPAGATES a lockdown failure on keycloak (fails boot)", async () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    const { port } = lockdownPort(async () => {
      throw new Error("lockdown FAILED: custom:globalRole is user-editable");
    });
    __setIdentityProviderForTest(port);

    await expect(verifyKeycloakProfileLockdownAtBoot(fakeLogger())).rejects.toThrow(
      /lockdown FAILED/,
    );
  });

  it("SKIPS with a loud warning when KC_SKIP_PROFILE_LOCKDOWN_CHECK=true", async () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    process.env.KC_SKIP_PROFILE_LOCKDOWN_CHECK = "true";
    const { verifyProfileLockdown, port } = lockdownPort(async () => {
      throw new Error("would fail if run");
    });
    __setIdentityProviderForTest(port);
    const logger = fakeLogger();

    await expect(verifyKeycloakProfileLockdownAtBoot(logger)).resolves.toBeUndefined();
    expect(verifyProfileLockdown).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain("KC_SKIP_PROFILE_LOCKDOWN_CHECK");
  });
});
