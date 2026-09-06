/**
 * The `ctx.config` denylist, and the drift guard that keeps it honest.
 *
 * A hand-maintained list of secret env keys is exactly the artefact that rots:
 * the next person adds `FOO_SIGNING_KEY` to `env-schema.ts`, nothing fails, and
 * an extension can name it in its `configSchema` a release later. So the list
 * is not trusted on its own — it is re-derived from the schema source here and
 * compared.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CORE_SECRET_ENV_KEYS,
  isCoreSecretEnvKey,
  coreSecretEnvKeysIn,
} from "../../src/lib/extension-config-keys.js";

/**
 * Keys declared in `env-schema.ts` whose NAME says they carry credential
 * material. Deliberately name-shaped: the point is to catch a key added later
 * by someone who did not read this file, and a name is what they will write.
 */
const SECRET_SHAPED = /(SECRET|PASSWORD|SALT|_ENC_KEY|_PRIVATE_KEY)/;

/** Every top-level key declared in the boot-env schema object literal. */
function declaredEnvSchemaKeys(): string[] {
  const source = readFileSync(join(import.meta.dirname, "../../src/env-schema.ts"), "utf8");
  const keys = new Set<string>();
  for (const line of source.split("\n")) {
    const m = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

describe("CORE_SECRET_ENV_KEYS", () => {
  it("re-derives from env-schema.ts and finds nothing uncovered", () => {
    const declared = declaredEnvSchemaKeys();
    // Sanity: the extraction works at all. If this drops to nothing the guard
    // below would pass vacuously, which is the failure mode of every
    // grep-the-source test.
    expect(declared.length).toBeGreaterThan(20);
    expect(declared).toContain("SESSION_SECRET");

    const secretShaped = declared.filter((k) => SECRET_SHAPED.test(k));
    const uncovered = secretShaped.filter((k) => !isCoreSecretEnvKey(k));
    expect(
      uncovered,
      "secret-shaped keys in env-schema.ts that an extension could still name " +
        "in its configSchema — add them to CORE_SECRET_ENV_KEYS",
    ).toEqual([]);
  });

  it("covers DATABASE_URL, which is credential material without a secret-shaped name", () => {
    expect(isCoreSecretEnvKey("DATABASE_URL")).toBe(true);
  });

  it("covers the ambient AWS credential trio, which core never declares", () => {
    // Not in the boot schema — the SDK reads them straight from process.env,
    // which is precisely why naming one must not work.
    expect(isCoreSecretEnvKey("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(isCoreSecretEnvKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isCoreSecretEnvKey("AWS_SESSION_TOKEN")).toBe(true);
  });

  it("leaves an extension's own keys alone", () => {
    expect(isCoreSecretEnvKey("DOG_REGISTRY_URL")).toBe(false);
    expect(isCoreSecretEnvKey("DOG_VISION_API_KEY")).toBe(false);
    expect(isCoreSecretEnvKey("")).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(CORE_SECRET_ENV_KEYS).size).toBe(CORE_SECRET_ENV_KEYS.length);
  });
});

describe("coreSecretEnvKeysIn", () => {
  it("returns [] for a clean declaration", () => {
    expect(coreSecretEnvKeysIn(["DOG_REGISTRY_URL", "DOG_TIMEOUT_MS"])).toEqual([]);
  });

  it("returns every denied key, in declaration order, deduplicated", () => {
    expect(
      coreSecretEnvKeysIn(["DOG_REGISTRY_URL", "SESSION_SECRET", "DATABASE_URL", "SESSION_SECRET"]),
    ).toEqual(["SESSION_SECRET", "DATABASE_URL"]);
  });

  it("is total for an empty input", () => {
    expect(coreSecretEnvKeysIn([])).toEqual([]);
  });
});
