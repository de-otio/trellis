/**
 * Adversarial coverage for the SSRF-safe fetch helper.
 *
 * The transport and resolver are injected, so every policy branch (DNS
 * rejection, socket pinning, per-hop redirect revalidation, body cap, timeout)
 * is exercised without a network. The cases mirror the attacks named in the
 * review: encoded loopback, a public name with a private A record, a public
 * first hop that redirects to metadata, and an unbounded body.
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertUrlSafe,
  ResponseTooLargeError,
  safeFetch,
  safeFetchJson,
  screenUrlLexically,
  SsrfBlockedError,
  type DnsResolver,
  type RawResponse,
  type Transport,
  type TransportRequest,
} from "../../../src/lib/net/safe-fetch.js";

/** Resolver that hands back a fixed answer set for any name. */
function fixedResolver(...addresses: string[]): DnsResolver {
  return async () => addresses;
}

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
}

/** Transport returning canned responses in order, recording each request. */
function scriptedTransport(responses: RawResponse[]): {
  transport: Transport;
  calls: TransportRequest[];
} {
  const calls: TransportRequest[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    calls.push(req);
    const response = responses[i++];
    if (!response) throw new Error("scriptedTransport: no response left");
    return response;
  };
  return { transport, calls };
}

const ok = (body: string): RawResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: bytes(body),
});

const redirect = (location: string, status = 302): RawResponse => ({
  status,
  headers: { location },
  body: bytes(""),
});

describe("assertUrlSafe — scheme and shape", () => {
  it("rejects an unparseable URL", async () => {
    await expect(assertUrlSafe("not a url")).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a non-http scheme", async () => {
    await expect(assertUrlSafe("file:///etc/passwd")).rejects.toMatchObject({
      reason: "scheme-not-allowed",
    });
  });

  it("rejects http when the caller demands https-only (federation)", async () => {
    await expect(
      assertUrlSafe("http://example.com/actor", {
        allowedProtocols: ["https:"],
        resolver: fixedResolver("93.184.216.34"),
      }),
    ).rejects.toMatchObject({ reason: "scheme-not-allowed" });
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertUrlSafe("https://user:pw@example.com/", {
        resolver: fixedResolver("93.184.216.34"),
      }),
    ).rejects.toMatchObject({ reason: "credentials-in-url" });
  });
});

