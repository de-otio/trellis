/**
 * reCAPTCHA verification utility
 * Verifies reCAPTCHA tokens using Google's reCAPTCHA API
 */

import { getLogger, Logger } from "./logger.js";

interface RecaptchaVerificationResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  score?: number; // For v3
  action?: string; // For v3
}

/**
 * Verify reCAPTCHA token with Google's API
 * @param token - The reCAPTCHA token from the frontend
 * @param secretKey - The reCAPTCHA secret key
 * @returns Promise<boolean> - true if verification succeeds, false otherwise
 */
export async function verifyRecaptcha(
  token: string,
  secretKey: string,
): Promise<{ valid: boolean; error?: string; score?: number }> {
  if (!token) {
    return { valid: false, error: "reCAPTCHA token is required" };
  }

  if (!secretKey) {
    return { valid: false, error: "reCAPTCHA secret key is not configured" };
  }

  try {
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: secretKey,
          response: token,
        }),
      },
    );

    if (!response.ok) {
      getLogger().error(
        `[Recaptcha] Google API error: ${response.status} ${response.statusText}`,
      );
      return { valid: false, error: "Failed to verify reCAPTCHA with Google" };
    }

    const data: RecaptchaVerificationResponse = await response.json();

    if (!data.success) {
      const errorCodes = data["error-codes"] || [];
      getLogger().error(
        `[Recaptcha] Verification failed: ${errorCodes.join(", ")}`,
      );
      return {
        valid: false,
        error: `reCAPTCHA verification failed: ${errorCodes.join(", ")}`,
      };
    }

    // For reCAPTCHA v3, check score (0.0 to 1.0, higher is better)
    // Typically, scores above 0.5 are considered legitimate users
    if (data.score !== undefined) {
      const minScore = 0.5;
      if (data.score < minScore) {
        getLogger().warn(
          `[Recaptcha] Low score: ${data.score}, action: ${data.action}`,
        );
        return {
          valid: false,
          error: "reCAPTCHA score too low (possible bot activity)",
          score: data.score,
        };
      }
      return { valid: true, score: data.score };
    }

    // For reCAPTCHA v2, success is sufficient
    return { valid: true };
  } catch (error: any) {
    getLogger().error("[Recaptcha] Verification error:", error);
    return {
      valid: false,
      error: error.message || "Failed to verify reCAPTCHA",
    };
  }
}
