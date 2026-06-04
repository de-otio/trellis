/**
 * EncryptionScheme Interface
 *
 * Abstract interface for encryption schemes used in Secure Voting System.
 * This interface enables algorithm swapping and post-quantum migration.
 *
 * Part of: Cryptographic Design Comparison
 * Status: Interface Definition
 * Last Updated: January 2025
 */

/**
 * Public key for encryption schemes
 * Format depends on the specific algorithm
 */
export interface PublicKey {
  /**
   * Algorithm identifier (e.g., 'elgamal', 'kyber', 'ntru')
   */
  algorithm: string;

  /**
   * Key material (format depends on algorithm)
   * For ElGamal: { p: bigint, g: bigint, h: bigint }
   * For post-quantum KEM: byte array
   */
  keyMaterial: unknown;

  /**
   * Key version for parameter versioning
   */
  version?: string;
}

/**
 * Private key for encryption schemes
 * Format depends on the specific algorithm
 */
export interface PrivateKey {
  /**
   * Algorithm identifier (e.g., 'elgamal', 'kyber', 'ntru')
   */
  algorithm: string;

  /**
   * Key material (format depends on algorithm)
   * For ElGamal: { p: bigint, g: bigint, x: bigint }
   * For post-quantum KEM: byte array
   */
  keyMaterial: unknown;

  /**
   * Key version for parameter versioning
   */
  version?: string;
}

/**
 * Encrypted data structure
 * Format depends on the specific algorithm
 */
export interface EncryptedData {
  /**
   * Algorithm identifier
   */
  algorithm: string;

  /**
   * Encrypted data (format depends on algorithm)
   * For ElGamal: { alpha: bigint, beta: bigint }
   * For post-quantum KEM: { ciphertext: Uint8Array, sharedSecret: Uint8Array }
   */
  data: unknown;

  /**
   * Encryption version for parameter versioning
   */
  version?: string;
}

/**
 * Abstract interface for encryption schemes
 *
 * This interface enables:
 * - Algorithm swapping (ElGamal → post-quantum)
 * - Hybrid schemes (dual encryption)
 * - Backward compatibility
 * - Post-quantum migration
 */
export interface EncryptionScheme {
  /**
   * Encrypt data using public key
   *
   * @param data - Data to encrypt (format depends on algorithm)
   * @param publicKey - Public key for encryption
   * @returns Encrypted data
   * @throws Error if encryption fails
   */
  encrypt(data: unknown, publicKey: PublicKey): Promise<EncryptedData>;

  /**
   * Decrypt data using private key
   *
   * @param encryptedData - Encrypted data to decrypt
   * @param privateKey - Private key for decryption
   * @returns Decrypted data
   * @throws Error if decryption fails
   */
  decrypt(
    encryptedData: EncryptedData,
    privateKey: PrivateKey,
  ): Promise<unknown>;

  /**
   * Check if this encryption scheme is quantum-resistant
   *
   * @returns true if quantum-resistant, false otherwise
   */
  isQuantumResistant(): boolean;

  /**
   * Get the algorithm name
   *
   * @returns Algorithm identifier (e.g., 'elgamal', 'kyber', 'ntru')
   */
  getAlgorithmName(): string;

  /**
   * Check if this scheme supports homomorphic operations
   *
   * @returns true if homomorphic, false otherwise
   */
  isHomomorphic(): boolean;

  /**
   * Perform homomorphic addition (if supported)
   *
   * @param encrypted1 - First encrypted value
   * @param encrypted2 - Second encrypted value
   * @returns Sum of encrypted values (encrypted)
   * @throws Error if homomorphic operations not supported
   */
  homomorphicAdd?(
    encrypted1: EncryptedData,
    encrypted2: EncryptedData,
  ): Promise<EncryptedData>;

  /**
   * Generate key pair
   *
   * @param params - Key generation parameters (algorithm-specific)
   * @returns Public and private key pair
   * @throws Error if key generation fails
   */
  generateKeyPair?(
    params?: unknown,
  ): Promise<{ publicKey: PublicKey; privateKey: PrivateKey }>;
}
