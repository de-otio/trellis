import { describe, it, expect } from "vitest";

import {
  KeycloakIdpAdmin,
  KeycloakIdpAdminError,
} from "../../../src/lib/identity/keycloak-idp-admin.js";
import type { AdvisoryLockClient } from "../../../src/lib/identity/idp-admin-port.js";

/**
 * The adapter's failures are almost all wire-level — a wrong path, a wrong
 * config key, a body where a path segment was expected — and every one of them
 * surfaces later as federation that half-works. So the fake records every
 * request and the tests assert the exact wire format, which was verified
 * against the Keycloak 26.6.3 tag's source (see the adapter's header).
 */
interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

function fakeKeycloak(
  routes: Array<{
    match: (method: string, path: string) => boolean;
    status?: number;
    body?: unknown;
  }>,
) {
  const requests: Recorded[] = [];
  let tokenCalls = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname + (new URL(url).search || "");

    if (path.endsWith("/protocol/openid-connect/token")) {
      tokenCalls++;
      requests.push({ method, url, body: init?.body });
      return new Response(
        JSON.stringify({ access_token: `svc-token-${tokenCalls}`, expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    requests.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });

    for (const r of routes) {
      if (r.match(method, path)) {
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
          status: r.status ?? (r.body === undefined ? 204 : 200),
          headers: { "content-type": "application/json" },
        });
      }
    }
    // Default: succeed with an empty body, which is what most KC admin writes do.
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  return {
    fetchImpl,
    requests,
    get tokenCalls() {
      return tokenCalls;
    },
    /** Admin-API requests only (the token call is bookkeeping, not wire under test). */
    admin: () => requests.filter((r) => !r.url.includes("/protocol/openid-connect/token")),
  };
}

function makeAdmin(kc: ReturnType<typeof fakeKeycloak>) {
  return new KeycloakIdpAdmin({
    baseUrl: "https://id.example.test",
    realm: "test-realm",
    adminClientId: "svc-client",
    adminClientSecret: "svc-secret",
    fetchImpl: kc.fetchImpl,
  });
}

/** Records lock attempts; the Keycloak adapter must make none. */
function lockRecorder(): AdvisoryLockClient & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
      statements.push(query.join("?") + values.join(","));
      return 1;
    },
  };
}

const CREATE_INPUT = {
  providerName: "tenant-abc12",
  details: {
    clientId: "their-client",
    clientSecret: "their-secret",
    issuerUrl: "https://idp.example.org/",
  },
  endpoints: {
    authorizationUrl: "https://idp.example.org/authorize",
    tokenUrl: "https://idp.example.org/token",
    jwksUrl: "https://idp.example.org/jwks",
  },
  attributeMapping: { email: "email", idpGroups: "groups" },
  idpIdentifiers: ["example.org", "corp.example.org"],
};

