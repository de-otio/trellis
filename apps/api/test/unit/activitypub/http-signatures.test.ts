/**
 * Unit Tests: HTTP Signatures Service
 *
 * Tests for HTTP Signature signing and verification.
 *
 * Logger note (1.B.3 Track C): per the trellis testing strategy, log
 * emission is NOT the observable behavior of `HttpSignatureService`.
 * The contract is `verifyRequest` returns `false` for any rejection
 * path. Every rejection branch is asserted via `expect(isValid).toBe(false)`;
 * we do not assert on logger calls or use `createTestLogCapture` here.
 */

import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpSignatureService } from "../../../src/lib/activitypub/http-signatures.js";

// Mock global fetch
global.fetch = vi.fn();

// Mock standalone mode
vi.mock("../../../src/lib/activitypub/standalone-mode", () => ({
  isStandaloneModeEnabled: vi.fn().mockResolvedValue(false),
  isRemoteUri: vi.fn((uri, env) => {
    const baseUrl = env.ACTIVITYPUB_BASE_URL || "https://example.com";
    return !uri.startsWith(baseUrl);
  }),
}));

describe("HttpSignatureService", () => {
  let mockEnv: { LOG_LEVEL: string; ACTIVITYPUB_BASE_URL: string };
  let keyPair: { publicKey: string; privateKey: string };

  beforeEach(() => {
    // Generate RSA key pair for testing
    keyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    });

    mockEnv = {
      LOG_LEVEL: "info",
      ACTIVITYPUB_BASE_URL: "https://example.com",
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("signRequest", () => {
    it("should sign a request with correct format", () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      const result = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      expect(result.signature).toContain(
        'keyId="https://example.com/users/alice#main-key"',
      );
      expect(result.signature).toContain('algorithm="rsa-sha256"');
      expect(result.signature).toContain(
        'headers="(request-target) host date"',
      );
      expect(result.signature).toContain("signature=");
      expect(result.date).toBeTruthy();
    });

    it("should include correct headers in signature", () => {
      const method = "GET";
      const path = "/users/alice/outbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      const result = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      // Verify signature can be verified
      const signatureMatch = result.signature.match(/signature="([^"]+)"/);
      expect(signatureMatch).toBeTruthy();
      const signature = signatureMatch![1];

      const signatureString = [
        `(request-target): ${method.toLowerCase()} ${path}`,
        `host: ${host}`,
        `date: ${result.date}`,
      ].join("\n");

      const verify = crypto.createVerify("RSA-SHA256");
      verify.update(signatureString);
      const isValid = verify.verify(keyPair.publicKey, signature, "base64");

      expect(isValid).toBe(true);
    });
  });

  describe("addSignatureHeaders", () => {
    it("should add Signature and Date headers to request", () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
      });
      const keyId = "https://example.com/users/alice#main-key";

      const headers = HttpSignatureService.addSignatureHeaders(
        request,
        keyPair.privateKey,
        keyId,
      );

      expect(headers.get("Signature")).toBeTruthy();
      expect(headers.get("Date")).toBeTruthy();
      expect(headers.get("Signature")).toContain(
        'keyId="https://example.com/users/alice#main-key"',
      );
    });
  });

  describe("verifyRequest", () => {
    it("should verify a valid signature", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      // Sign the request
      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      // Create request with signature
      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock actor document fetch
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "https://example.com/users/alice",
          type: "Person",
          publicKey: {
            id: keyId,
            owner: "https://example.com/users/alice",
            publicKeyPem: keyPair.publicKey,
          },
        }),
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      expect(isValid).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com/users/alice",
        expect.objectContaining({
          headers: {
            Accept: "application/activity+json",
          },
        }),
      );
    });

    it("should reject request without Signature header", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: missing-signature rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request with invalid algorithm", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature:
            'keyId="test",algorithm="hmac-sha256",headers="(request-target) host date",signature="test"',
          Date: new Date().toUTCString(),
          Host: "example.com",
        },
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: unsupported-algorithm rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request from remote actor when fetch fails", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://remote.example.com/users/alice#main-key";

      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock fetch to fail for remote actor
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: remote-fetch-failure returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request when actor document fetch fails", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock failed actor document fetch
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: actor-doc-fetch-failure returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request when actor document missing publicKey", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock actor document without publicKey
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "https://example.com/users/alice",
          type: "Person",
        }),
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: missing-publicKey rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request when keyId mismatch", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock actor document with different keyId
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "https://example.com/users/alice",
          type: "Person",
          publicKey: {
            id: "https://example.com/users/alice#different-key",
            owner: "https://example.com/users/alice",
            publicKeyPem: keyPair.publicKey,
          },
        }),
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: keyId-mismatch rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should reject request with invalid signature", async () => {
      const method = "POST";
      const path = "/users/bob/inbox";
      const host = "example.com";
      const keyId = "https://example.com/users/alice#main-key";

      // Generate different key pair for verification
      const differentKeyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: "spki",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem",
        },
      });

      const { signature, date } = HttpSignatureService.signRequest(
        method,
        path,
        host,
        keyPair.privateKey,
        keyId,
      );

      const request = new Request(`https://${host}${path}`, {
        method,
        headers: {
          Signature: signature,
          Date: date,
          Host: host,
        },
      });

      // Mock actor document with different public key
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "https://example.com/users/alice",
          type: "Person",
          publicKey: {
            id: keyId,
            owner: "https://example.com/users/alice",
            publicKeyPem: differentKeyPair.publicKey, // Different key
          },
        }),
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: bad-signature rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should handle invalid signature header format", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature: "invalid-format",
          Date: new Date().toUTCString(),
          Host: "example.com",
        },
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: parse-failure rejection returns false.
      expect(isValid).toBe(false);
    });

    it("should handle missing required header in signature string", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date missing-header",signature="test"',
          Date: new Date().toUTCString(),
          Host: "example.com",
          // Missing 'missing-header'
        },
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      expect(isValid).toBe(false);
    });

    it("should handle remote actor in standalone mode", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature:
            'keyId="https://remote.example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="test"',
          Date: new Date().toUTCString(),
          Host: "example.com",
        },
      });

      const { isStandaloneModeEnabled } = await import(
        "../../../src/lib/activitypub/standalone-mode.js"
      );
      vi.mocked(isStandaloneModeEnabled).mockResolvedValue(true);

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      // Outcome: standalone-mode rejects remote signatures with false.
      expect(isValid).toBe(false);
    });

    it("should handle invalid keyId format (missing #)", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature:
            'keyId="invalid-keyid",algorithm="rsa-sha256",headers="(request-target) host date",signature="test"',
          Date: new Date().toUTCString(),
          Host: "example.com",
        },
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      expect(isValid).toBe(false);
    });

    it("should handle crypto errors during verification", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="invalid-base64"',
          Date: new Date().toUTCString(),
          Host: "example.com",
        },
      });

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "https://example.com/users/alice",
          type: "Person",
          publicKey: {
            id: "https://example.com/users/alice#main-key",
            owner: "https://example.com/users/alice",
            publicKeyPem: keyPair.publicKey,
          },
        }),
      });

      const isValid = await HttpSignatureService.verifyRequest(
        request,
        mockEnv,
      );

      expect(isValid).toBe(false);
    });
  });
});
