import { describe, it, expect } from "vitest";
import {
  isPrivateIPv4,
  isPrivateIPv6,
  probeOidcIssuer,
} from "../../src/lib/cognito/issuer-probe.js";

const VALID_DISCOVERY = {
  issuer: "https://login.microsoftonline.com/tenant/v2.0",
  authorization_endpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
  token_endpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
  jwks_uri: "https://login.microsoftonline.com/tenant/discovery/v2.0/keys",
  userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function publicResolve(): Promise<string[]> {
  return Promise.resolve(["52.10.10.10"]);
}

describe("isPrivateIPv4", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "100.64.0.1",
    "224.0.0.1",
  ])("rejects %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "52.10.10.10", "172.32.0.1"])("accepts %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });
});

describe("isPrivateIPv6", () => {
  it.each([
    "::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "2001:db8::1",
  ])("rejects %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "::ffff:8.8.8.8"])("accepts %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });
});

describe("probeOidcIssuer", () => {
  it("returns ok for a valid issuer", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      expect(String(input)).toContain("/.well-known/openid-configuration");
      return jsonResponse(VALID_DISCOVERY);
    };
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issuer).toBe(VALID_DISCOVERY.issuer);
      expect(result.tokenEndpoint).toBe(VALID_DISCOVERY.token_endpoint);
      expect(result.jwksUri).toBe(VALID_DISCOVERY.jwks_uri);
      expect(result.userinfoEndpoint).toBe(VALID_DISCOVERY.userinfo_endpoint);
    }
  });

  it("appends the well-known path even when the issuer URL has no trailing slash", async () => {
    let probedUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      probedUrl = String(input);
      return jsonResponse(VALID_DISCOVERY);
    };
    await probeOidcIssuer("https://idp.example.com/tenant", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(probedUrl).toBe("https://idp.example.com/tenant/.well-known/openid-configuration");
  });

  it("rejects http://", async () => {
    const result = await probeOidcIssuer("http://idp.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INSECURE_SCHEME");
  });

  it("rejects URLs that are not URLs", async () => {
    const result = await probeOidcIssuer("not a url", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_URL");
  });

  it("rejects URLs that include credentials", async () => {
    const result = await probeOidcIssuer("https://user:pass@idp.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_URL");
  });

  it("rejects hostnames that resolve to a private IP", async () => {
    const result = await probeOidcIssuer("https://idp.internal/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: async () => ["10.0.0.5"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PRIVATE_HOST");
  });

  it("rejects hostnames that resolve to loopback IPv6", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: async () => ["::1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PRIVATE_HOST");
  });

  it("rejects when ANY resolved address is private (DNS rebinding mitigation)", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: async () => ["52.10.10.10", "10.0.0.1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PRIVATE_HOST");
  });

  it("rejects when DNS lookup fails", async () => {
    const result = await probeOidcIssuer("https://nope.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DNS_ERROR");
  });

  it("rejects when DNS returns empty addresses", async () => {
    const result = await probeOidcIssuer("https://nope.example.com/", {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: async () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DNS_ERROR");
  });

  it("rejects redirects", async () => {
    const fetchImpl = async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://elsewhere/.well-known/openid-configuration" },
      });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("REDIRECT_BLOCKED");
  });

  it("returns HTTP_ERROR on non-2xx", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("HTTP_ERROR");
  });

  it("returns INVALID_JSON when body is not JSON", async () => {
    const fetchImpl = async () =>
      new Response("<html>nope</html>", { status: 200 });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_JSON");
  });

  it("returns INVALID_JSON when body parses to non-object", async () => {
    const fetchImpl = async () => new Response("[1,2,3]", { status: 200 });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_JSON");
  });

  it("returns MISSING_ENDPOINTS when required fields are missing", async () => {
    const fetchImpl = async () => jsonResponse({ issuer: "https://x" });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_ENDPOINTS");
  });

  it("caps response size at 1 MiB", async () => {
    const big = new Uint8Array(1024 * 1024 + 1024);
    big.fill(0x20);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const fetchImpl = async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("BODY_TOO_LARGE");
  });

  it("returns TIMEOUT when fetch aborts", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("TIMEOUT");
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NETWORK_ERROR");
  });

  it("returns NETWORK_ERROR when response has no body", async () => {
    const fetchImpl = async () => new Response(null, { status: 200 });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NETWORK_ERROR");
  });

  it("propagates NETWORK_ERROR if reading the body fails", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("read failed"));
      },
    });
    const fetchImpl = async () => new Response(stream, { status: 200 });
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fetchImpl as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NETWORK_ERROR");
  });

  it("pins the connect step to the first validated IP (DNS-rebinding TOCTOU mitigation)", async () => {
    // Resolver returns the public IP first; on a hypothetical second lookup
    // a TTL=0 attacker could swap in a private IP. The probe must pin the
    // dispatcher's connect step to the first-resolved IP rather than re-
    // resolving DNS at request time.
    let resolveCalls = 0;
    const resolveHostname = async () => {
      resolveCalls += 1;
      if (resolveCalls === 1) return ["52.10.10.10"];
      return ["10.0.0.1"];
    };

    const factoryArgs: Array<{ ip: string; family: 4 | 6 }> = [];
    let dispatcherSeen: unknown;

    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      dispatcherSeen = (init as unknown as { dispatcher?: unknown })?.dispatcher;
      return jsonResponse(VALID_DISCOVERY);
    }) as typeof fetch;

    const dispatcherFactory = (ip: string, family: 4 | 6) => {
      factoryArgs.push({ ip, family });
      return { close: async () => {} };
    };

    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl,
      resolveHostname,
      dispatcherFactory,
    });
    expect(result.ok).toBe(true);
    expect(factoryArgs).toEqual([{ ip: "52.10.10.10", family: 4 }]);
    expect(dispatcherSeen).toBeDefined();
  });

  it("rejects an issuer URL exceeding 2048 characters", async () => {
    const longUrl = "https://idp.example.com/" + "a".repeat(3000);
    const result = await probeOidcIssuer(longUrl, {
      fetchImpl: (async () => jsonResponse(VALID_DISCOVERY)) as unknown as typeof fetch,
      resolveHostname: publicResolve,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_URL");
  });

  it("pins IPv6 connect step with family 6", async () => {
    const factoryArgs: Array<{ ip: string; family: 4 | 6 }> = [];
    const fetchImpl = (async () => jsonResponse(VALID_DISCOVERY)) as typeof fetch;
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl,
      resolveHostname: async () => ["2606:4700:4700::1111"],
      dispatcherFactory: (ip, family) => {
        factoryArgs.push({ ip, family });
        return undefined;
      },
    });
    expect(result.ok).toBe(true);
    expect(factoryArgs).toEqual([{ ip: "2606:4700:4700::1111", family: 6 }]);
  });

});
