/**
 * MFA Handler (AUTH-1)
 *
 * Manages MFA enrollment, verification, and backup code operations.
 * MFA is mandatory for SUPER_ADMIN and PARTNER_ADMIN roles,
 * optional for other roles.
 */

import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../env.js";
import {
  hashBackupCodeKeyed,
  matchBackupCode,
  needsReseal,
  openSecret,
  sealSecret,
  type Keyring,
} from "../at-rest-secret.js";
import { getLogger, Logger } from "../logger.js";
import {
  buildOTPAuthURI,
  generateBackupCodes,
  generateSecret,
  verifyTOTPStep,
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
    keyring: Keyring,
  ): Promise<{ success: boolean; error?: string }> {
    // Verify the user can generate a valid code. The matched step is
    // persisted so the enrollment code itself cannot be replayed as the
    // first verification.
    const step = await verifyTOTPStep(secret, verificationCode);
    if (step === null) {
      return { success: false, error: "Invalid verification code" };
    }

    // Seal the secret for storage under the MFA keyring (DP-3)
    const encrypted = await sealSecret(secret, keyring);

    // Keyed-hash all backup codes (DP-8)
    const hashedCodes = backupCodes.map((code) =>
      hashBackupCodeKeyed(code, keyring),
    );

    // Upsert enrollment (in case of re-enrollment)
    await prisma.mfaEnrollment.upsert({
      where: { userId },
      create: {
        userId,
        encryptedSecret: encrypted,
        backupCodes: hashedCodes,
        lastUsedStep: step,
      },
      update: {
        encryptedSecret: encrypted,
        backupCodes: hashedCodes,
        lastUsedAt: null,
        lastUsedStep: step,
      },
    });

    this.logger.info("[MFA] Enrollment finalized", { userId });
    return { success: true };
  }

  /**
   * Verify a TOTP code for an enrolled user.
   *
   * A code is accepted only if it verifies AND its time-step is above the
   * highest step already accepted for this enrollment. RFC 6238 §5.2: "the
   * verifier MUST NOT accept the second attempt of the OTP after the
   * successful validation has been issued for the first OTP". Without this a
   * code observed once (shoulder-surfed, relayed through a phishing page)
   * stayed valid for the whole ±1-step window.
   */
  async verifyCode(
    prisma: PrismaClient,
    userId: string,
    code: string,
    keyring: Keyring,
  ): Promise<boolean> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
    });
    if (!enrollment) return false;

    const secret = await openSecret(enrollment.encryptedSecret, keyring);
    const step = await verifyTOTPStep(secret, code);
    if (step === null) return false;

    const lastUsedStep = enrollment.lastUsedStep ?? null;
    if (lastUsedStep !== null && step <= lastUsedStep) {
      this.logger.warn("[MFA] Replayed TOTP code refused", {
        userId,
        step,
        lastUsedStep,
      });
      return false;
    }

    // A successful open is the one moment the plaintext is in hand: if the
    // row is in an older format (legacy raw-key wrap, or sealed under the
    // previous session secret), re-seal it so the migration completes on use.
    const reseal = needsReseal(enrollment.encryptedSecret, keyring)
      ? { encryptedSecret: await sealSecret(secret, keyring) }
      : {};

    await prisma.mfaEnrollment.update({
      where: { userId },
      data: { lastUsedAt: new Date(), lastUsedStep: step, ...reseal },
    });

    return true;
  }

  /**
   * Verify a backup code (one-time use).
   */
  async verifyBackupCode(
    prisma: PrismaClient,
    userId: string,
    code: string,
    keyring: Keyring,
  ): Promise<boolean> {
    const enrollment = await prisma.mfaEnrollment.findUnique({
      where: { userId },
    });
    if (!enrollment) return false;

    // Keyed hash first, then the legacy unsalted hash for rows written
    // before DP-8. The matched code is consumed either way.
    const index = await matchBackupCode(code, enrollment.backupCodes, keyring);

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
