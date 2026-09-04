/**
 * T7a — finding 2: the container refuses to start when a required secret
 * (DB, pseudonym tombstone key) resolves empty or errors.
 */

import { describe, expect, it, vi } from "vitest";
import {
  validateRequiredSecrets,
  StartupValidationError,
} from "../../../../worker/src/startup-validation.js";
import type { Logger } from "../../../src/lib/logger.js";

function makeLogger(): Logger {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

describe("validateRequiredSecrets (finding 2)", () => {
  it("passes when every secret resolves non-empty (values discarded)", async () => {
    await expect(
      validateRequiredSecrets(
        [
          { name: "db-secret", resolve: async () => "hunter2" },
          { name: "pseudonym-tombstone-key", resolve: async () => "key-material" },
        ],
        makeLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it("GATE: an EMPTY pseudonym key refuses startup", async () => {
    await expect(
      validateRequiredSecrets(
        [{ name: "pseudonym-tombstone-key", resolve: async () => "" }],
        makeLogger(),
      ),
    ).rejects.toThrow(StartupValidationError);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the number 0", 0],
    ["a truthy number", 42],
    ["a Buffer (lying resolver)", Buffer.from("key-material")],
    ["whitespace-only (spaces)", "   "],
    ["whitespace-only (tab+newline)", "\t\n"],
  ])(
    "GATE (critic F8 boundary): a resolver yielding %s refuses startup",
    async (_label, value) => {
      await expect(
        validateRequiredSecrets(
          [
            {
              name: "pseudonym-tombstone-key",
              // A misbehaving resolver escapes the declared Promise<string>.
              resolve: async () => value as unknown as string,
            },
          ],
          makeLogger(),
        ),
      ).rejects.toThrow(StartupValidationError);
    },
  );

  it("GATE: a resolution ERROR refuses startup (fail-closed, not fail-open)", async () => {
    await expect(
      validateRequiredSecrets(
        [
          {
            name: "pseudonym-tombstone-key",
            resolve: async () => {
              throw new Error("SSM unreachable");
            },
          },
        ],
        makeLogger(),
      ),
    ).rejects.toThrow(/SSM unreachable/);
  });

  it("reports ALL failures (names only — never values) in one error", async () => {
    const err = await validateRequiredSecrets(
      [
        { name: "db-secret", resolve: async () => "" },
        { name: "pseudonym-tombstone-key", resolve: async () => "" },
      ],
      makeLogger(),
    ).catch((e: StartupValidationError) => e);

    expect(err).toBeInstanceOf(StartupValidationError);
    expect((err as StartupValidationError).failures).toHaveLength(2);
    expect(String(err)).toContain("db-secret");
    expect(String(err)).toContain("pseudonym-tombstone-key");
  });
});
