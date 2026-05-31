/**
 * Unit Tests: ElGamal Encryption
 *
 * Tests the ElGamal encryption stub implementation including validation,
 * interface compliance, and homomorphic properties.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ElGamalEncryption } from "../../../../src/lib/crypto/voting/elgamal-encryption.js";
import type {
  PublicKey,
  PrivateKey,
  EncryptedData,
} from "../../../../src/lib/crypto/voting/encryption-scheme.js";

describe("ElGamalEncryption", () => {
  let scheme: ElGamalEncryption;

  beforeEach(() => {
    scheme = new ElGamalEncryption();
  });

  describe("getAlgorithmName", () => {
    it("should return 'elgamal'", () => {
      expect(scheme.getAlgorithmName()).toBe("elgamal");
    });
  });

  describe("isQuantumResistant", () => {
    it("should return false", () => {
      expect(scheme.isQuantumResistant()).toBe(false);
    });
  });

  describe("isHomomorphic", () => {
    it("should return true", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });
  });

  describe("encrypt", () => {
    it("should throw not-implemented error with valid key", async () => {
      const publicKey: PublicKey = {
        algorithm: "elgamal",
        keyMaterial: {
          p: BigInt(23),
          g: BigInt(5),
          h: BigInt(10),
        },
      };

      await expect(scheme.encrypt(1, publicKey)).rejects.toThrow(
        "ElGamal encryption not yet implemented",
      );
    });

    it("should throw for wrong algorithm", async () => {
      const publicKey: PublicKey = {
        algorithm: "rsa",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Invalid algorithm: expected elgamal, got rsa",
      );
    });

    it("should throw for invalid key structure (missing p)", async () => {
      const publicKey: PublicKey = {
        algorithm: "elgamal",
        keyMaterial: { g: BigInt(5), h: BigInt(10) },
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Invalid ElGamal public key structure",
      );
    });

    it("should throw for invalid key structure (missing g)", async () => {
      const publicKey: PublicKey = {
        algorithm: "elgamal",
        keyMaterial: { p: BigInt(23), h: BigInt(10) },
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Invalid ElGamal public key structure",
      );
    });

    it("should throw for invalid key structure (missing h)", async () => {
      const publicKey: PublicKey = {
        algorithm: "elgamal",
        keyMaterial: { p: BigInt(23), g: BigInt(5) },
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Invalid ElGamal public key structure",
      );
    });
  });

  describe("decrypt", () => {
    it("should throw not-implemented error with valid inputs", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "elgamal",
        data: { alpha: BigInt(5), beta: BigInt(10) },
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: { p: BigInt(23), g: BigInt(5), x: BigInt(7) },
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "ElGamal decryption not yet implemented",
      );
    });

    it("should throw for wrong algorithm in encrypted data", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "aes",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Invalid algorithm: expected elgamal, got aes",
      );
    });

    it("should throw for wrong algorithm in private key", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "elgamal",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "rsa",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Invalid algorithm: expected elgamal, got rsa",
      );
    });

    it("should throw for invalid private key structure", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "elgamal",
        data: { alpha: BigInt(1), beta: BigInt(1) },
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: { p: BigInt(23) }, // missing g and x
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Invalid ElGamal private key structure",
      );
    });

    it("should throw for invalid encrypted data structure", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "elgamal",
        data: {}, // missing alpha and beta
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: { p: BigInt(23), g: BigInt(5), x: BigInt(7) },
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Invalid ElGamal encrypted data structure",
      );
    });
  });

  describe("generateKeyPair", () => {
    it("should throw not-implemented error", async () => {
      await expect(scheme.generateKeyPair()).rejects.toThrow(
        "ElGamal key generation not yet implemented",
      );
    });

    it("should throw not-implemented error with params", async () => {
      await expect(
        scheme.generateKeyPair({ primeSize: 4096, safePrime: true }),
      ).rejects.toThrow("ElGamal key generation not yet implemented");
    });
  });

  describe("homomorphicAdd", () => {
    it("should throw not-implemented error", async () => {
      const e1: EncryptedData = {
        algorithm: "elgamal",
        data: { alpha: BigInt(1), beta: BigInt(1) },
      };
      const e2: EncryptedData = {
        algorithm: "elgamal",
        data: { alpha: BigInt(2), beta: BigInt(2) },
      };

      await expect(scheme.homomorphicAdd(e1, e2)).rejects.toThrow(
        "ElGamal homomorphic addition not yet implemented",
      );
    });

    it("should throw for mismatched algorithms", async () => {
      const e1: EncryptedData = {
        algorithm: "elgamal",
        data: {},
      };
      const e2: EncryptedData = {
        algorithm: "rsa",
        data: {},
      };

      await expect(scheme.homomorphicAdd(e1, e2)).rejects.toThrow(
        "Both encrypted values must use ElGamal",
      );
    });
  });
});
