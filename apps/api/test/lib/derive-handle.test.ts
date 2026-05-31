import { describe, expect, it, vi } from "vitest";
import {
  deriveHandle,
  normalizeHandleBase,
} from "../../src/lib/user/derive-handle.js";

describe("normalizeHandleBase", () => {
  it.each([
    ["alice@example.com", "alice"],
    ["alice.smith+work@example.com", "alicesmithwork"],
    ["Alice@example.com", "alice"],
    ["A_BC-123@example.com", "a_bc-123"],
    ["", ""],
    ["   ", ""],
    ["no-at-sign-just-local", "no-at-sign-just-local"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeHandleBase(input)).toBe(expected);
  });

  it("returns empty string for null/undefined input", () => {
    expect(normalizeHandleBase(null)).toBe("");
    expect(normalizeHandleBase(undefined)).toBe("");
  });

  it("strips emoji and unicode punctuation", () => {
    expect(normalizeHandleBase("alice🐕@example.com")).toBe("alice");
    expect(normalizeHandleBase("ali·ce@example.com")).toBe("alice");
  });

  it("truncates a very long local-part to the base ceiling", () => {
    const longLocal = "a".repeat(50) + "@example.com";
    const result = normalizeHandleBase(longLocal);
    expect(result.length).toBe(24);
    expect(result).toBe("a".repeat(24));
  });
});

describe("deriveHandle", () => {
  it("returns the normalised handle when no collision", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const handle = await deriveHandle("alice@example.com", exists);
    expect(handle).toBe("alice");
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith("alice");
  });

  it("returns the cleaned handle for emails with special chars", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    expect(await deriveHandle("alice.smith+work@example.com", exists)).toBe("alicesmithwork");
  });

  it("appends a numeric suffix on first collision", async () => {
    const exists = vi
      .fn()
      .mockResolvedValueOnce(true)   // "alice" taken
      .mockResolvedValueOnce(false); // "alice2" free
    expect(await deriveHandle("alice@example.com", exists)).toBe("alice2");
    expect(exists).toHaveBeenCalledTimes(2);
    expect(exists).toHaveBeenNthCalledWith(2, "alice2");
  });

  it("walks suffixes 2..N until a free handle is found", async () => {
    const taken = new Set(["alice", "alice2", "alice3", "alice4"]);
    const exists = vi.fn(async (h: string) => taken.has(h));
    expect(await deriveHandle("alice@example.com", exists)).toBe("alice5");
  });

  it("falls back to a generated user-prefix when normalisation produces empty", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const handle = await deriveHandle("@@@@", exists);
    expect(handle).toMatch(/^user\d+$/);
  });

  it("respects the 32-char Cognito ceiling when adding suffixes", async () => {
    const longBase = "a".repeat(50) + "@example.com";
    const exists = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const handle = await deriveHandle(longBase, exists);
    expect(handle.length).toBeLessThanOrEqual(32);
    expect(handle.endsWith("2")).toBe(true);
  });

  it("returns a randomised fallback after exhausting collision attempts", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const handle = await deriveHandle("alice@example.com", exists);
    expect(handle.length).toBeLessThanOrEqual(32);
    expect(handle).not.toBe("alice");
  });
});
