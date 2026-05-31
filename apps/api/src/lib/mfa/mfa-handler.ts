/**
 * MFA Handler (AUTH-1)
 *
 * Manages MFA enrollment, verification, and backup code operations.
 * MFA is mandatory for SUPER_ADMIN and PARTNER_ADMIN roles,
 * optional for other roles.
 */

import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../env.js";
import { getLogger, Logger } from "../logger.js";
import {
  buildOTPAuthURI,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  verifyTOTP,
} from "./totp-service.js";

const MFA_REQUIRED_ROLES = ["SUPER_ADMIN", "PARTNER_ADMIN"];

export class MfaHandler {
  private logger: Logger;

  constructor(env: Env) {
    this.logger = getLogger();
  }

  /**
   * Check if MFA is required for a given role.
   */
  isMfaRequired(role?: string): boolean {
    return !!role && MFA_REQUIRED_ROLES.includes(role);
  }

  /**
   * Check if a user has MFA enrolled.
   */
  async isEnrolled(
    prisma: PrismaClient,
    userId: string,
  ): Promise<boolean> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
      select: { id: true },
    });
    return !!enrollment;
  }

  /**
   * Begin MFA enrollment: generate secret and backup codes.
   * Returns the secret URI (for QR code) and plaintext backup codes.
   * The caller must verify a TOTP code before finalizing enrollment.
   */
  async beginEnrollment(
    email: string,
  ): Promise<{
    secret: string;
    otpauthUri: string;
    backupCodes: string[];
  }> {
    const secret = generateSecret();
    const otpauthUri = buildOTPAuthURI(secret, email);
    const backupCodes = generateBackupCodes(10);

    return { secret, otpauthUri, backupCodes };
  }

  /**
   * Finalize enrollment after the user verifies a TOTP code.
   * Stores the encrypted secret and hashed backup codes.
   */
  async finalizeEnrollment(
    prisma: PrismaClient,
    userId: string,
    secret: string,
    backupCodes: string[],
    verificationCode: string,
    encryptionKey: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Verify the user can generate a valid code
    const valid = await verifyTOTP(secret, verificationCode);
    if (!valid) {
      return { success: false, error: "Invalid verification code" };
    }

    // Encrypt the secret for storage
    const encrypted = await encryptSecret(secret, encryptionKey);

    // Hash all backup codes
    const hashedCodes = await Promise.all(
      backupCodes.map((code) => hashBackupCode(code)),
    );

    // Upsert enrollment (in case of re-enrollment)
    await prisma.mfaEnrollment.upsert({
      where: { userId },
      create: {
        userId,
        encryptedSecret: encrypted,
        backupCodes: hashedCodes,
      },
      update: {
        encryptedSecret: encrypted,
        backupCodes: hashedCodes,
        lastUsedAt: null,
      },
    });

    this.logger.info("[MFA] Enrollment finalized", { userId });
    return { success: true };
  }

  /**
   * Verify a TOTP code for an enrolled user.
   */
  async verifyCode(
    prisma: PrismaClient,
    userId: string,
    code: string,
    encryptionKey: string,
  ): Promise<boolean> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
    });
    if (!enrollment) return false;

    const secret = await decryptSecret(
      enrollment.encryptedSecret,
      encryptionKey,
    );
    const valid = await verifyTOTP(secret, code);

    if (valid) {
      await prisma.mfaEnrollment.update({
        where: { userId },
        data: { lastUsedAt: new Date() },
      });
    }

    return valid;
  }

  /**
   * Verify a backup code (one-time use).
   */
  async verifyBackupCode(
    prisma: PrismaClient,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
    });
    if (!enrollment) return false;

    const codeHash = await hashBackupCode(code);
    const index = enrollment.backupCodes.indexOf(codeHash);

    if (index === -1) return false;

    // Remove used backup code
    const updatedCodes = [...enrollment.backupCodes];
    updatedCodes.splice(index, 1);

    await prisma.mfaEnrollment.update({
      where: { userId },
      data: {
        backupCodes: updatedCodes,
        lastUsedAt: new Date(),
      },
    });

    this.logger.info("[MFA] Backup code used", {
      userId,
      remainingCodes: updatedCodes.length,
    });
    return true;
  }

  /**
   * Remove MFA enrollment (for account recovery by super-admin).
   */
  async removeEnrollment(
    prisma: PrismaClient,
    userId: string,
  ): Promise<void> {
    await prisma.mfaEnrollment.deleteMany({
      where: { userId },
    });
    this.logger.info("[MFA] Enrollment removed", { userId });
  }

  /**
   * Get MFA status for a user.
   */
  async getStatus(
    prisma: PrismaClient,
    userId: string,
    role?: string,
  ): Promise<{
    enrolled: boolean;
    required: boolean;
    backupCodesRemaining?: number;
  }> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
      select: { backupCodes: true },
    });

    return {
      enrolled: !!enrollment,
      required: this.isMfaRequired(role),
      backupCodesRemaining: enrollment?.backupCodes.length,
    };
  }
}
