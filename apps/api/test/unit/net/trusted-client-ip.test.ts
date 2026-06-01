/**
 * Unit tests: trellis trustedClientIp wrapper.
 *
 * The wrapper's whole reason to exist is normalising `env.TRUSTED_PROXY`
 * (any case, or an unknown value) to the foundation's strict
 * `TrustedProxyMode` before delegating. These tests lock that normalisation
 * AND the security-relevant behaviour it gates — because the wrong mode means
 * either trusting an attacker-supplied header (spoofed rate-limit / audit IP)
 * or ignoring a legitimate proxy.
 *
 * Foundation is npm-linked, so this exercises the real derivation (rightmost
 * XFF for alb, CF-Connecting-IP for cloudflare, shape + reserved-block
 * rejection) rather than a mock.
 */

import { describe, expect, it } from "vitest";
import { trustedClientIp } from "../../../src/lib/net/trusted-client-ip.js";

function req(headers: Record<string, string>): Request {
  return new Request("https://api.example.com/", { headers });
}

// NB: the RFC 5737 documentation ranges (192.0.2.x / 198.51.100.x /
// 203.0.113.x) are themselves RFC 6890-reserved, so the foundation's
// reserved-block guard returns "unknown" for them. To assert a *retained*
// client IP we must use genuinely-routable public addresses.
const PUBLIC_A = "8.8.8.8"; // Google DNS
const PUBLIC_B = "9.9.9.9"; // Quad9

describe("trustedClientIp — mode normalisation", () => {
  it.each(["alb", "ALB", "Alb", "aLb"])(
    "treats TRUSTED_PROXY=%s as alb (rightmost XFF entry)",
    (proxy) => {
      const r = req({ "X-Forwarded-For": `${PUBLIC_A}, ${PUBLIC_B}` });
      expect(trustedClientIp(r, { TRUSTED_PROXY: proxy })).toBe(PUBLIC_B);
    },
  );

  it.each(["cloudflare", "CLOUDFLARE", "CloudFlare"])(
    "treats TRUSTED_PROXY=%s as cloudflare (CF-Connecting-IP)",
    (proxy) => {
      const r = req({ "CF-Connecting-IP": PUBLIC_A });
      expect(trustedClientIp(r, { TRUSTED_PROXY: proxy })).toBe(PUBLIC_A);
    },
  );

  it("falls back to none when TRUSTED_PROXY is unset", () => {
    // none mode reads the socket remote address, absent on a plain Request —
    // so a (perfectly routable) XFF value must be ignored, yielding "unknown".
    const r = req({ "X-Forwarded-For": PUBLIC_A });
    expect(trustedClientIp(r, {})).toBe("unknown");
  });

  it("falls back to none for an unrecognised TRUSTED_PROXY value", () => {
    // Critically: an unknown mode must NOT trust XFF — that would be a spoof
    // hole. The XFF here is a valid public IP, so "unknown" proves it was ignored.
    const r = req({ "X-Forwarded-For": PUBLIC_A });
    expect(trustedClientIp(r, { TRUSTED_PROXY: "nginx" })).toBe("unknown");
  });
});

describe("trustedClientIp — alb mode trusts only the rightmost (proxy-appended) hop", () => {
  it("ignores a spoofed leftmost client-controlled XFF entry", () => {
    // Attacker prepends a fake IP; ALB appends the real one on the right.
    const r = req({ "X-Forwarded-For": `1.2.3.4, ${PUBLIC_B}` });
    expect(trustedClientIp(r, { TRUSTED_PROXY: "alb" })).toBe(PUBLIC_B);
  });

  it("returns unknown for a single malformed XFF value", () => {
    const r = req({ "X-Forwarded-For": "not-an-ip" });
    expect(trustedClientIp(r, { TRUSTED_PROXY: "alb" })).toBe("unknown");
  });

  it("returns unknown when XFF is absent in alb mode", () => {
    expect(trustedClientIp(req({}), { TRUSTED_PROXY: "alb" })).toBe("unknown");
  });
});

describe("trustedClientIp — reserved-block rejection (SSRF / spoof guard)", () => {
  it("rejects a private-range IP supplied via XFF", () => {
    const r = req({ "X-Forwarded-For": "10.0.0.5" });
    expect(trustedClientIp(r, { TRUSTED_PROXY: "alb" })).toBe("unknown");
  });

  it("rejects loopback supplied via CF-Connecting-IP", () => {
    const r = req({ "CF-Connecting-IP": "127.0.0.1" });
    expect(trustedClientIp(r, { TRUSTED_PROXY: "cloudflare" })).toBe("unknown");
  });
});
