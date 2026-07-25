/**
 * WS-3.3 identity-provider selection + Cognito adapter parity tests.
 *
 * The load-bearing assertions:
 *  - `IDENTITY_PROVIDER` defaults to cognito (zero-AWS-change invariant, the
 *    WS-1 `KV_PROVIDER` pattern);
 *  - the Cognito adapter drives the EXISTING InitiateAuth CUSTOM_AUTH path and
 *    the EXISTING AdminDeleteUser call byte-identically (X6 absorption);
 *  - the keycloak path derives its config from `OIDC_ISSUER_URL` /
 *    `OIDC_APP_CLIENT_ID` (per manifest D8 (draft)) and fails closed;
 *  - `makeIdentityAdminPort` preserves the old "no pool configured → skip"
 *    undefined.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminDeleteUserCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  IdentityProviderError,
  KeycloakIdentityProvider,
} from "@de-otio/saas-foundation/identity";

import {
  CognitoIdentityProvider,
  type CognitoClientLike,
} from "../../../src/lib/identity/cognito-identity-provider.js";
import {
  __setIdentityProviderForTest,
  getIdentityProvider,
  makeIdentityAdminPort,
  resolveIdentityProviderKind,
  splitKeycloakIssuer,
} from "../../../src/lib/identity/identity-provider.js";
import type { IdentityAdminPort } from "../../../src/lib/workers/identity-admin-port.js";

const ENV_KEYS = [
  "IDENTITY_PROVIDER",
  "OIDC_ISSUER_URL",
  "OIDC_APP_CLIENT_ID",
  "IDENTITY_ADMIN_CLIENT_ID",
  "IDENTITY_ADMIN_CLIENT_SECRET",
  "COGNITO_USER_POOL_ID",
  "COGNITO_APP_CLIENT_ID",
  "COGNITO_REGION",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  __setIdentityProviderForTest(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setIdentityProviderForTest(null);
});

function fakeCognitoClient(): { client: CognitoClientLike; sent: object[] } {
  const sent: object[] = [];
  return {
    sent,
    client: {
      send: async (command) => {
        sent.push(command);
        if (command instanceof InitiateAuthCommand) {
          return { ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-1" };
        }
        return {};
      },
    },
  };
}

describe("resolveIdentityProviderKind", () => {
  it("defaults to cognito (zero AWS change)", () => {
    expect(resolveIdentityProviderKind()).toBe("cognito");
  });
  it("selects keycloak only on the exact flag value", () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    expect(resolveIdentityProviderKind()).toBe("keycloak");
    process.env.IDENTITY_PROVIDER = "anything-else";
    expect(resolveIdentityProviderKind()).toBe("cognito");
  });
});

describe("CognitoIdentityProvider (existing-surface parity)", () => {
  const OPTS = { expirationSeconds: 300, redirectUri: "https://app.example.test/auth/verify" };

  it("fails closed on a missing pool", () => {
    expect(
      () => new CognitoIdentityProvider({ userPoolId: "", appClientId: "c" }),
    ).toThrowError(IdentityProviderError);
  });

  it("constructs without an app client (X6 pool-only wiring) but fails closed on initiate", async () => {
    const { client } = fakeCognitoClient();
    const provider = new CognitoIdentityProvider({ userPoolId: "pool-1", client });
    await expect(provider.initiateMagicLink("x@example.test", OPTS)).rejects.toMatchObject({
      reason: "config_missing",
    });
    // …while the admin slice still works from the pool alone.
    await expect(provider.deleteUser({ email: "x@example.test" })).resolves.toBeUndefined();
  });

  it("initiates the existing CUSTOM_AUTH flow and returns the Session handle", async () => {
    const { client, sent } = fakeCognitoClient();
    const provider = new CognitoIdentityProvider({
      userPoolId: "pool-1",
      appClientId: "client-1",
      client,
    });
    const result = await provider.initiateMagicLink("user@example.test", OPTS);
    expect(result).toEqual({ handle: "sess-1", emailSent: true });

    const cmd = sent[0] as InitiateAuthCommand;
    expect(cmd).toBeInstanceOf(InitiateAuthCommand);
    expect(cmd.input).toEqual({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: "client-1",
      AuthParameters: { USERNAME: "user@example.test" },
    });
  });

  it("maps UserNotFoundException to unknown_user (never surfaced raw)", async () => {
    const provider = new CognitoIdentityProvider({
      userPoolId: "pool-1",
      appClientId: "client-1",
      client: {
        send: async () => {
          const err = new Error("no user");
          err.name = "UserNotFoundException";
          throw err;
        },
      },
    });
    await expect(provider.initiateMagicLink("x@example.test", OPTS)).rejects.toMatchObject({
      reason: "unknown_user",
    });
  });

  it("deleteUser sends the byte-identical AdminDeleteUser call (X6)", async () => {
    const { client, sent } = fakeCognitoClient();
    const provider = new CognitoIdentityProvider({
      userPoolId: "pool-1",
      appClientId: "client-1",
      client,
    });
    await provider.deleteUser({ email: "user@example.test" });
    const cmd = sent[0] as AdminDeleteUserCommand;
    expect(cmd).toBeInstanceOf(AdminDeleteUserCommand);
    expect(cmd.input).toEqual({ UserPoolId: "pool-1", Username: "user@example.test" });
  });

  it("deleteUser propagates SDK errors UNWRAPPED (best-effort callers unchanged)", async () => {
    const sdkError = Object.assign(new Error("gone"), { name: "UserNotFoundException" });
    const provider = new CognitoIdentityProvider({
      userPoolId: "pool-1",
      appClientId: "client-1",
      client: {
        send: async () => {
          throw sdkError;
        },
      },
    });
    await expect(provider.deleteUser({ email: "x@example.test" })).rejects.toBe(sdkError);
  });

  it("satisfies the narrow IdentityAdminPort slice (X6 structural superset)", () => {
    const { client } = fakeCognitoClient();
    const provider = new CognitoIdentityProvider({
      userPoolId: "p",
      appClientId: "c",
      client,
    });
    const slice: IdentityAdminPort = provider; // compile-time structural check
    expect(typeof slice.deleteUser).toBe("function");
  });
});

describe("getIdentityProvider factory", () => {
  it("builds the Cognito adapter from COGNITO_* by default", () => {
    process.env.COGNITO_USER_POOL_ID = "pool-1";
    process.env.COGNITO_APP_CLIENT_ID = "client-1";
    expect(getIdentityProvider()).toBeInstanceOf(CognitoIdentityProvider);
  });

  it("fails closed when the cognito pool is missing", () => {
    expect(() => getIdentityProvider()).toThrowError(IdentityProviderError);
  });

  it("builds the Cognito adapter from the pool alone (X6 admin-slice wiring)", () => {
    process.env.COGNITO_USER_POOL_ID = "pool-1";
    expect(getIdentityProvider()).toBeInstanceOf(CognitoIdentityProvider);
  });

  it("builds the Keycloak adapter from the D8 (draft) vars", () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    process.env.OIDC_ISSUER_URL = "https://id.example.test/realms/skybber-dev";
    process.env.OIDC_APP_CLIENT_ID = "trellis-app";
    process.env.IDENTITY_ADMIN_CLIENT_ID = "trellis-api";
    process.env.IDENTITY_ADMIN_CLIENT_SECRET = "svc-secret";
    const provider = getIdentityProvider();
    expect(provider).toBeInstanceOf(KeycloakIdentityProvider);
    expect((provider as KeycloakIdentityProvider).issuerUrl).toBe(
      "https://id.example.test/realms/skybber-dev",
    );
  });

  it("fails closed on a non-Keycloak-shaped OIDC_ISSUER_URL", () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    process.env.OIDC_ISSUER_URL = "https://cognito-idp.us-east-1.amazonaws.com/pool-1";
    process.env.OIDC_APP_CLIENT_ID = "trellis-app";
    process.env.IDENTITY_ADMIN_CLIENT_ID = "trellis-api";
    process.env.IDENTITY_ADMIN_CLIENT_SECRET = "svc-secret";
    expect(() => getIdentityProvider()).toThrowError(/realms/);
  });

  it("fails closed when keycloak service credentials are missing", () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    process.env.OIDC_ISSUER_URL = "https://id.example.test/realms/skybber-dev";
    process.env.OIDC_APP_CLIENT_ID = "trellis-app";
    expect(() => getIdentityProvider()).toThrowError(IdentityProviderError);
  });
});

describe("splitKeycloakIssuer", () => {
  it("splits base and realm, tolerating a trailing slash", () => {
    expect(splitKeycloakIssuer("https://id.example.test/realms/r1")).toEqual({
      baseUrl: "https://id.example.test",
      realm: "r1",
    });
    expect(splitKeycloakIssuer("https://id.example.test/realms/r1/")).toEqual({
      baseUrl: "https://id.example.test",
      realm: "r1",
    });
  });
  it("rejects non-realm shapes", () => {
    expect(() => splitKeycloakIssuer("https://id.example.test")).toThrowError(
      IdentityProviderError,
    );
  });
});

describe("makeIdentityAdminPort (WS-2 wiring parity)", () => {
  it("returns undefined when no pool is configured (old skip semantics)", () => {
    expect(makeIdentityAdminPort()).toBeUndefined();
  });
  it("returns the shared adapter when the pool is configured", () => {
    process.env.COGNITO_USER_POOL_ID = "pool-1";
    process.env.COGNITO_APP_CLIENT_ID = "client-1";
    expect(makeIdentityAdminPort()).toBeInstanceOf(CognitoIdentityProvider);
  });
  it("returns undefined when keycloak is selected but unconfigured", () => {
    process.env.IDENTITY_PROVIDER = "keycloak";
    expect(makeIdentityAdminPort()).toBeUndefined();
  });
});