describe("service-account token", () => {
  it("authenticates with client_credentials and reuses the token", async () => {
    const kc = fakeKeycloak([
      { match: (m, p) => m === "GET" && p.includes("/identity-provider/instances/"), body: {} },
    ]);
    const admin = makeAdmin(kc);

    await admin.providerExists("a");
    await admin.providerExists("b");

    // One token for two admin calls — six parallel federation edits must not
    // become six token grants.
    expect(kc.tokenCalls).toBe(1);
    const tokenReq = kc.requests[0]!;
    const form = new URLSearchParams(String(tokenReq.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("svc-client");
    expect(form.get("client_secret")).toBe("svc-secret");
  });

  it("refuses to construct without config, rather than 401ing later", () => {
    expect(
      () =>
        new KeycloakIdpAdmin({
          baseUrl: "",
          realm: "r",
          adminClientId: "c",
          adminClientSecret: "s",
        }),
    ).toThrow(KeycloakIdpAdminError);
  });
});

describe("createOidcProvider", () => {
  it("creates the IdP instance with the source-verified config keys", async () => {
    const kc = fakeKeycloak([
      { match: (m, p) => m === "POST" && p.endsWith("/organizations"), body: { id: "org-1" } },
    ]);
    await makeAdmin(kc).createOidcProvider(CREATE_INPUT);

    const idpCreate = kc.admin()[0]!;
    expect(idpCreate.method).toBe("POST");
    expect(idpCreate.url).toBe(
      "https://id.example.test/admin/realms/test-realm/identity-provider/instances",
    );
    const body = idpCreate.body as {
      alias: string;
      providerId: string;
      enabled: boolean;
      config: Record<string, string>;
    };
    expect(body.alias).toBe("tenant-abc12");
    expect(body.providerId).toBe("oidc");
    // Disabled at birth: the handler enables it inside its own transaction,
    // mirroring the Cognito create → enable sequence.
    expect(body.enabled).toBe(false);
    // The key names come from OAuth2IdentityProviderConfig /
    // OIDCIdentityProviderConfig at the 26.6.3 tag. A wrong key does not error
    // — Keycloak stores it inertly and the provider misbehaves at first login.
    expect(body.config).toMatchObject({
      clientId: "their-client",
      clientSecret: "their-secret",
      issuer: "https://idp.example.org/",
      authorizationUrl: "https://idp.example.org/authorize",
      tokenUrl: "https://idp.example.org/token",
      jwksUrl: "https://idp.example.org/jwks",
      useJwksUrl: "true",
      validateSignature: "true",
    });
  });

  it("creates the organization carrying the verified domains", async () => {
    const kc = fakeKeycloak([
      { match: (m, p) => m === "POST" && p.endsWith("/organizations"), body: { id: "org-1" } },
    ]);
    await makeAdmin(kc).createOidcProvider(CREATE_INPUT);

    const orgCreate = kc.admin().find((r) => r.url.endsWith("/organizations"))!;
    expect(orgCreate.body).toMatchObject({
      name: "tenant-abc12",
      alias: "tenant-abc12",
      enabled: true,
      domains: [
        { name: "example.org", verified: true },
        { name: "corp.example.org", verified: true },
      ],
    });
  });

  it("links org → IdP with the alias as the JSON body, not a path segment", async () => {
    // OrganizationIdentityProvidersResource.addIdentityProvider(String id),
    // @Consumes(APPLICATION_JSON): the body IS the alias. A path-segment call
    // here would 405/404 — this is the single most likely detail to get wrong.
    const kc = fakeKeycloak([
      { match: (m, p) => m === "POST" && p.endsWith("/organizations"), body: { id: "org-1" } },
    ]);
    await makeAdmin(kc).createOidcProvider(CREATE_INPUT);

    const link = kc.admin().find((r) => r.url.endsWith("/organizations/org-1/identity-providers"))!;
    expect(link).toBeDefined();
    expect(link.method).toBe("POST");
    expect(link.body).toBe("tenant-abc12");
  });

  it("creates one FORCE-sync mapper per mapped attribute", async () => {
    const kc = fakeKeycloak([
      { match: (m, p) => m === "POST" && p.endsWith("/organizations"), body: { id: "org-1" } },
    ]);
    await makeAdmin(kc).createOidcProvider(CREATE_INPUT);

    const mappers = kc.admin().filter((r) => r.url.endsWith("/mappers") && r.method === "POST");
    expect(mappers).toHaveLength(2);
    expect(mappers[0]!.url).toContain("/identity-provider/instances/tenant-abc12/mappers");
    expect(mappers.map((m) => m.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityProviderMapper: "oidc-user-attribute-idp-mapper",
          config: {
            claim: "groups",
            "user.attribute": "idpGroups",
            // FORCE re-syncs each login, matching Cognito; IMPORT (the KC
            // default) would freeze attributes at first login.
            syncMode: "FORCE",
          },
        }),
      ]),
    );
  });
});

