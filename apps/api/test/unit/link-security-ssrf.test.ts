/**
 * SSRF coverage for LinkSecurityHandler after it was rewired onto
 * `net/ip-guard` + `net/safe-fetch` (Phase 6, M1).
 *
 * Two layers are asserted separately, because they have different powers:
 *
 *  - `validateUrlSync` is lexical. It must classify every IP-literal encoding
 *    correctly and refuse internal names, and it must NOT pretend to know what
 *    a domain resolves to.
 *  - `validateUrl` adds DNS. It is the layer that catches the attack the
 *    lexical check structurally cannot: an ordinary-looking name whose A record
 *    points at the metadata service.
 */

import { describe, expect, it } from "vitest";
import {
  LinkSecurityHandler,
  LinkStatus,
} from "../../src/lib/link-security-handler.js";
import type { DnsResolver } from "../../src/lib/net/safe-fetch.js";

const handler = new LinkSecurityHandler({} as never);

const resolvesTo =
  (...addresses: string[]): DnsResolver =>
  async () =>
    addresses;

describe("validateUrlSync — IP-literal encodings", () => {
  it.each([
    ["http://2130706433/", "decimal loopback"],
    ["http://0x7f000001/", "hex loopback"],
    ["http://017700000001/", "octal loopback"],
    ["http://0/", "the zero address"],
    ["http://127.1/", "short-form loopback"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[fe80::1]/", "IPv6 link-local"],
    ["http://[fd00::1]/", "IPv6 unique-local"],
    ["http://169.254.169.254/latest/meta-data/", "AWS/GCP metadata"],
    ["http://169.254.42.42/", "Scaleway metadata"],
    ["http://[::ffff:169.254.169.254]/", "metadata via IPv4-mapped IPv6"],
    ["http://100.100.100.200/", "Alibaba metadata (CGNAT)"],
    ["http://10.0.0.5:6379/", "internal Redis"],
    ["http://192.168.1.1/", "RFC1918"],
    ["http://172.16.0.1/", "RFC1918"],
    ["http://255.255.255.255/", "broadcast"],
    ["http://[64:ff9b::7f00:1]/", "NAT64-wrapped loopback"],
    ["http://[2002:7f00:1::]/", "6to4-wrapped loopback"],
  ])("blocks %s (%s)", (url) => {
    expect(handler.validateUrlSync(url).status).toBe(LinkStatus.BLOCKED);
  });

  it.each([
    ["http://localhost/"],
    ["http://localhost.localdomain/"],
    ["http://db.internal/"],
    ["http://svc.local/"],
    ["http://metadata.google.internal/"],
  ])("blocks internal name %s", (url) => {
    const result = handler.validateUrlSync(url);
    expect(result.status).toBe(LinkStatus.BLOCKED);
    expect(result.reason).toBe("Internal hostname detected");
  });

  it("still allows an ordinary public URL", () => {
    expect(handler.validateUrlSync("https://example.com/a").status).toBe(
      LinkStatus.SAFE,
    );
  });

  it("still allows hostless schemes", () => {
    expect(handler.validateUrlSync("mailto:a@example.com").status).toBe(
      LinkStatus.SAFE,
    );
    expect(handler.validateUrlSync("tel:+1234567890").status).toBe(
      LinkStatus.SAFE,
    );
  });

  it("does NOT claim to know where a domain resolves", () => {
    // Documents the boundary: this is exactly the case validateUrl exists for.
    expect(
      handler.validateUrlSync("https://cdn.attacker.example/").status,
    ).toBe(LinkStatus.SAFE);
  });
});

describe("validateUrl — DNS is the layer the lexical check cannot be", () => {
  it("blocks a public name whose A record is the metadata address", async () => {
    const result = await handler.validateUrl(
      "https://cdn.attacker.example/",
      { resolver: resolvesTo("169.254.169.254") },
    );
    expect(result.status).toBe(LinkStatus.BLOCKED);
    expect(result.reason).toBe("Internal network access blocked");
  });

  it("blocks a public name whose A record is RFC1918", async () => {
    const result = await handler.validateUrl("https://intranet.example/", {
      resolver: resolvesTo("10.1.2.3"),
    });
    expect(result.status).toBe(LinkStatus.BLOCKED);
  });

  it("blocks when only ONE record of several is private", async () => {
    const result = await handler.validateUrl("https://mixed.example/", {
      resolver: resolvesTo("93.184.216.34", "127.0.0.1"),
    });
    expect(result.status).toBe(LinkStatus.BLOCKED);
  });

  it("blocks rather than allows when resolution fails", async () => {
    const result = await handler.validateUrl("https://nx.example/", {
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.status).toBe(LinkStatus.BLOCKED);
    expect(result.reason).toBe("Host could not be resolved");
  });

  it("allows a name that resolves entirely to public addresses", async () => {
    const result = await handler.validateUrl("https://example.com/page", {
      resolver: resolvesTo("93.184.216.34", "2606:2800:220:1::1"),
    });
    expect(result.status).toBe(LinkStatus.SAFE);
    expect(result.normalizedUrl?.domain).toBe("example.com");
  });

  it("short-circuits on the lexical verdict without querying DNS", async () => {
    let queried = false;
    const result = await handler.validateUrl("http://127.0.0.1/", {
      resolver: async () => {
        queried = true;
        return ["1.1.1.1"];
      },
    });
    expect(result.status).toBe(LinkStatus.BLOCKED);
    expect(queried).toBe(false);
  });
});
