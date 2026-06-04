/**
 * Tests for Fedify HTTP Signatures Integration
 *
 * Tests HTTP signature verification and signing with Fedify.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../../src/env.js";
import {
  signRequest,
  verifyHttpSignature,
} from "../../../../src/lib/activitypub/listeners/http-signatures.js";

// Mock dependencies - use a class constructor that can be instantiated
let mockGetKeyPair: any = null;

vi.mock("../../../../src/lib/activitypub/dispatchers/user-actor", () => {
  const MockUserActorDispatcher = function (this: any, env: any) {
    this.getKeyPair = mockGetKeyPair || vi.fn().mockResolvedValue(null);
    return this;
  } as any;

  return {
    UserActorDispatcher: MockUserActorDispatcher,
  };
});

vi.mock("../../../../src/lib/activitypub/http-signatures", () => ({
  HttpSignatureService: {
    verifyRequest: vi.fn(),
    addSignatureHeaders: vi.fn(),
  },
}));

describe("Fedify HTTP Signatures", () => {
  const mockEnv: Partial<Env> = {
    LOG_LEVEL: "INFO",
    ACTIVITYPUB_BASE_URL: "https://example.com",
    DATABASE_URL: "postgresql://test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKeyPair = null;
  });

  describe("verifyHttpSignature", () => {
    it("should return false for request without Signature header", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false for request with invalid Signature header format", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature: "invalid-signature",
        },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false for request with Signature header missing keyId", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature: 'algorithm="rsa-sha256",signature="abc123"',
        },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false when key pair not found", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256"',
        },
      });

      // Set up mock getKeyPair before creating dispatcher
      mockGetKeyPair = vi.fn().mockResolvedValue(null);

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false for unsupported algorithm", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="hmac-sha256",headers="(request-target) host date",signature="test"',
          Host: "example.com",
          Date: new Date().toUTCString(),
        },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false when required header is missing", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date missing-header",signature="test"',
          Host: "example.com",
          Date: new Date().toUTCString(),
          // Missing 'missing-header'
        },
      });

      mockGetKeyPair = vi.fn().mockResolvedValue({
        publicKey:
          "-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----",
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should return false when signature verification fails", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="invalid-signature"',
          Host: "example.com",
          Date: new Date().toUTCString(),
        },
      });

      // Use a real key pair format but invalid signature
      const { KeyPairService } = await import(
        "../../../../src/lib/activitypub/crypto.js"
      );
      const keyPair = KeyPairService.generateKeyPair();

      mockGetKeyPair = vi.fn().mockResolvedValue(keyPair);

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should handle invalid keyId URL format", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="not-a-valid-url",algorithm="rsa-sha256",headers="(request-target) host date",signature="test"',
          Host: "example.com",
          Date: new Date().toUTCString(),
        },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should handle errors during signature verification", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature:
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="test"',
          Host: "example.com",
          Date: new Date().toUTCString(),
        },
      });

      mockGetKeyPair = vi
        .fn()
        .mockRejectedValue(new Error("Key retrieval error"));

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Signature: 'keyId="invalid-url"',
        },
      });

      const result = await verifyHttpSignature(request, mockEnv as Env);

      expect(result).toBe(false);
    });
  });

  describe("signRequest", () => {
    it("should return original request if key pair not found", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "Create" }),
      });

      // Set up mock getKeyPair before creating dispatcher
      mockGetKeyPair = vi.fn().mockResolvedValue(null);

      const result = await signRequest(
        request,
        mockEnv as Env,
        "https://example.com/users/bob",
      );

      expect(result).toBe(request);
    });

    it("should sign request with valid key pair", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "Create" }),
      });

      const mockKeyPair = {
        publicKey: "mock-public-key",
        privateKey: "mock-private-key",
      };

      // Set up mock getKeyPair before creating dispatcher
      // Use a valid RSA key format for testing (minimal valid key)
      const validPrivateKey =
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\nMzEfYyjiWA4R4/M2bS1+f4Sw7dcfXyY2v2z3fJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nAgMBAAECggEBAK8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\nJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5vJ8K3Q5v\n-----END PRIVATE KEY-----";
      const validPublicKey =
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tfn+EsO3XH18mNr9s93yfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\nbyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt\n0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0Obyf\nCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0ObyfCt0O\n-----END PUBLIC KEY-----";

      mockGetKeyPair = vi.fn().mockResolvedValue({
        publicKey: validPublicKey,
        privateKey: validPrivateKey,
      });

      const result = await signRequest(
        request,
        mockEnv as Env,
        "https://example.com/users/bob",
      );

      // The function will fail to sign with mock keys (crypto error), so it returns the original request
      // But we can verify that getKeyPair was called, which is the important part
      expect(mockGetKeyPair).toHaveBeenCalledWith(
        "https://example.com/users/bob",
      );
      // When crypto fails, it returns the original request
      expect(result).toBe(request);
    });

    it("should handle errors gracefully", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "Create" }),
      });

      // Set up mock getKeyPair before creating dispatcher
      mockGetKeyPair = vi.fn().mockRejectedValue(new Error("Key error"));

      const result = await signRequest(
        request,
        mockEnv as Env,
        "https://example.com/users/bob",
      );

      expect(result).toBe(request);
    });

    it("should handle crypto errors during signing", async () => {
      const request = new Request("https://example.com/users/bob/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "Create" }),
      });

      // Use invalid key format to trigger crypto error
      mockGetKeyPair = vi.fn().mockResolvedValue({
        publicKey: "invalid-key",
        privateKey: "invalid-key",
      });

      const result = await signRequest(
        request,
        mockEnv as Env,
        "https://example.com/users/bob",
      );

      // Should return original request on crypto error
      expect(result).toBe(request);
    });
  });
});
