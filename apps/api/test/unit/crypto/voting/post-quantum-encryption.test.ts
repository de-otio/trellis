/**
 * Unit Tests: Post-Quantum Encryption
 *
 * Tests the post-quantum encryption stub/placeholder implementation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PostQuantumEncryption } from "../../../../src/lib/crypto/voting/post-quantum-encryption.js";
import type {
  PublicKey,
  PrivateKey,
  EncryptedData,
} from "../../../../src/lib/crypto/voting/encryption-scheme.js";

describe("PostQuantumEncryption", () => {
  let scheme: PostQuantumEncryption;

  beforeEach(() => {
    scheme = new PostQuantumEncryption();
  });

  describe("getAlgorithmName", () => {
    it("should return 'post-quantum-homomorphic'", () => {
      expect(scheme.getAlgorithmName()).toBe("post-quantum-homomorphic");
    });
  });

  describe("isQuantumResistant", () => {
    it("should return true", () => {
      expect(scheme.isQuantumResistant()).toBe(true);
    });
  });

  describe("isHomomorphic", () => {
    it("should return true", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });
  });

  describe("encrypt", () => {
    it("should throw not-implemented error", async () => {
      const publicKey: PublicKey = {
        algorithm: "post-quantum-homomorphic",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(1, publicKey)).rejects.toThrow(
        "Post-quantum encryption not yet implemented",
      );
    });

    it("should mention research phase in error message", async () => {
      const publicKey: PublicKey = {
        algorithm: "post-quantum-homomorphic",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "still in research phase",
      );
    });
  });

  describe("decrypt", () => {
    it("should throw not-implemented error", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "post-quantum-homomorphic",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "post-quantum-homomorphic",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Post-quantum decryption not yet implemented",
      );
    });

    it("should mention research phase in error message", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "post-quantum-homomorphic",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "post-quantum-homomorphic",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "still in research phase",
      );
    });
  });

  describe("homomorphicAdd", () => {
    it("should throw not-implemented error", async () => {
      const e1: EncryptedData = {
        algorithm: "post-quantum-homomorphic",
        data: {},
      };
      const e2: EncryptedData = {
        algorithm: "post-quantum-homomorphic",
        data: {},
      };

      await expect(scheme.homomorphicAdd(e1, e2)).rejects.toThrow(
        "Post-quantum homomorphic addition not yet implemented",
      );
    });
  });

  describe("interface compliance", () => {
    it("should implement all required EncryptionScheme methods", () => {
      expect(typeof scheme.encrypt).toBe("function");
      expect(typeof scheme.decrypt).toBe("function");
      expect(typeof scheme.isQuantumResistant).toBe("function");
      expect(typeof scheme.getAlgorithmName).toBe("function");
      expect(typeof scheme.isHomomorphic).toBe("function");
      expect(typeof scheme.homomorphicAdd).toBe("function");
    });

    it("should be usable as EncryptionScheme type", () => {
      // Verify the scheme can be assigned to EncryptionScheme
      const asScheme: {
        encrypt: Function;
        decrypt: Function;
        isQuantumResistant: () => boolean;
        getAlgorithmName: () => string;
        isHomomorphic: () => boolean;
      } = scheme;
      expect(asScheme.getAlgorithmName()).toBe("post-quantum-homomorphic");
    });
  });
});
