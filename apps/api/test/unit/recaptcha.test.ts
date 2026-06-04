/**
 * Unit Tests: reCAPTCHA
 *
 * Tests for reCAPTCHA token verification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRecaptcha } from "../../src/lib/recaptcha.js";

describe("verifyRecaptcha", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("should return false when token is missing", async () => {
    const result = await verifyRecaptcha("", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("reCAPTCHA token is required");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should return false when secret key is missing", async () => {
    const result = await verifyRecaptcha("token", "");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("reCAPTCHA secret key is not configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should verify reCAPTCHA v2 successfully", async () => {
    const mockResponse = {
      success: true,
      challenge_ts: "2024-01-01T00:00:00Z",
      hostname: "example.com",
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://www.google.com/recaptcha/api/siteverify",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: expect.any(URLSearchParams),
      }),
    );
  });

  it("should verify reCAPTCHA v3 with high score", async () => {
    const mockResponse = {
      success: true,
      score: 0.9,
      action: "submit",
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(true);
    expect(result.score).toBe(0.9);
  });

  it("should reject reCAPTCHA v3 with low score", async () => {
    const mockResponse = {
      success: true,
      score: 0.3,
      action: "submit",
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      "reCAPTCHA score too low (possible bot activity)",
    );
    expect(result.score).toBe(0.3);
  });

  it("should accept reCAPTCHA v3 with score exactly at threshold", async () => {
    const mockResponse = {
      success: true,
      score: 0.5,
      action: "submit",
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(true);
    expect(result.score).toBe(0.5);
  });

  it("should return false when Google API returns success: false", async () => {
    const mockResponse = {
      success: false,
      "error-codes": ["invalid-input-response", "timeout-or-duplicate"],
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("reCAPTCHA verification failed");
    expect(result.error).toContain("invalid-input-response");
  });

  it("should return false when Google API returns HTTP error", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Failed to verify reCAPTCHA with Google");
  });

  it("should handle network errors gracefully", async () => {
    (global.fetch as any).mockRejectedValue(new Error("Network error"));

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Network error");
  });

  it("should handle JSON parsing errors", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JSON");
  });

  it("should send correct parameters to Google API", async () => {
    const mockResponse = { success: true };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    await verifyRecaptcha("test-token", "test-secret");

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = fetchCall[1].body as URLSearchParams;

    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("test-token");
  });

  it("should handle error codes array", async () => {
    const mockResponse = {
      success: false,
      "error-codes": ["missing-input-secret", "invalid-input-secret"],
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("missing-input-secret");
    expect(result.error).toContain("invalid-input-secret");
  });

  it("should handle missing error codes", async () => {
    const mockResponse = {
      success: false,
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("reCAPTCHA verification failed");
  });

  it("should handle reCAPTCHA v3 with score but no action", async () => {
    const mockResponse = {
      success: true,
      score: 0.8,
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await verifyRecaptcha("token", "secret-key");

    expect(result.valid).toBe(true);
    expect(result.score).toBe(0.8);
  });
});
