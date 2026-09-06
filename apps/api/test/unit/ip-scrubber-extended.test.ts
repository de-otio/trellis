/**
 * Extended Unit Tests: IP Scrubber
 *
 * Tests edge cases for IP address extraction and scrubbing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The `full` level is a keyed HMAC (DP-9); tests supply a fixed 32-byte key.
const TEST_HMAC_KEY = Buffer.alloc(32, 7);
import {
  getIPAddress,
  scrubIPAddress,
  getIPAddressWithEnvScrubbing,
} from "../../src/lib/ip-scrubber.js";
import type {
  IPScrubberConfig,
  IPScrubberEnv,
} from "../../src/lib/ip-scrubber.js";

describe("IP Scrubber Extended", () => {
  describe("getIPAddress", () => {
    it("should extract IP from CF-Connecting-IP header", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-Connecting-IP": "192.168.1.1" },
      });
      const ip = getIPAddress(request);
      expect(ip).toBe("192.168.1.1");
    });

    it("should extract IP from X-Forwarded-For header", () => {
      const request = new Request("https://api.example.com", {
        headers: { "X-Forwarded-For": "10.0.0.1" },
      });
      const ip = getIPAddress(request);
      expect(ip).toBe("10.0.0.1");
    });

    it("should handle X-Forwarded-For with multiple IPs", () => {
      const request = new Request("https://api.example.com", {
        headers: { "X-Forwarded-For": "192.168.1.1, 10.0.0.1" },
      });
      const ip = getIPAddress(request);
      expect(ip).toBe("192.168.1.1");
    });

    it("should return unknown if no IP headers present", () => {
      const request = new Request("https://api.example.com");
      const ip = getIPAddress(request);
      expect(ip).toBe("unknown");
    });

    it("should prioritize CF-Connecting-IP over X-Forwarded-For", () => {
      const request = new Request("https://api.example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.1",
          "X-Forwarded-For": "10.0.0.1",
        },
      });
      const ip = getIPAddress(request);
      expect(ip).toBe("192.168.1.1");
    });

    it("should apply scrubbing when config provided", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-Connecting-IP": "192.168.1.100" },
      });
      const config: IPScrubberConfig = {
        enabled: true,
        level: "partial",
        preserveForRateLimit: false,
      };
      const ip = getIPAddress(request, config);
      expect(ip).toBe("192.168.1.x");
    });
  });

  describe("scrubIPAddress", () => {
    it("should scrub IPv4 addresses partially", () => {
      const config: IPScrubberConfig = {
        enabled: true,
        level: "partial",
        preserveForRateLimit: false,
      };
      expect(scrubIPAddress("192.168.1.1", config)).toBe("192.168.1.x");
      expect(scrubIPAddress("10.0.0.1", config)).toBe("10.0.0.x");
    });

    it("should scrub IPv6 addresses partially", () => {
      const config: IPScrubberConfig = {
        enabled: true,
        level: "partial",
        preserveForRateLimit: false,
      };
      const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
      const result = scrubIPAddress(ipv6, config);
      expect(result).toBe("2001:0db8:85a3:0000::x");
    });

    it("should fully scrub when level is full", () => {
      const config: IPScrubberConfig = {
        enabled: true,
        level: "full",
        preserveForRateLimit: false,
        hmacKey: TEST_HMAC_KEY,
      };
      const result = scrubIPAddress("192.168.1.1", config);
      expect(result).toContain("hashed:");
    });

    it("should handle unknown IP", () => {
      const config: IPScrubberConfig = {
        enabled: true,
        level: "partial",
        preserveForRateLimit: false,
      };
      expect(scrubIPAddress("unknown", config)).toBe("unknown");
    });

    it("should not scrub when disabled", () => {
      const config: IPScrubberConfig = {
        enabled: false,
        level: "partial",
        preserveForRateLimit: false,
      };
      expect(scrubIPAddress("192.168.1.1", config)).toBe("192.168.1.1");
    });
  });

  describe("getIPAddressWithEnvScrubbing", () => {
    it("should not scrub when IP_SCRUBBING_ENABLED is not set", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-Connecting-IP": "192.168.1.100" },
      });
      const env: IPScrubberEnv = {};
      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.100");
    });

    it("should scrub when IP_SCRUBBING_ENABLED=true", () => {
      const request = new Request("https://api.example.com", {
        headers: { "CF-Connecting-IP": "192.168.1.100" },
      });
      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
      };
      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.x");
    });
  });
});