describe("deleteProvider", () => {
  it("removes the IdP AND the organization", async () => {
    // A surviving organization keeps claiming its email domains and routes
    // sign-ins at a provider that no longer exists.
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/organizations?"),
        body: [{ id: "org-1", alias: "tenant-abc12", name: "tenant-abc12", enabled: true, domains: [] }],
      },
    ]);
    await makeAdmin(kc).deleteProvider("tenant-abc12");

    const deletes = kc.admin().filter((r) => r.method === "DELETE");
    expect(deletes.map((d) => new URL(d.url).pathname)).toEqual([
      "/admin/realms/test-realm/identity-provider/instances/tenant-abc12",
      "/admin/realms/test-realm/organizations/org-1",
    ]);
  });

  it("resolves the org by EXACT alias, not substring", async () => {
    // search= is a substring match server-side; without the client-side exact
    // filter, deleting tenant-a could resolve to tenant-ab and remove the
    // wrong tenant's federation.
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/organizations?"),
        body: [{ id: "org-2", alias: "tenant-ab", name: "tenant-ab", enabled: true, domains: [] }],
      },
    ]);
    await makeAdmin(kc).deleteProvider("tenant-a");

    const orgSearch = kc.admin().find((r) => r.url.includes("/organizations?"))!;
    expect(orgSearch.url).toContain("exact=true");
    const deletes = kc.admin().filter((r) => r.method === "DELETE");
    // Only the IdP delete — no org matched exactly, so nothing else is deleted.
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain("/identity-provider/instances/tenant-a");
  });

  it("is idempotent: tolerates both halves being already gone", async () => {
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "DELETE" && p.includes("/identity-provider/instances/"),
        status: 404,
        body: { error: "not found" },
      },
      { match: (m, p) => m === "GET" && p.includes("/organizations?"), body: [] },
    ]);
    // Must not throw — this is the rollback path for a half-failed create and
    // runs under handler retries.
    await expect(makeAdmin(kc).deleteProvider("tenant-abc12")).resolves.toBeUndefined();
  });
});

describe("providerExists", () => {
  it("200 → true, 404 → false", async () => {
    const yes = fakeKeycloak([
      { match: (m, p) => m === "GET" && p.includes("/instances/here"), body: { alias: "here" } },
      { match: (m, p) => m === "GET" && p.includes("/instances/gone"), status: 404, body: {} },
    ]);
    const admin = makeAdmin(yes);
    expect(await admin.providerExists("here")).toBe(true);
    expect(await admin.providerExists("gone")).toBe(false);
  });

  it("403 throws unauthorized — missing role must be loud, not 'does not exist'", async () => {
    // Until manage-identity-providers is granted (dot-identity toggle), every
    // call 403s. Mapping that to `false` would make the handler recreate
    // providers forever and mask the misconfiguration.
    const kc = fakeKeycloak([
      { match: () => true, status: 403, body: { error: "HTTP 403 Forbidden" } },
    ]);
    await expect(makeAdmin(kc).providerExists("x")).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("setProviderEnabled", () => {
  it("flips enabled on the instance, preserving the rest of the representation", async () => {
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/instances/tenant-abc12"),
        body: { alias: "tenant-abc12", providerId: "oidc", enabled: false, config: { clientId: "c" } },
      },
    ]);
    await makeAdmin(kc).setProviderEnabled({
      providerName: "tenant-abc12",
      enabled: true,
      tx: lockRecorder(),
    });

    const put = kc.admin().find((r) => r.method === "PUT")!;
    expect(new URL(put.url).pathname).toBe(
      "/admin/realms/test-realm/identity-provider/instances/tenant-abc12",
    );
    expect(put.body).toMatchObject({
      alias: "tenant-abc12",
      enabled: true,
      config: { clientId: "c" },
    });
  });

  it("takes NO advisory lock — the port hands one over, this adapter ignores it", async () => {
    // The reason the lock lives in the adapter, not the handler: Cognito
    // mutates a shared list and must serialize; a Keycloak provider is its own
    // resource and a lock here would only serialize unrelated tenants' calls.
    const tx = lockRecorder();
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/instances/"),
        body: { alias: "a", enabled: true },
      },
    ]);
    await makeAdmin(kc).setProviderEnabled({ providerName: "a", enabled: false, tx });

    expect(tx.statements).toEqual([]);
  });
});

