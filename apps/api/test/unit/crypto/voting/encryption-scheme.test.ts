/**
 * Unit tests for EncryptionScheme interface and implementations
 *
 * Tests the modular cryptographic architecture for Secure Voting System.
 */

import { beforeEach, describe, it, expect } from "vitest";
import {
  ElGamalEncryption,
  PostQuantumEncryption,
  HybridEncryption,
} from "../../../../src/lib/crypto/voting/index.js";
import type {
  EncryptionScheme,
  PublicKey,
  PrivateKey,
  EncryptedData,
} from "../../../../src/lib/crypto/voting/encryption-scheme.js";

describe("EncryptionScheme Interface", () => {
  describe("ElGamalEncryption", () => {
    let scheme: EncryptionScheme;

    beforeEach(() => {
      scheme = new ElGamalEncryption();
    });

    it("should implement EncryptionScheme interface", () => {
      expect(scheme).toBeDefined();
      expect(typeof scheme.encrypt).toBe("function");
      expect(typeof scheme.decrypt).toBe("function");
      expect(typeof scheme.isQuantumResistant).toBe("function");
      expect(typeof scheme.getAlgorithmName).toBe("function");
      expect(typeof scheme.isHomomorphic).toBe("function");
    });

    it("should return correct algorithm name", () => {
      expect(scheme.getAlgorithmName()).toBe("elgamal");
    });

    it("should indicate it is not quantum-resistant", () => {
      expect(scheme.isQuantumResistant()).toBe(false);
    });

    it("should indicate it supports homomorphic operations", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });

    it("should have homomorphicAdd method", () => {
      expect(typeof scheme.homomorphicAdd).toBe("function");
    });

    it("should have generateKeyPair method", () => {
      expect(typeof scheme.generateKeyPair).toBe("function");
    });

    it("should throw error when encrypting (not yet implemented)", async () => {
      const publicKey: PublicKey = {
        algorithm: "elgamal",
        keyMaterial: {
          p: BigInt(23), // Valid prime
          g: BigInt(5), // Valid generator
          h: BigInt(10), // Valid public key
        },
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "ElGamal encryption not yet implemented",
      );
    });

    it("should throw error when decrypting (not yet implemented)", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "elgamal",
        data: {
          alpha: BigInt(5), // Valid encrypted component
          beta: BigInt(10), // Valid encrypted component
        },
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: {
          p: BigInt(23), // Valid prime
          g: BigInt(5), // Valid generator
          x: BigInt(7), // Valid private key
        },
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "ElGamal decryption not yet implemented",
      );
    });

    it("should throw error for wrong algorithm in encrypt", async () => {
      const publicKey: PublicKey = {
        algorithm: "wrong-algorithm",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Invalid algorithm",
      );
    });

    it("should throw error for wrong algorithm in decrypt", async () => {
      const encryptedData: EncryptedData = {
        algorithm: "wrong-algorithm",
        data: {},
      };
      const privateKey: PrivateKey = {
        algorithm: "elgamal",
        keyMaterial: {},
      };

      await expect(scheme.decrypt(encryptedData, privateKey)).rejects.toThrow(
        "Invalid algorithm",
      );
    });
  });

  describe("PostQuantumEncryption", () => {
    let scheme: EncryptionScheme;

    beforeEach(() => {
      scheme = new PostQuantumEncryption();
    });

    it("should implement EncryptionScheme interface", () => {
      expect(scheme).toBeDefined();
      expect(typeof scheme.encrypt).toBe("function");
      expect(typeof scheme.decrypt).toBe("function");
      expect(typeof scheme.isQuantumResistant).toBe("function");
      expect(typeof scheme.getAlgorithmName).toBe("function");
      expect(typeof scheme.isHomomorphic).toBe("function");
    });

    it("should return correct algorithm name", () => {
      expect(scheme.getAlgorithmName()).toBe("post-quantum-homomorphic");
    });

    it("should indicate it is quantum-resistant", () => {
      expect(scheme.isQuantumResistant()).toBe(true);
    });

    it("should indicate it supports homomorphic operations", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });

    it("should throw error when encrypting (not yet implemented)", async () => {
      const publicKey: PublicKey = {
        algorithm: "post-quantum-homomorphic",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Post-quantum encryption not yet implemented",
      );
    });

    it("should throw error when decrypting (not yet implemented)", async () => {
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
  });

  describe("HybridEncryption", () => {
    let scheme: EncryptionScheme;

    beforeEach(() => {
      scheme = new HybridEncryption();
    });

    it("should implement EncryptionScheme interface", () => {
      expect(scheme).toBeDefined();
      expect(typeof scheme.encrypt).toBe("function");
      expect(typeof scheme.decrypt).toBe("function");
      expect(typeof scheme.isQuantumResistant).toBe("function");
      expect(typeof scheme.getAlgorithmName).toBe("function");
      expect(typeof scheme.isHomomorphic).toBe("function");
    });

    it("should return correct algorithm name", () => {
      expect(scheme.getAlgorithmName()).toBe("hybrid");
    });

    it("should indicate it is quantum-resistant", () => {
      expect(scheme.isQuantumResistant()).toBe(true);
    });

    it("should indicate it supports homomorphic operations", () => {
      expect(scheme.isHomomorphic()).toBe(true);
    });

    it("should throw error when encrypting (not yet implemented)", async () => {
      const publicKey: PublicKey = {
        algorithm: "hybrid",
        keyMaterial: {},
      };

      await expect(scheme.encrypt(0, publicKey)).rejects.toThrow(
        "Hybrid encryption not yet implemented",
      );
    });

    it("should throw error when decrypting (not yet implemented)", async () => {
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

  describe("Algorithm Swapping", () => {
    it("should allow swapping between encryption schemes", () => {
      const elGamal = new ElGamalEncryption();
      const postQuantum = new PostQuantumEncryption();

      // Both implement the same interface
      expect(elGamal.getAlgorithmName()).toBe("elgamal");
      expect(postQuantum.getAlgorithmName()).toBe("post-quantum-homomorphic");

      // Can check quantum resistance
      expect(elGamal.isQuantumResistant()).toBe(false);
      expect(postQuantum.isQuantumResistant()).toBe(true);

      // Both support homomorphic operations
      expect(elGamal.isHomomorphic()).toBe(true);
      expect(postQuantum.isHomomorphic()).toBe(true);
    });

    it("should allow using scheme polymorphically", () => {
      const schemes: EncryptionScheme[] = [
        new ElGamalEncryption(),
        new PostQuantumEncryption(),
        new HybridEncryption(),
      ];

      schemes.forEach((scheme) => {
        expect(scheme.getAlgorithmName()).toBeDefined();
        expect(typeof scheme.isQuantumResistant()).toBe("boolean");
        expect(typeof scheme.isHomomorphic()).toBe("boolean");
      });
    });
  });
});
