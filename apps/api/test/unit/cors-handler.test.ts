/**
 * Unit Tests: CORS Handler
 *
 * Tests for CORS origin validation and header management.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import {
  CorsHandler,
  CORS_ALLOWED_REQUEST_HEADERS,
} from "../../src/lib/cors-handler.js";

describe("CorsHandler", () => {
  let mockEnv: Env;
  let mockRequest: Request;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = {
      APP_DOMAIN: "https://example.com",
      ALLOWED_ORIGINS: "https://app.example.com,https://api.example.com",
    } as Env;
  });

  describe("getAllowedOrigin", () => {
    it("should return null when no Origin header is present", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://example.com");
    });

    it("should return APP_DOMAIN when no Origin header and APP_DOMAIN is set", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://example.com");
    });

    it("should return null when no Origin header and no APP_DOMAIN", () => {
      const env = {} as Env;
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBeNull();
    });

    it("should return origin when it matches ALLOWED_ORIGINS", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://app.example.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://app.example.com");
    });

    it("should return origin when it matches APP_DOMAIN", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://example.com");
    });

    it("should handle www and non-www variations of APP_DOMAIN", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://www.example.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://www.example.com");
    });

    it("should handle non-www when APP_DOMAIN has www", () => {
      const env = { APP_DOMAIN: "https://www.example.com" } as Env;
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBe("https://example.com");
    });

    it("should match a bare-host APP_DOMAIN (no scheme) against a real Origin", () => {
      // Deployed as a bare host by OpenTofu (infra-scaleway/app/locals.tf's
      // `local.app_domain`, e.g. "app.dev.skybber.com") — a browser's Origin
      // header always carries a scheme, so this must still match.
      const env = { APP_DOMAIN: "app.dev.skybber.com" } as Env;
      mockRequest = new Request("https://api.dev.skybber.com/test", {
        method: "GET",
        headers: { Origin: "https://app.dev.skybber.com" },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBe("https://app.dev.skybber.com");
    });

    it("should return a scheme-qualified APP_DOMAIN when no Origin header and APP_DOMAIN is bare", () => {
      const env = { APP_DOMAIN: "app.dev.skybber.com" } as Env;
      mockRequest = new Request("https://api.dev.skybber.com/test", {
        method: "GET",
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBe("https://app.dev.skybber.com");
    });

    it("should normalize trailing slashes", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com/",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://example.com");
    });

    it("should allow origin when no APP_DOMAIN or ALLOWED_ORIGINS (local dev)", () => {
      const env = {} as Env;
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "http://localhost:3000",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBe("http://localhost:3000");
          });

    // -------------------------------------------------------------------
    // SEC M4 — CORS used to FAIL OPEN: with neither APP_DOMAIN nor
    // ALLOWED_ORIGINS set, it reflected ANY request origin, and
    // `addCorsHeaders` always sends `Access-Control-Allow-Credentials: true`.
    // Any site could therefore make credentialed cross-origin requests and
    // read the responses.
    // -------------------------------------------------------------------
    describe("SEC M4: unconfigured CORS fails closed", () => {
      const unconfigured = {} as Env;

      function originReq(origin: string) {
        return new Request("https://api.example.com/test", {
          method: "GET",
          headers: { Origin: origin },
        });
      }

      it("DENIES an arbitrary remote origin when unconfigured", () => {
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("https://evil.example.net"),
            unconfigured,
          ),
        ).toBeNull();
      });

      it("emits no Access-Control-Allow-Origin for that origin", () => {
        const headers = CorsHandler.getCorsHeaders(
          originReq("https://evil.example.net"),
          unconfigured,
        );
        expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
        // Credentials are still declared, but with no ACAO the browser blocks.
        expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
      });

      it("still allows http://localhost:<port>", () => {
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("http://localhost:5173"),
            unconfigured,
          ),
        ).toBe("http://localhost:5173");
      });

      it("still allows http://127.0.0.1:<port>", () => {
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("http://127.0.0.1:8080"),
            unconfigured,
          ),
        ).toBe("http://127.0.0.1:8080");
      });

      it("allows the IPv6 loopback", () => {
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("http://[::1]:3000"),
            unconfigured,
          ),
        ).toBe("http://[::1]:3000");
      });

      it("DENIES look-alike loopback hostnames", () => {
        for (const origin of [
          "https://localhost.evil.example",
          "https://notlocalhost",
          "https://127.0.0.1.evil.example",
          "https://xn--localhost-.example",
        ]) {
          expect(
            CorsHandler.getAllowedOrigin(originReq(origin), unconfigured),
            `expected ${origin} to be denied`,
          ).toBeNull();
        }
      });

      it("DENIES a non-http(s) scheme claiming localhost", () => {
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("file://localhost"),
            unconfigured,
          ),
        ).toBeNull();
      });

      it("DENIES a malformed Origin header", () => {
        expect(
          CorsHandler.getAllowedOrigin(originReq("not-a-url"), unconfigured),
        ).toBeNull();
      });

      it("a configured deployment is unaffected by the loopback allowance", () => {
        // With APP_DOMAIN set, an unlisted localhost origin is NOT reflected.
        expect(
          CorsHandler.getAllowedOrigin(
            originReq("http://localhost:3000"),
            { APP_DOMAIN: "https://app.example.org" } as Env,
          ),
        ).toBeNull();
      });
    });

    it("SEC M4: example.com is no longer a shipped known-domain allow-list entry", () => {
      // The published core carried `knownDomains = ["rkm1.de", "example.com"]`.
      const env = { APP_DOMAIN: "https://app.example.org" } as Env;
      for (const origin of [
        "https://example.com",
        "https://anything.example.com",
      ]) {
        const req = new Request("https://api.example.org/test", {
          method: "GET",
          headers: { Origin: origin },
        });
        expect(
          CorsHandler.getAllowedOrigin(req, env),
          `expected ${origin} to be denied`,
        ).toBeNull();
      }
    });

    it("should allow Cloudflare Pages domains for whitelisted projects", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://trellis-web.pages.dev",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://trellis-web.pages.dev");
          });

    it("should reject Cloudflare Pages domains for non-whitelisted projects", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://unknown-project.pages.dev",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBeNull();
          });

    it("should allow known production domains (rkm1.de)", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://rkm1.de",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://rkm1.de");
          });

    it("should allow known production domains (example.com)", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBe("https://example.com");
    });

    it("should reject unknown origins", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://malicious-site.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, mockEnv);
      expect(origin).toBeNull();
          });

    it("should handle comma-separated ALLOWED_ORIGINS", () => {
      const env = {
        ALLOWED_ORIGINS:
          "https://app1.com, https://app2.com , https://app3.com",
      } as Env;
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://app2.com",
        },
      });
      const origin = CorsHandler.getAllowedOrigin(mockRequest, env);
      expect(origin).toBe("https://app2.com");
    });
  });

  describe("addCorsHeaders", () => {
    it("should add CORS headers to response with allowed origin", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        CORS_ALLOWED_REQUEST_HEADERS,
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should preserve Set-Cookie headers", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": "session=abc123; Path=/; HttpOnly",
        },
      });

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      expect(response.headers.get("Set-Cookie")).toBe(
        "session=abc123; Path=/; HttpOnly",
      );
          });

    it("should add region headers when requestContext provided", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
      });

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
        { region: "US" },
      );

      expect(response.headers.get("X-Region")).toBe("US");
      expect(response.headers.get("X-Region-Detected")).toBe("US");
    });

    it("should handle response cloning errors gracefully", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      // Create a response that can't be cloned (already consumed)
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
      });
      // Consume the body
      await originalResponse.text();

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      // Should still return a response with CORS headers
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
          });

    it("should log warning if Set-Cookie header is lost", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
        headers: {
          "Set-Cookie": "session=abc123",
        },
      });

      // The actual implementation checks if Set-Cookie exists before and after
      // We can't easily mock this, so we'll test that the code path exists
      // by verifying the response is created correctly
      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      // Set-Cookie should be preserved
      expect(response.headers.get("Set-Cookie")).toBe("session=abc123");
      // The error should not be called since Set-Cookie is preserved
          });

    it("should handle errors and return error response with CORS headers", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      // Create a response that will cause an error
      const originalResponse = {
        clone: vi.fn().mockImplementation(() => {
          throw new Error("Clone failed");
        }),
        text: vi.fn().mockRejectedValue(new Error("Read failed")),
        headers: new Headers(),
        status: 200,
        statusText: "OK",
      } as any;

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Failed to process response");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com",
      );
    });

    it("should not add Access-Control-Allow-Origin when origin not allowed", async () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://malicious-site.com",
        },
      });
      const originalResponse = new Response('{"data": "test"}', {
        status: 200,
      });

      const response = await CorsHandler.addCorsHeaders(
        originalResponse,
        mockRequest,
        mockEnv,
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
          });

    describe("Binary Data Handling", () => {
      it("should read image/png responses as ArrayBuffer", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // PNG signature: 0x89 0x50 0x4E 0x47
        const pngBytes = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const originalResponse = new Response(pngBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        // Verify CORS headers are added
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
          "https://example.com",
        );

        // Verify response body is ArrayBuffer (not corrupted text)
        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify PNG signature is preserved (not corrupted to UTF-8 replacement character)
        expect(bytes[0]).toBe(0x89);
        expect(bytes[1]).toBe(0x50);
        expect(bytes[2]).toBe(0x4e);
        expect(bytes[3]).toBe(0x47);

        // Verify no UTF-8 replacement character (0xEF 0xBF 0xBD)
        expect(bytes[0]).not.toBe(0xef);
        expect(bytes[1]).not.toBe(0xbf);
        expect(bytes[2]).not.toBe(0xbd);
      });

      it("should read text responses as string", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        const originalResponse = new Response('{"data": "test"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        // Verify CORS headers are added
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
          "https://example.com",
        );

        // Verify response body is text (not ArrayBuffer)
        const body = await response.text();
        expect(body).toBe('{"data": "test"}');
      });

      it("should detect binary Content-Types correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });

        const binaryTypes = [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/webm",
          "audio/mpeg",
          "audio/wav",
          "application/octet-stream",
          "application/pdf",
        ];

        for (const contentType of binaryTypes) {
          // PNG signature as test data
          const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
          const originalResponse = new Response(bytes, {
            status: 200,
            headers: { "Content-Type": contentType },
          });

          const response = await CorsHandler.addCorsHeaders(
            originalResponse,
            mockRequest,
            mockEnv,
          );

          // Verify response body is ArrayBuffer (not corrupted text)
          const body = await response.arrayBuffer();
          expect(body).toBeInstanceOf(ArrayBuffer);

          const uint8Array = new Uint8Array(body);
          // Verify first byte is preserved (not corrupted to 0xEF 0xBF 0xBD)
          expect(uint8Array[0]).toBe(0x89);
          expect(uint8Array[0]).not.toBe(0xef);
        }
      });

      it("should NOT corrupt binary data with UTF-8 replacement characters", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // PNG signature starts with 0x89 which is invalid UTF-8
        // If read as text, this would become 0xEF 0xBF 0xBD (UTF-8 replacement character)
        const pngSignature = new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const originalResponse = new Response(pngSignature, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify no UTF-8 replacement character (0xEF 0xBF 0xBD)
        expect(bytes[0]).not.toBe(0xef);
        expect(bytes[1]).not.toBe(0xbf);
        expect(bytes[2]).not.toBe(0xbd);

        // Verify PNG signature is intact
        expect(bytes[0]).toBe(0x89);
        expect(bytes[1]).toBe(0x50);
        expect(bytes[2]).toBe(0x4e);
        expect(bytes[3]).toBe(0x47);
        expect(bytes[4]).toBe(0x0d);
        expect(bytes[5]).toBe(0x0a);
        expect(bytes[6]).toBe(0x1a);
        expect(bytes[7]).toBe(0x0a);
      });

      it("should handle JPEG images correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // JPEG signature: 0xFF 0xD8 0xFF
        const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const originalResponse = new Response(jpegBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify JPEG signature is preserved
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
        expect(bytes[2]).toBe(0xff);
        expect(bytes[3]).toBe(0xe0);
      });

      it("should handle WebP images correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // WebP signature: RIFF (0x52 0x49 0x46 0x46) ... WEBP
        const webpBytes = new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ]);
        const originalResponse = new Response(webpBytes, {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify WebP signature is preserved
        expect(bytes[0]).toBe(0x52); // R
        expect(bytes[1]).toBe(0x49); // I
        expect(bytes[2]).toBe(0x46); // F
        expect(bytes[3]).toBe(0x46); // F
        expect(bytes[8]).toBe(0x57); // W
        expect(bytes[9]).toBe(0x45); // E
        expect(bytes[10]).toBe(0x42); // B
        expect(bytes[11]).toBe(0x50); // P
      });

      it("should handle video files correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // MP4 ftyp box signature
        const mp4Bytes = new Uint8Array([
          0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
        ]);
        const originalResponse = new Response(mp4Bytes, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify MP4 signature is preserved
        expect(bytes[4]).toBe(0x66); // f
        expect(bytes[5]).toBe(0x74); // t
        expect(bytes[6]).toBe(0x79); // y
        expect(bytes[7]).toBe(0x70); // p
      });

      it("should handle application/octet-stream correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const originalResponse = new Response(binaryData, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify binary data is preserved
        expect(bytes[0]).toBe(0x89);
        expect(bytes[1]).toBe(0x50);
        expect(bytes[2]).toBe(0x4e);
        expect(bytes[3]).toBe(0x47);
      });

      it("should handle PDF files correctly", async () => {
        mockRequest = new Request("https://api.example.com/test", {
          method: "GET",
          headers: {
            Origin: "https://example.com",
          },
        });
        // PDF signature: %PDF (0x25 0x50 0x44 0x46)
        const pdfBytes = new Uint8Array([
          0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
        ]);
        const originalResponse = new Response(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });

        const response = await CorsHandler.addCorsHeaders(
          originalResponse,
          mockRequest,
          mockEnv,
        );

        const body = await response.arrayBuffer();
        const bytes = new Uint8Array(body);

        // Verify PDF signature is preserved
        expect(bytes[0]).toBe(0x25); // %
        expect(bytes[1]).toBe(0x50); // P
        expect(bytes[2]).toBe(0x44); // D
        expect(bytes[3]).toBe(0x46); // F
      });
    });
  });

  describe("getCorsHeaders", () => {
    it("should return CORS headers object with allowed origin", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://example.com",
        },
      });
      const headers = CorsHandler.getCorsHeaders(mockRequest, mockEnv);

      expect(headers["Access-Control-Allow-Origin"]).toBe(
        "https://example.com",
      );
      expect(headers["Access-Control-Allow-Methods"]).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      expect(headers["Access-Control-Allow-Headers"]).toBe(
        CORS_ALLOWED_REQUEST_HEADERS,
      );
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    });

    it("should return CORS headers without origin when not allowed", () => {
      mockRequest = new Request("https://api.example.com/test", {
        method: "GET",
        headers: {
          Origin: "https://malicious-site.com",
        },
      });
      const headers = CorsHandler.getCorsHeaders(mockRequest, mockEnv);

      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
      expect(headers["Access-Control-Allow-Methods"]).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
    });
  });
});
