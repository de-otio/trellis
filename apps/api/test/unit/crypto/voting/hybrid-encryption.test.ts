/**
 * Unit Tests: Hybrid Encryption
 *
 * Tests the hybrid encryption scheme that combines classical (ElGamal)
 * and post-quantum encryption for quantum-resistant vote encryption.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { HybridEncryption } from "../../../../src/lib/crypto/voting/hybrid-encryption.js";
import type {
  PublicKey,
  PrivateKey,
  EncryptedData,
} from "../../../../src/lib/crypto/voting/encryption-scheme.js";

describe("HybridEncryption", () => {
  let scheme: HybridEncryption;

  beforeEach(() => {
    scheme = new HybridEncryption();
  });

  describe("getAlgorithmName", () => {
    it("should return 'hybrid'", () => {
      expect(scheme.getAlgorithmName()).toBe("hybrid");
    });
  });

  describe("isQuantumResistant", () => {
    it("should return true", () => {
      expect(scheme.isQuantumResistant()).toBe(true);
    });
  });

  describe("isHomomorphic", () => {
    it("should return true when both sub-schemes are homomorphic", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });
  });

  describe("encrypt", () => {
    it("should throw not-implemented error", async () => {
      const publicKey: PublicKey = {
        algorithm: "hybrid",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(1, publicKey)).rejects.toThrow(
        "Hybrid encryption not yet implemented",
      );
    });
  });

  describe("decrypt", () => {
    it("should throw not-implemented error", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "hybrid",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "hybrid",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Hybrid decryption not yet implemented",
      );
    });
  });

  describe("homomorphicAdd", () => {
    it("should throw not-implemented error", async () => {
      const e1: EncryptedData = {
        algorithm: "hybrid",
        data: {},
      };
      const e2: EncryptedData = {
        algorithm: "hybrid",
        data: {},
      };

      await expect(scheme.homomorphicAdd(e1, e2)).rejects.toThrow(
        "Hybrid homomorphic addition not yet implemented",
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
  });
});
