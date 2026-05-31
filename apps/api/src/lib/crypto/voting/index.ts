/**
 * Voting Cryptographic Module
 *
 * Exports encryption schemes for Secure Voting System.
 * Provides modular architecture for algorithm swapping and post-quantum migration.
 *
 * Part of: Cryptographic Design Comparison
 * Status: Module Exports
 * Last Updated: January 2025
 */

export type {
  EncryptionScheme,
  PublicKey,
  PrivateKey,
  EncryptedData,
} from "./encryption-scheme.js";

export { ElGamalEncryption } from "./elgamal-encryption.js";
export type {
  ElGamalPublicKey,
  ElGamalPrivateKey,
  ElGamalEncryptedData,
  ElGamalParams,
} from "./elgamal-encryption.js";

export { PostQuantumEncryption } from "./post-quantum-encryption.js";

export { HybridEncryption } from "./hybrid-encryption.js";
export type { HybridEncryptedData } from "./hybrid-encryption.js";

// Hash utilities using shared cryptographic library
// Note: Hash functions use @de-otio/trellis (inlined crypto). ElGamal encryption remains separate (homomorphic requirement).
export {
  hashVerificationCode,
  hashElectionRecord,
  generateFiatShamirChallenge,
  hashDeviceInfo,
} from "./hash-utils.js";