describe("updateOidcProvider", () => {
  it("merges details into the current config via read-then-PUT", async () => {
    // PUT replaces the whole representation; sending only the delta would
    // erase authorizationUrl/tokenUrl and brick the provider.
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/instances/tenant-abc12"),
        body: {
          alias: "tenant-abc12",
          enabled: true,
          config: { clientId: "old", authorizationUrl: "https://keep.example/auth" },
        },
      },
    ]);
    await makeAdmin(kc).updateOidcProvider({
      providerName: "tenant-abc12",
      details: { clientSecret: "rotated", scopes: "openid email" },
    });

    const put = kc.admin().find((r) => r.method === "PUT")!;
    expect(put.body).toMatchObject({
      config: {
        clientId: "old",
        authorizationUrl: "https://keep.example/auth",
        clientSecret: "rotated",
        defaultScope: "openid email",
      },
    });
  });

  it("upserts mappers: existing by name → PUT with id, new → POST", async () => {
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.endsWith("/mappers"),
        body: [{ id: "m-1", name: "attr-email" }],
      },
    ]);
    await makeAdmin(kc).updateOidcProvider({
      providerName: "tenant-abc12",
      attributeMapping: { email: "mail", idpGroups: "groups" },
    });

    const writes = kc.admin().filter((r) => r.method !== "GET");
    const put = writes.find((r) => r.method === "PUT")!;
    expect(new URL(put.url).pathname).toContain("/mappers/m-1");
    expect(put.body).toMatchObject({ id: "m-1", config: { claim: "mail" } });
    const post = writes.find((r) => r.method === "POST")!;
    expect(post.body).toMatchObject({
      name: "attr-idpGroups",
      config: { claim: "groups", "user.attribute": "idpGroups" },
    });
  });

  it("replaces the organization's domains for new idpIdentifiers", async () => {
    const kc = fakeKeycloak([
      {
        match: (m, p) => m === "GET" && p.includes("/organizations?"),
        body: [{ id: "org-1", alias: "tenant-abc12", name: "tenant-abc12", enabled: true, domains: [] }],
      },
      {
        match: (m, p) => m === "GET" && p.endsWith("/organizations/org-1"),
        body: { id: "org-1", alias: "tenant-abc12", name: "tenant-abc12", enabled: true, domains: [] },
      },
    ]);
    await makeAdmin(kc).updateOidcProvider({
      providerName: "tenant-abc12",
      idpIdentifiers: ["new.example.org"],
    });

    const put = kc.admin().find((r) => r.method === "PUT")!;
    expect(new URL(put.url).pathname).toBe("/admin/realms/test-realm/organizations/org-1");
    expect(put.body).toMatchObject({
      domains: [{ name: "new.example.org", verified: true }],
    });
  });
});

describe("error hygiene", () => {
  it("never copies the response body into the error", async () => {
    // Admin-API error bodies can echo config values (the client secret among
    // them); the error must carry only status and operation.
    const kc = fakeKeycloak([
      {
        match: () => true,
        status: 400,
        body: { errorMessage: "invalid client secret their-secret-value" },
      },
    ]);
    const err = await makeAdmin(kc)
      .createOidcProvider(CREATE_INPUT)
      .catch((e: unknown) => e as KeycloakIdpAdminError);

    expect(err).toBeInstanceOf(KeycloakIdpAdminError);
    expect(String(err)).not.toContain("their-secret");
  });
});
