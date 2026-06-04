/**
 * Hash Utilities for Secure Voting
 *
 * SHA-256 helpers for verification codes, election records, proof
 * challenges (Fiat-Shamir), and device-info tracking. ElGamal stays
 * separate (homomorphic requirement).
 */

import { createHash } from "node:crypto";

function sha256Hex(data: string | object): string {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function hashVerificationCode(
  data: string | object,
): Promise<string> {
  return sha256Hex(data);
}

export async function hashElectionRecord(
  electionRecord: string | object,
): Promise<string> {
  return sha256Hex(electionRecord);
}

export async function generateFiatShamirChallenge(
  transcript: string | object,
): Promise<string> {
  return sha256Hex(transcript);
}

export async function hashDeviceInfo(deviceInfo: object): Promise<string> {
  return sha256Hex(deviceInfo);
}
