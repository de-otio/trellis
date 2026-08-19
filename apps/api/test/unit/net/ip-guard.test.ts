/**
 * Adversarial coverage for the IP parser and range tables.
 *
 * The review's concrete bypass list is the spine of this file: every encoding
 * that slipped past the old dotted-quad regex gets an explicit case, and each
 * one must be classified as blocked.
 */

import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  classifyHostname,
  classifyParsedIp,
  parseIpLiteral,
  parseIpv4,
  parseIpv6,
} from "../../../src/lib/net/ip-guard.js";

describe("parseIpv4 — alternate encodings", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"], // bare decimal
    ["0x7f000001", "127.0.0.1"], // hex
    ["017700000001", "127.0.0.1"], // octal
    ["0177.0.0.01", "127.0.0.1"], // per-part octal
    ["127.1", "127.0.0.1"], // short form
    ["127.0.1", "127.0.0.1"],
    ["0", "0.0.0.0"],
    ["0x0", "0.0.0.0"],
    ["2852039166", "169.254.169.254"], // metadata IP as bare decimal
    ["169.254.169.254", "169.254.169.254"],
    ["0xa9fea9fe", "169.254.169.254"],
    ["127.0.0.1.", "127.0.0.1"], // trailing dot
  ];

  it.each(cases)("normalises %s to %s", (input, expected) => {
    const parsed = parseIpv4(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.canonical).toBe(expected);
    expect(parsed!.family).toBe(4);
  });

  it.each([
    ["not-an-ip"],
    ["256.1.1.1"],
    ["1.2.3.4.5"],
    ["08"], // invalid octal digit
    ["1.2.3.999"],
    [""],
  ])("rejects %s as a v4 literal", (input) => {
    expect(parseIpv4(input)).toBeNull();
  });
});

describe("parseIpv6", () => {
  it.each([
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["::ffff:127.0.0.1", "::ffff:7f00:1"],
    ["[::ffff:127.0.0.1]", "::ffff:7f00:1"],
    ["0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:a9fe:a9fe"],
    ["fe80::1", "fe80::1"],
    ["fd00::abcd", "fd00::abcd"],
    ["2001:4860:4860::8888", "2001:4860:4860::8888"],
  ])("normalises %s to %s", (input, expected) => {
    const parsed = parseIpv6(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.canonical).toBe(expected);
    expect(parsed!.family).toBe(6);
  });

  it("rejects a zone id", () => {
    expect(parseIpv6("fe80::1%eth0")).toBeNull();
  });

  it("rejects two :: runs", () => {
    expect(parseIpv6("1::2::3")).toBeNull();
  });

  it("rejects a wrong group count", () => {
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("classifyAddress — the ranges that matter", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"], // AWS/GCP metadata
    ["169.254.42.42", "link-local"], // Scaleway metadata
    ["100.64.0.1", "cgnat"],
    ["100.100.100.200", "cgnat"], // Alibaba metadata
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["198.18.0.1", "reserved"],
    ["192.0.2.5", "documentation"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fd00::1", "unique-local"],
    ["fc00::1", "unique-local"],
    ["ff02::1", "multicast"],
    ["::", "unspecified"],
    ["2001:db8::1", "documentation"],
  ];

  it.each(blocked)("blocks %s as %s", (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe(reason);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"], ["2606:4700::1111"]])(
    "allows public address %s",
    (address) => {
      expect(classifyAddress(address).blocked).toBe(false);
    },
  );

  it("blocks an unparseable address rather than allowing it", () => {
    expect(classifyAddress("bogus").blocked).toBe(true);
  });
});

describe("classifyAddress — IPv4 smuggled inside IPv6", () => {
  it.each([
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.0.0.1", "private"],
    ["64:ff9b::127.0.0.1", "loopback"], // NAT64
    ["2002:7f00:0001::", "loopback"], // 6to4 wrapping 127.0.0.1
    ["::127.0.0.1", "loopback"], // deprecated v4-compatible
  ])("unwraps %s and blocks it as %s", (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe(reason);
  });

  it("still allows a mapped public address", () => {
    expect(classifyAddress("::ffff:8.8.8.8").blocked).toBe(false);
  });
});

describe("classifyHostname", () => {
  it.each([
    ["localhost"],
    ["LOCALHOST"],
    ["localhost.localdomain"],
    ["foo.local"],
    ["db.internal"],
    ["host.corp"],
    ["printer.lan"],
    ["metadata"],
    ["metadata.google.internal"],
  ])("blocks internal name %s", (host) => {
    expect(classifyHostname(host).blocked).toBe(true);
  });

  it("blocks a bracketed IPv6 loopback host", () => {
    expect(classifyHostname("[::1]").blocked).toBe(true);
  });

  it("blocks an encoded loopback host", () => {
    expect(classifyHostname("2130706433").blocked).toBe(true);
    expect(classifyHostname("0x7f000001").blocked).toBe(true);
  });

  it("treats `0x` as 0.0.0.0, matching the WHATWG URL host parser", () => {
    // Documented quirk: the URL Standard's IPv4 parser reads bare "0x" as 0.
    // We must agree with it, or undici and the guard disagree about the target.
    expect(new URL("http://0x/").hostname).toBe("0.0.0.0");
    expect(classifyHostname("0x").blocked).toBe(true);
  });

  it("allows an ordinary public name — DNS must still be checked", () => {
    expect(classifyHostname("example.com").blocked).toBe(false);
  });
});

describe("parseIpLiteral", () => {
  it("returns null for a domain name so the caller knows to resolve it", () => {
    expect(parseIpLiteral("example.com")).toBeNull();
    expect(parseIpLiteral("metadata.attacker.com")).toBeNull();
  });

  it("round-trips through classifyParsedIp", () => {
    const parsed = parseIpLiteral("0x7f000001")!;
    expect(classifyParsedIp(parsed).reason).toBe("loopback");
  });
});
