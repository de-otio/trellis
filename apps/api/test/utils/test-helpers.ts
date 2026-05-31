/**
 * Test Helpers
 *
 * Common utilities for testing
 */

import type { Request as CFRequest } from "@cloudflare/workers-types";
import type { MockEnv } from "./mock-env.js";

/**
 * Create a mock Request object
 * Uses global Request (available in Node.js test environment)
 */
export function createMockRequest(
  url: string,
  options: {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
  } = {},
): any {
  const { method = "GET", headers = {}, body } = options;

  // Use global Request constructor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RequestConstructor = globalThis.Request as any;
  return new RequestConstructor(url, {
    method,
    headers,
    body: body || undefined,
  });
}

/**
 * Extract cookies from Set-Cookie header
 */
export function parseSetCookie(
  setCookieHeader: string | null,
): Record<string, string> {
  if (!setCookieHeader) return {};

  const cookies: Record<string, string> = {};
  const parts = setCookieHeader.split(",");

  for (const part of parts) {
    const [nameValue] = part.split(";");
    const [name, value] = nameValue.split("=").map((s) => s.trim());
    if (name && value) {
      cookies[name] = value;
    }
  }

  return cookies;
}

/**
 * Create a request with session cookie
 */
export function createAuthenticatedRequest(
  url: string,
  sessionToken: string,
  options: { method?: string; body?: BodyInit } = {},
): any {
  return createMockRequest(url, {
    ...options,
    headers: {
      Cookie: `session=${sessionToken}`,
    },
  });
}

/**
 * Wait for async operation (useful for testing timeouts)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mock crypto for testing (if needed)
 */
export function createMockCrypto(): Crypto {
  return {
    ...crypto,
    randomUUID: () => "mock-uuid-" + Math.random().toString(36).substring(7),
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      // Fill with mock random values
      const view = new Uint8Array(array.buffer);
      for (let i = 0; i < view.length; i++) {
        view[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
  } as Crypto;
}

/**
 * Assert response has security headers
 */
export function assertSecurityHeaders(response: Response): void {
  const headers = response.headers;

  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(headers.get("X-Frame-Options")).toBe("DENY");
  expect(headers.get("X-XSS-Protection")).toBe("1; mode=block");
  expect(headers.get("Referrer-Policy")).not.toBeNull();
}

/**
 * Assert response has CORS headers
 */
export function assertCORSHeaders(response: Response, origin?: string): void {
  const headers = response.headers;

  expect(headers.get("Access-Control-Allow-Origin")).toBe(
    origin || "https://test.example.com",
  );
  expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
}
