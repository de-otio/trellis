/**
 * ActivityPub Cryptographic Key Management
 *
 * Handles RSA key pair generation and encryption for ActivityPub actors.
 * Private keys are encrypted at rest for security.
 */

import * as crypto from "crypto";
import type { Env } from "../../env.js";

/**
 * Service for managing cryptographic keys for ActivityPub actors
 */
export class KeyPairService {
  /**
   * Generate RSA key pair for ActivityPub actor
   * Uses 2048-bit keys as per ActivityPub best practices
   */
  static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
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

    return { publicKey, privateKey };
  }

  /**
   * Encrypt private key for storage using AES-256-GCM
   *
   * @param privateKey - Private key in PEM format
   * @param env - Environment object containing encryption key
   * @returns Encrypted private key (base64 encoded)
   */
  static encryptPrivateKey(privateKey: string, env: Env): string {
    const encryptionKey = this.getEncryptionKey(env);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);

    let encrypted = cipher.update(privateKey, "utf8", "base64");
    encrypted += cipher.final("base64");

    const authTag = cipher.getAuthTag();

    // Combine IV, auth tag, and encrypted data
    const combined = {
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      encrypted,
    };

    return JSON.stringify(combined);
  }

  /**
   * Decrypt private key from storage
   *
   * @param encryptedKey - Encrypted private key (JSON string with iv, authTag, encrypted)
   * @param env - Environment object containing encryption key
   * @returns Decrypted private key in PEM format
   */
  static decryptPrivateKey(encryptedKey: string, env: Env): string {
    const encryptionKey = this.getEncryptionKey(env);
    const combined = JSON.parse(encryptedKey);

    const iv = Buffer.from(combined.iv, "base64");
    const authTag = Buffer.from(combined.authTag, "base64");
    const encrypted = combined.encrypted;

    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Get encryption key from environment
   * Falls back to SESSION_SECRET if ACTIVITYPUB_KEY_ENCRYPTION_KEY is not set
   */
  private static getEncryptionKey(env: Env): Buffer {
    // Try to get dedicated encryption key for ActivityPub
    const activityPubKey = (env as any).ACTIVITYPUB_KEY_ENCRYPTION_KEY;
    if (activityPubKey && typeof activityPubKey === "string") {
      // Derive 32-byte key from the provided key using SHA-256
      return crypto.createHash("sha256").update(activityPubKey).digest();
    }

    // Fall back to session secret (which is already 32+ bytes)
    const sessionSecret = env.SESSION_SECRET;
    if (!sessionSecret) {
      throw new Error(
        "No encryption key available. Set ACTIVITYPUB_KEY_ENCRYPTION_KEY or SESSION_SECRET",
      );
    }

    // Derive 32-byte key from session secret
    return crypto.createHash("sha256").update(sessionSecret).digest();
  }
}
