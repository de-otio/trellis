import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  UpdateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdpSdk,
  defaultOidcAttributeMapping,
  userPoolAdvisoryLockKey,
  withUserPoolClientLock,
  type AdvisoryLockClient,
} from "../../src/lib/cognito/idp-sdk.js";

const cog = mockClient(CognitoIdentityProviderClient);

/** The pool/client the adapter administers — its own config, not per-call args. */
const CFG = { userPoolId: "pool", appClientId: "client" };

/** Records the advisory lock the adapter takes on the caller's transaction. */
function lockRecorder(): AdvisoryLockClient & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
      statements.push(query.join("?") + " :: " + values.join(","));
      return 1;
    },
  };
}

beforeEach(() => {
  cog.reset();
});

describe("defaultOidcAttributeMapping", () => {
  it("maps email/given_name/family_name/idpGroups", () => {
    const m = defaultOidcAttributeMapping();
    expect(m.email).toBe("email");
    expect(m.given_name).toBe("given_name");
    expect(m.family_name).toBe("family_name");
    expect(m["custom:idpGroups"]).toBe("groups");
  });
});

describe("CognitoIdpSdk.createOidcProvider", () => {
  it("sends a CreateIdentityProviderCommand with OIDC details", async () => {
    cog.on(CreateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.createOidcProvider({
      providerName: "tenant-abc12",
      details: {
        clientId: "client",
        clientSecret: "shh",
        issuerUrl: "https://idp.example.com/",
        scopes: "openid email profile groups",
      },
      attributeMapping: defaultOidcAttributeMapping(),
      idpIdentifiers: ["acme.example.com"],
    });
    const call = cog.commandCalls(CreateIdentityProviderCommand)[0]!;
    const input = call.args[0].input;
    expect(input.UserPoolId).toBe("pool");
    expect(input.ProviderName).toBe("tenant-abc12");
    expect(input.ProviderType).toBe("OIDC");
    expect(input.ProviderDetails?.client_id).toBe("client");
    expect(input.ProviderDetails?.client_secret).toBe("shh");
    expect(input.ProviderDetails?.oidc_issuer).toBe("https://idp.example.com/");
    expect(input.ProviderDetails?.attributes_request_method).toBe("GET");
    expect(input.ProviderDetails?.authorize_scopes).toBe("openid email profile groups");
    expect(input.AttributeMapping?.email).toBe("email");
    expect(input.IdpIdentifiers).toEqual(["acme.example.com"]);
  });

  it("propagates Cognito errors so the route handler can roll back", async () => {
    cog.on(CreateIdentityProviderCommand).rejects(
      Object.assign(new Error("invalid"), { name: "InvalidParameterException" }),
    );
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await expect(
      sdk.createOidcProvider({
        providerName: "tenant-abc12",
        details: {
          clientId: "client",
          clientSecret: "shh",
          issuerUrl: "https://idp.example.com/",
        },
        endpoints: { authorizationUrl: "a", tokenUrl: "t", jwksUrl: "j" },
        attributeMapping: defaultOidcAttributeMapping(),
        idpIdentifiers: [],
      }),
    ).rejects.toThrow(/invalid/);
  });
});

describe("CognitoIdpSdk.updateOidcProvider", () => {
  it("only sets ProviderDetails when at least one OIDC field changes", async () => {
    cog.on(UpdateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.updateOidcProvider({
      providerName: "tenant-abc12",
      details: { clientSecret: "rotated" },
    });
    const call = cog.commandCalls(UpdateIdentityProviderCommand)[0]!;
    expect(call.args[0].input.ProviderDetails?.client_secret).toBe("rotated");
    expect(call.args[0].input.ProviderDetails?.attributes_request_method).toBe("GET");
    expect(call.args[0].input.AttributeMapping).toBeUndefined();
    expect(call.args[0].input.IdpIdentifiers).toBeUndefined();
  });

  it("sends only the fields the caller specified (e.g. attribute mapping only)", async () => {
    cog.on(UpdateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.updateOidcProvider({
      providerName: "tenant-abc12",
      attributeMapping: { email: "mail", given_name: undefined },
    });
    const call = cog.commandCalls(UpdateIdentityProviderCommand)[0]!;
    expect(call.args[0].input.AttributeMapping).toEqual({ email: "mail" });
    expect(call.args[0].input.ProviderDetails).toBeUndefined();
  });

  it("supports updating the IdpIdentifiers list (verified-domain change)", async () => {
    cog.on(UpdateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.updateOidcProvider({
      providerName: "tenant-abc12",
      idpIdentifiers: ["a.example.com", "b.example.com"],
    });
    const call = cog.commandCalls(UpdateIdentityProviderCommand)[0]!;
    expect(call.args[0].input.IdpIdentifiers).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("CognitoIdpSdk.deleteProvider", () => {
  it("calls DeleteIdentityProviderCommand", async () => {
    cog.on(DeleteIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.deleteProvider("tenant-abc12");
    const call = cog.commandCalls(DeleteIdentityProviderCommand)[0]!;
    expect(call.args[0].input).toEqual({
      UserPoolId: "pool",
      ProviderName: "tenant-abc12",
    });
  });
});

describe("CognitoIdpSdk.providerExists", () => {
  it("returns true when the provider exists", async () => {
    cog.on(DescribeIdentityProviderCommand).resolves({ IdentityProvider: { ProviderName: "x" } });
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    expect(await sdk.providerExists("tenant-abc12")).toBe(true);
  });

  it("returns false on ResourceNotFoundException", async () => {
    cog.on(DescribeIdentityProviderCommand).rejects(
      Object.assign(new Error("missing"), { name: "ResourceNotFoundException" }),
    );
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    expect(await sdk.providerExists("tenant-abc12")).toBe(false);
  });

  it("rethrows other errors", async () => {
    cog.on(DescribeIdentityProviderCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await expect(sdk.providerExists("tenant-abc12")).rejects.toThrow(/denied/);
  });
});

describe("CognitoIdpSdk.setProviderEnabled", () => {
  it("adds the provider name to a fresh client config", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ClientName: "trellis-app",
        SupportedIdentityProviders: ["COGNITO"],
        AllowedOAuthFlows: ["code"],
        CallbackURLs: ["https://app/cb"],
      },
    });
    cog.on(UpdateUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.setProviderEnabled({ providerName: "tenant-abc12", enabled: true, tx: lockRecorder() });
    const call = cog.commandCalls(UpdateUserPoolClientCommand)[0]!;
    expect(call.args[0].input.SupportedIdentityProviders).toEqual([
      "COGNITO",
      "tenant-abc12",
    ]);
    expect(call.args[0].input.CallbackURLs).toEqual(["https://app/cb"]);
    expect(call.args[0].input.ClientName).toBe("trellis-app");
  });

  it("does not duplicate when the provider is already present", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { SupportedIdentityProviders: ["tenant-abc12", "COGNITO"] },
    });
    cog.on(UpdateUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.setProviderEnabled({ providerName: "tenant-abc12", enabled: true, tx: lockRecorder() });
    const call = cog.commandCalls(UpdateUserPoolClientCommand)[0]!;
    expect(call.args[0].input.SupportedIdentityProviders).toEqual([
      "tenant-abc12",
      "COGNITO",
    ]);
  });

  it("removes the provider when enabled=false", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { SupportedIdentityProviders: ["tenant-abc12", "COGNITO"] },
    });
    cog.on(UpdateUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.setProviderEnabled({ providerName: "tenant-abc12", enabled: false, tx: lockRecorder() });
    const call = cog.commandCalls(UpdateUserPoolClientCommand)[0]!;
    expect(call.args[0].input.SupportedIdentityProviders).toEqual(["COGNITO"]);
  });

  it("throws when DescribeUserPoolClient returns no client", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await expect(
      sdk.setProviderEnabled({ providerName: "x", enabled: true, tx: lockRecorder() }),
    ).rejects.toThrow(/no client/);
  });

  // The reason the lock moved inside the adapter (WS-2b step 10). It used to be
  // the caller's job, at three separate call sites, and a missed one is
  // invisible: it works until two admins connect an IdP in the same second, and
  // then a read-modify-write on the shared SupportedIdentityProviders list
  // drops one tenant's federation with no error anywhere.
  it("takes the advisory lock BEFORE reading the client config", async () => {
    const order: string[] = [];
    const tx = {
      async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
        order.push(`lock:${query.join("?")}${values.join("")}`);
        return 1;
      },
    };
    cog.on(DescribeUserPoolClientCommand).callsFake(() => {
      order.push("describe");
      return { UserPoolClient: { SupportedIdentityProviders: ["COGNITO"] } };
    });
    cog.on(UpdateUserPoolClientCommand).callsFake(() => {
      order.push("update");
      return {};
    });

    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);
    await sdk.setProviderEnabled({ providerName: "t", enabled: true, tx });

    // A lock taken after the read would serialize nothing: both racers would
    // already hold the same stale list.
    expect(order[0]).toMatch(/^lock:/);
    expect(order.slice(1)).toEqual(["describe", "update"]);
    expect(order[0]).toContain("pg_advisory_xact_lock");
  });

  it("locks on the pool it administers, not on the provider name", async () => {
    // Per-provider keys would let two tenants race on the SHARED client list,
    // which is the exact thing being serialized.
    const seen: unknown[] = [];
    const tx = {
      async $executeRaw(_q: TemplateStringsArray, ...values: unknown[]) {
        seen.push(values[0]);
        return 1;
      },
    };
    cog.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { SupportedIdentityProviders: [] },
    });
    cog.on(UpdateUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}), CFG);

    await sdk.setProviderEnabled({ providerName: "tenant-a", enabled: true, tx });
    await sdk.setProviderEnabled({ providerName: "tenant-b", enabled: true, tx });

    expect(seen[0]).toBe(userPoolAdvisoryLockKey(CFG.userPoolId));
    expect(seen[1]).toBe(seen[0]);
  });
});

describe("userPoolAdvisoryLockKey", () => {
  it("returns a deterministic int64-range bigint", () => {
    const a = userPoolAdvisoryLockKey("eu-central-1_abc");
    const b = userPoolAdvisoryLockKey("eu-central-1_abc");
    expect(a).toBe(b);
    expect(typeof a).toBe("bigint");
    expect(a).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(a).toBeLessThanOrEqual(2n ** 63n - 1n);
  });

  it("differs across user pool ids", () => {
    expect(userPoolAdvisoryLockKey("pool-a")).not.toBe(userPoolAdvisoryLockKey("pool-b"));
  });
});

describe("withUserPoolClientLock", () => {
  it("runs $executeRaw before the inner function", async () => {
    const calls: string[] = [];
    const tx: AdvisoryLockClient = {
      $executeRaw: vi.fn(async () => {
        calls.push("lock");
        return 1;
      }),
    };
    const fn = vi.fn(async () => {
      calls.push("fn");
      return "ok";
    });
    const result = await withUserPoolClientLock(tx, "pool", fn);
    expect(result).toBe("ok");
    expect(calls).toEqual(["lock", "fn"]);
  });
});
