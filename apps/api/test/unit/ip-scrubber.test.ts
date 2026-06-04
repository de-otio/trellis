import { describe, expect, it } from "vitest";
import {
  scrubIPAddress,
  getIPAddress,
  getIPAddressWithEnvScrubbing,
  IPScrubberConfig,
  IPScrubberEnv,
} from "../../src/lib/ip-scrubber.js";

describe("IP Scrubber", () => {
  describe("scrubIPAddress", () => {
    describe("IPv4 Scrubbing", () => {
      it("should not scrub when disabled", () => {
        const config: IPScrubberConfig = {
          enabled: false,
          level: "partial",
          preserveForRateLimit: false,
        };

        expect(scrubIPAddress("192.168.1.100", config)).toBe("192.168.1.100");
      });

      it("should partially scrub IPv4 (last octet)", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "partial",
          preserveForRateLimit: false,
        };

        expect(scrubIPAddress("192.168.1.100", config)).toBe("192.168.1.x");
      });

      it("should fully scrub IPv4 (hash)", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "full",
          preserveForRateLimit: false,
        };

        const result = scrubIPAddress("192.168.1.100", config);
        expect(result).toContain("hashed:");
      });

      it("should handle level=none same as disabled", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "none",
          preserveForRateLimit: false,
        };

        expect(scrubIPAddress("192.168.1.100", config)).toBe("192.168.1.100");
      });
    });

    describe("IPv6 Scrubbing", () => {
      it("should partially scrub IPv6 (first 64 bits)", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "partial",
          preserveForRateLimit: false,
        };

        const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
        const result = scrubIPAddress(ipv6, config);
        expect(result).toBe("2001:0db8:85a3:0000::x");
      });

      it("should fully scrub IPv6 (hash)", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "full",
          preserveForRateLimit: false,
        };

        const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
        const result = scrubIPAddress(ipv6, config);
        expect(result).toContain("hashed:");
      });

      it("should handle compressed IPv6", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "partial",
          preserveForRateLimit: false,
        };

        const ipv6 = "2001:db8::8a2e:370:7334";
        const result = scrubIPAddress(ipv6, config);
        // Should preserve first 4 segments and scrub the rest
        expect(result).toContain("2001:db8::");
        expect(result).toContain("::x");
      });
    });

    describe("Edge Cases", () => {
      it("should handle invalid IP format", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "partial",
          preserveForRateLimit: false,
        };

        expect(scrubIPAddress("invalid-ip", config)).toBe("invalid-ip");
      });

      it("should handle unknown IP", () => {
        const config: IPScrubberConfig = {
          enabled: true,
          level: "partial",
          preserveForRateLimit: false,
        };

        expect(scrubIPAddress("unknown", config)).toBe("unknown");
      });
    });
  });

  describe("getIPAddress", () => {
    it("should extract from CF-Connecting-IP header", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "203.0.113.42",
        },
      });

      expect(getIPAddress(request)).toBe("203.0.113.42");
    });

    it("should extract from X-Forwarded-For header", () => {
      const request = new Request("https://example.com", {
        headers: {
          "X-Forwarded-For": "203.0.113.42, 198.51.100.1",
        },
      });

      expect(getIPAddress(request)).toBe("203.0.113.42");
    });

    it("should prefer CF-Connecting-IP over X-Forwarded-For", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "203.0.113.42",
          "X-Forwarded-For": "198.51.100.1",
        },
      });

      expect(getIPAddress(request)).toBe("203.0.113.42");
    });

    it('should return "unknown" when no IP headers present', () => {
      const request = new Request("https://example.com");
      expect(getIPAddress(request)).toBe("unknown");
    });

    it("should apply scrubbing when config provided", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const config: IPScrubberConfig = {
        enabled: true,
        level: "partial",
        preserveForRateLimit: false,
      };

      expect(getIPAddress(request, config)).toBe("192.168.1.x");
    });
  });

  describe("getIPAddressWithEnvScrubbing", () => {
    it("should not scrub when IP_SCRUBBING_ENABLED is not set", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const env: IPScrubberEnv = {};
      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.100");
    });

    it("should scrub when IP_SCRUBBING_ENABLED=true", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
      };

      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.x");
    });

    it("should use partial level by default", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
      };

      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.x");
    });

    it("should respect IP_SCRUBBING_LEVEL=full", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
        IP_SCRUBBING_LEVEL: "full",
      };

      const result = getIPAddressWithEnvScrubbing(request, env);
      expect(result).toContain("hashed:");
    });

    it("should respect IP_SCRUBBING_LEVEL=none", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
        IP_SCRUBBING_LEVEL: "none",
      };

      expect(getIPAddressWithEnvScrubbing(request, env)).toBe("192.168.1.100");
    });

    it("should handle missing env parameter", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "192.168.1.100",
        },
      });

      expect(getIPAddressWithEnvScrubbing(request)).toBe("192.168.1.100");
    });
  });

  describe("GDPR Compliance", () => {
    it("should support privacy-preserving rate limiting with partial scrubbing", () => {
      const request = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "203.0.113.42",
        },
      });

      const env: IPScrubberEnv = {
        IP_SCRUBBING_ENABLED: "true",
        IP_SCRUBBING_LEVEL: "partial",
      };

      const scrubbedIP = getIPAddressWithEnvScrubbing(request, env);
      expect(scrubbedIP).toBe("203.0.113.x");

      // Verify it's still useful for rate limiting (same subnet)
      const request2 = new Request("https://example.com", {
        headers: {
          "CF-Connecting-IP": "203.0.113.99",
        },
      });

      const scrubbedIP2 = getIPAddressWithEnvScrubbing(request2, env);
      expect(scrubbedIP2).toBe("203.0.113.x");
      expect(scrubbedIP).toBe(scrubbedIP2);
    });
  });
});
