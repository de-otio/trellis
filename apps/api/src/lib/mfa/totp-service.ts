/**
 * TOTP Service (AUTH-1)
 *
 * Implements RFC 6238 TOTP generation and verification using Web Crypto API.
 * No external dependencies — uses only the Web Crypto API available in
 * Cloudflare Workers and modern runtimes.
 */

const TOTP_PERIOD = 30; // seconds
const TOTP_DIGITS = 6;
const SECRET_LENGTH = 20; // bytes (160-bit, standard for TOTP)

/**
 * Generate a random TOTP secret (base32-encoded).
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  return base32Encode(bytes);
}

/**
 * Generate a TOTP code for a given secret and time.
 */
export async function generateTOTP(
  secret: string,
  time?: number,
): Promise<string> {
  const now = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / TOTP_PERIOD);
  return hmacBasedOTP(secret, counter);
}

/**
 * Verify a TOTP code against a secret and return the time-step it matched.
 *
 * Allows a window of ±1 period to account for clock skew. Returns the RFC 6238
 * counter (`floor(unixSeconds / 30)`) the code was generated for, or `null`
 * when nothing in the window matches. Callers that persist the returned step
 * and refuse anything at or below it get replay protection for free: a code
 * observed once cannot be presented a second time inside its own window.
 */
export async function verifyTOTPStep(
  secret: string,
  code: string,
  window: number = 1,
): Promise<number | null> {
  if (!code || code.length !== TOTP_DIGITS) return null;

  const now = Math.floor(Date.now() / 1000);
  const currentCounter = Math.floor(now / TOTP_PERIOD);

  for (let i = -window; i <= window; i++) {
    const step = currentCounter + i;
    const expected = await hmacBasedOTP(secret, step);
    if (constantTimeEqual(code, expected)) {
      return step;
    }
  }

  return null;
}

/**
 * Verify a TOTP code against a secret.
 * Allows a window of ±1 period to account for clock skew.
 *
 * Boolean form of {@link verifyTOTPStep}; it cannot detect a replay on its
 * own, so anything that gates access on the result should use the step form
 * and persist the accepted step.
 */
export async function verifyTOTP(
  secret: string,
  code: string,
  window: number = 1,
): Promise<boolean> {
  return (await verifyTOTPStep(secret, code, window)) !== null;
}

/**
 * Build an otpauth:// URI for QR code generation.
 */
export function buildOTPAuthURI(
  secret: string,
  email: string,
  issuer: string = "Trellis",
): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedEmail = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/**
 * Generate backup codes (10 codes, 8 alphanumeric chars each).
 */
export function generateBackupCodes(count: number = 10): string[] {
  const codes: string[] = [];
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous I/O/0/1
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let code = "";
    for (const b of bytes) {
      code += chars[b % chars.length];
    }
    // Format as XXXX-XXXX for readability
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/**
 * Hash a backup code for storage using SHA-256.
 *
 * @deprecated LEGACY — unsalted SHA-256 of a 40-bit code is recoverable
 * offline by anyone who can read the table (DP-8). Kept only so rows written
 * before `lib/at-rest-secret.ts` still match; new hashes come from
 * `hashBackupCodeKeyed`.
 */
export async function hashBackupCode(code: string): Promise<string> {
  const normalized = code.replace(/-/g, "").toUpperCase();
  const encoded = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return arrayToHex(new Uint8Array(hash));
}

/**
 * Encrypt a TOTP secret for database storage using AES-GCM.
 *
 * @deprecated LEGACY — keys off the first 32 CHARACTERS of the supplied
 * secret (no KDF, no domain separation, no rotation tag; DP-3). Nothing in
 * the API writes this format any more; `lib/at-rest-secret.ts` `sealSecret`
 * replaces it. Kept exported so tests can produce legacy rows.
 */
export async function encryptSecret(
  secret: string,
  encryptionKey: string,
): Promise<string> {
  const keyData = new TextEncoder().encode(encryptionKey.padEnd(32, "0").slice(0, 32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a TOTP secret from database storage.
 *
 * @deprecated LEGACY read path for rows written by `encryptSecret`; called
 * only from `lib/at-rest-secret.ts` `openSecret`, which re-seals on use.
 */
export async function decryptSecret(
  encryptedSecret: string,
  encryptionKey: string,
): Promise<string> {
  const keyData = new TextEncoder().encode(encryptionKey.padEnd(32, "0").slice(0, 32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const combined = Uint8Array.from(atob(encryptedSecret), (c) =>
    c.charCodeAt(0),
  );
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// --- Internal helpers ---

async function hmacBasedOTP(
  base32Secret: string,
  counter: number,
): Promise<string> {
  const secretBytes = base32Decode(base32Secret);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  // Counter as 8-byte big-endian
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(4, counter, false); // low 32 bits

  const hmac = await crypto.subtle.sign("HMAC", key, counterBytes);
  const hmacBytes = new Uint8Array(hmac);

  // Dynamic truncation (RFC 4226)
  const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
  const code =
    ((hmacBytes[offset] & 0x7f) << 24) |
    ((hmacBytes[offset + 1] & 0xff) << 16) |
    ((hmacBytes[offset + 2] & 0xff) << 8) |
    (hmacBytes[offset + 3] & 0xff);

  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Base32 encoding/decoding (RFC 4648)
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/=+$/, "").toUpperCase();
  const output: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

function arrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
