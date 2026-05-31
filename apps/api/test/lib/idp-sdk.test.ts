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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.createOidcProvider({
      userPoolId: "pool",
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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await expect(
      sdk.createOidcProvider({
        userPoolId: "pool",
        providerName: "tenant-abc12",
        details: {
          clientId: "client",
          clientSecret: "shh",
          issuerUrl: "https://idp.example.com/",
        },
        attributeMapping: defaultOidcAttributeMapping(),
        idpIdentifiers: [],
      }),
    ).rejects.toThrow(/invalid/);
  });
});

describe("CognitoIdpSdk.updateOidcProvider", () => {
  it("only sets ProviderDetails when at least one OIDC field changes", async () => {
    cog.on(UpdateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.updateOidcProvider({
      userPoolId: "pool",
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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.updateOidcProvider({
      userPoolId: "pool",
      providerName: "tenant-abc12",
      attributeMapping: { email: "mail", given_name: undefined },
    });
    const call = cog.commandCalls(UpdateIdentityProviderCommand)[0]!;
    expect(call.args[0].input.AttributeMapping).toEqual({ email: "mail" });
    expect(call.args[0].input.ProviderDetails).toBeUndefined();
  });

  it("supports updating the IdpIdentifiers list (verified-domain change)", async () => {
    cog.on(UpdateIdentityProviderCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.updateOidcProvider({
      userPoolId: "pool",
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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.deleteProvider("pool", "tenant-abc12");
    const call = cog.commandCalls(DeleteIdentityProviderCommand)[0]!;
    expect(call.args[0].input).toEqual({
      UserPoolId: "pool",
      ProviderName: "tenant-abc12",
    });
  });
});

describe("CognitoIdpSdk.describeProvider", () => {
  it("returns true when the provider exists", async () => {
    cog.on(DescribeIdentityProviderCommand).resolves({ IdentityProvider: { ProviderName: "x" } });
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    expect(await sdk.describeProvider("pool", "tenant-abc12")).toBe(true);
  });

  it("returns false on ResourceNotFoundException", async () => {
    cog.on(DescribeIdentityProviderCommand).rejects(
      Object.assign(new Error("missing"), { name: "ResourceNotFoundException" }),
    );
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    expect(await sdk.describeProvider("pool", "tenant-abc12")).toBe(false);
  });

  it("rethrows other errors", async () => {
    cog.on(DescribeIdentityProviderCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await expect(sdk.describeProvider("pool", "tenant-abc12")).rejects.toThrow(/denied/);
  });
});

describe("CognitoIdpSdk.setSupportedIdentityProvider", () => {
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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.setSupportedIdentityProvider("pool", "client", "tenant-abc12", "add");
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
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.setSupportedIdentityProvider("pool", "client", "tenant-abc12", "add");
    const call = cog.commandCalls(UpdateUserPoolClientCommand)[0]!;
    expect(call.args[0].input.SupportedIdentityProviders).toEqual([
      "tenant-abc12",
      "COGNITO",
    ]);
  });

  it("removes the provider on op=remove", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { SupportedIdentityProviders: ["tenant-abc12", "COGNITO"] },
    });
    cog.on(UpdateUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await sdk.setSupportedIdentityProvider("pool", "client", "tenant-abc12", "remove");
    const call = cog.commandCalls(UpdateUserPoolClientCommand)[0]!;
    expect(call.args[0].input.SupportedIdentityProviders).toEqual(["COGNITO"]);
  });

  it("throws when DescribeUserPoolClient returns no client", async () => {
    cog.on(DescribeUserPoolClientCommand).resolves({});
    const sdk = new CognitoIdpSdk(new CognitoIdentityProviderClient({}));
    await expect(
      sdk.setSupportedIdentityProvider("pool", "client", "x", "add"),
    ).rejects.toThrow(/no client/);
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