describe("assertUrlSafe — encoded IP literals never reach DNS", () => {
  const resolver = vi.fn<DnsResolver>(async () => ["93.184.216.34"]);

  it.each([
    ["http://2130706433/"],
    ["http://0x7f000001/"],
    ["http://017700000001/"],
    ["http://0/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://[::1]/"],
    ["http://127.0.0.1/"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://[fd00::1]/"],
    ["http://100.64.0.1/"],
    ["http://localhost:6379/"],
    ["http://db.internal/"],
  ])("blocks %s", async (url) => {
    resolver.mockClear();
    await expect(assertUrlSafe(url, { resolver })).rejects.toMatchObject({
      reason: "blocked-address",
    });
    // Literal forms are decided lexically — no DNS query is even attempted.
    if (!url.includes("internal")) {
      expect(resolver).not.toHaveBeenCalled();
    }
  });
});

describe("assertUrlSafe — DNS resolution is the second gate", () => {
  it("blocks a public NAME whose A record is the metadata address", async () => {
    // This is the bypass the purely lexical check could never catch.
    await expect(
      assertUrlSafe("https://metadata.attacker.example/", {
        resolver: fixedResolver("169.254.169.254"),
      }),
    ).rejects.toMatchObject({ reason: "blocked-address" });
  });

  it("blocks when ANY record in the answer set is private", async () => {
    // A public A plus a private AAAA is a rebinding primitive; the whole set
    // must fail, not just the record we happened to pick.
    await expect(
      assertUrlSafe("https://mixed.example/", {
        resolver: fixedResolver("93.184.216.34", "fd00::1"),
      }),
    ).rejects.toMatchObject({ reason: "blocked-address" });
  });

  it("blocks on resolution failure rather than proceeding", async () => {
    await expect(
      assertUrlSafe("https://nx.example/", {
        resolver: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ reason: "dns-failure" });
  });

  it("blocks on an empty answer set", async () => {
    await expect(
      assertUrlSafe("https://empty.example/", { resolver: fixedResolver() }),
    ).rejects.toMatchObject({ reason: "dns-failure" });
  });

  it("returns the validated address to pin the socket to", async () => {
    const target = await assertUrlSafe("https://good.example/x", {
      resolver: fixedResolver("93.184.216.34", "8.8.8.8"),
    });
    expect(target.address).toBe("93.184.216.34");
    expect(target.allAddresses).toEqual(["93.184.216.34", "8.8.8.8"]);
    expect(target.url.href).toBe("https://good.example/x");
  });
});

describe("safeFetch — the socket is pinned to the validated address", () => {
  it("hands the transport the resolved IP, not just the hostname", async () => {
    const { transport, calls } = scriptedTransport([ok("{}")]);
    await safeFetch("https://good.example/", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(calls[0].target.address).toBe("93.184.216.34");
    expect(calls[0].target.url.hostname).toBe("good.example");
    // Host header keeps the real name so vhosts and TLS SNI still work.
    expect(calls[0].headers.host).toBe("good.example");
  });

  it("re-resolves and re-validates on every redirect hop", async () => {
    const resolver = vi.fn<DnsResolver>(async () => ["93.184.216.34"]);
    const { transport, calls } = scriptedTransport([
      redirect("https://second.example/"),
      ok('{"ok":true}'),
    ]);
    const result = await safeFetch("https://first.example/", {
      resolver,
      transport,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(1, "first.example");
    expect(resolver).toHaveBeenNthCalledWith(2, "second.example");
    expect(calls).toHaveLength(2);
    expect(result.redirectChain).toEqual([
      "https://first.example/",
      "https://second.example/",
    ]);
  });
});

describe("safeFetch — redirect policy", () => {
  it("blocks a redirect to the metadata service after a benign first hop", async () => {
    const { transport } = scriptedTransport([
      redirect("http://169.254.169.254/latest/meta-data/"),
      ok("secrets"),
    ]);
    await expect(
      safeFetch("https://benign.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
      }),
    ).rejects.toMatchObject({ reason: "blocked-address" });
  });

  it("blocks a redirect to a name that resolves privately", async () => {
    const resolver: DnsResolver = async (host) =>
      host === "first.example" ? ["93.184.216.34"] : ["10.0.0.5"];
    const { transport } = scriptedTransport([
      redirect("https://rebind.example/"),
      ok("internal"),
    ]);
    await expect(
      safeFetch("https://first.example/", { resolver, transport }),
    ).rejects.toMatchObject({ reason: "blocked-address" });
  });

  it("caps the redirect count", async () => {
    const { transport } = scriptedTransport([
      redirect("https://b.example/"),
      redirect("https://c.example/"),
      redirect("https://d.example/"),
      ok("{}"),
    ]);
    await expect(
      safeFetch("https://a.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ reason: "too-many-redirects" });
  });

  it("refuses a redirect with no Location header", async () => {
    const { transport } = scriptedTransport([
      { status: 302, headers: {}, body: bytes("") },
    ]);
    await expect(
      safeFetch("https://a.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
      }),
    ).rejects.toMatchObject({ reason: "redirect-missing-location" });
  });

  it("degrades POST to GET across a 303 and drops the body", async () => {
    const { transport, calls } = scriptedTransport([
      redirect("https://b.example/", 303),
      ok("{}"),
    ]);
    await safeFetch("https://a.example/", {
      method: "POST",
      body: "payload",
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[1].method).toBe("GET");
    expect(calls[1].body).toBeUndefined();
  });

  it("resolves a relative Location against the current URL", async () => {
    const { transport, calls } = scriptedTransport([
      redirect("/next"),
      ok("{}"),
    ]);
    await safeFetch("https://a.example/first", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(calls[1].target.url.href).toBe("https://a.example/next");
  });
});

describe("safeFetch — body cap", () => {
  it("throws before buffering past the cap", async () => {
    const big: RawResponse = {
      status: 200,
      headers: {},
      body: bytes("a".repeat(600), "b".repeat(600)),
    };
    const { transport } = scriptedTransport([big]);
    await expect(
      safeFetch("https://a.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
        maxBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("accepts a body at exactly the cap", async () => {
    const { transport } = scriptedTransport([
      { status: 200, headers: {}, body: bytes("x".repeat(1000)) },
    ]);
    const result = await safeFetch("https://a.example/", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
      maxBytes: 1000,
    });
    expect(result.body).toHaveLength(1000);
  });
});

describe("safeFetchJson", () => {
  it("caps the body BEFORE parsing", async () => {
    const { transport } = scriptedTransport([
      { status: 200, headers: {}, body: bytes(`{"pad":"${"x".repeat(5000)}"}`) },
    ]);
    await expect(
      safeFetchJson("https://a.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
        maxBytes: 512,
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("returns null data on a non-2xx status", async () => {
    const { transport } = scriptedTransport([
      { status: 404, headers: {}, body: bytes("nope") },
    ]);
    const result = await safeFetchJson("https://a.example/", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(result).toEqual({ status: 404, data: null });
  });

  it("returns null data on unparseable JSON rather than throwing", async () => {
    const { transport } = scriptedTransport([
      { status: 200, headers: {}, body: bytes("<html>") },
    ]);
    const result = await safeFetchJson("https://a.example/", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(result.data).toBeNull();
  });

  it("parses a good document", async () => {
    const { transport } = scriptedTransport([ok('{"id":"https://a.example/u"}')]);
    const result = await safeFetchJson<{ id: string }>("https://a.example/", {
      resolver: fixedResolver("93.184.216.34"),
      transport,
    });
    expect(result.data).toEqual({ id: "https://a.example/u" });
  });
});

describe("safeFetch — timeout", () => {
  it("aborts the exchange when the budget expires", async () => {
    const transport: Transport = (req) =>
      new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () =>
          reject(new Error("aborted by signal")),
        );
      });
    await expect(
      safeFetch("https://slow.example/", {
        resolver: fixedResolver("93.184.216.34"),
        transport,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("aborted by signal");
  });
});

describe("screenUrlLexically", () => {
  it.each([
    ["http://2130706433/"],
    ["http://0x7f000001/"],
    ["http://017700000001/"],
    ["http://0/"],
    ["http://[::ffff:127.0.0.1]/"],
    ["http://localhost/"],
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
  ])("rejects %s", (url) => {
    expect(screenUrlLexically(url).allowed).toBe(false);
  });

  it("allows a public URL", () => {
    expect(screenUrlLexically("https://example.com/page").allowed).toBe(true);
  });

  it("can be restricted to https", () => {
    expect(
      screenUrlLexically("http://example.com/", ["https:"]).allowed,
    ).toBe(false);
  });
});
