// Pure logic for T4's version-lockstep check (plan §2.3 / §4-T4).
//
// WHY: `packages/extension-api/src/extension.ts` exports a runtime
// `EXTENSION_API_VERSION` const that consuming apps (and trellis's own
// startup validator, T5) can compare against at runtime. That const must
// never drift from `packages/extension-api/package.json`'s `version` field —
// otherwise the published npm version and the value code checks against at
// runtime silently disagree.
//
// This module compares the two sources TO EACH OTHER (never to a hardcoded
// expected value), so it stays correct regardless of which sibling task last
// bumped which side. Extraction from the TS source is a single ANCHORED
// regex on the exact declaration line — not a repo-wide/loose regex — so it
// fails loudly (throws) if the declaration shape ever changes instead of
// silently matching something unintended.

/**
 * Extract the string literal value of the single
 * `export const EXTENSION_API_VERSION = "x.y.z" as const;` declaration.
 *
 * Anchored: matches only that exact declaration shape (single or double
 * quotes, optional `as const`, optional trailing semicolon). Throws with a
 * descriptive message if the source contains zero or more-than-one match —
 * ambiguity here must fail loudly, not silently pick one.
 *
 * @param {string} source - full contents of extension.ts
 * @returns {string} the version string literal (e.g. "0.7.0")
 */
export function extractVersionConst(source) {
  const pattern =
    /export\s+const\s+EXTENSION_API_VERSION\s*=\s*["']([^"']+)["']\s*(?:as\s+const\s*)?;/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(
      "check-extension-api-version: no `export const EXTENSION_API_VERSION = \"...\";` " +
        "declaration found in extension.ts (anchored pattern did not match — did the " +
        "declaration shape change?)",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `check-extension-api-version: found ${matches.length} EXTENSION_API_VERSION ` +
        "declarations in extension.ts; expected exactly one.",
    );
  }
  return matches[0][1];
}

/**
 * Extract the `version` field from a package.json's already-parsed object.
 *
 * @param {unknown} packageJson - result of JSON.parse on package.json
 * @returns {string}
 */
export function extractPackageVersion(packageJson) {
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    typeof /** @type {any} */ (packageJson).version !== "string"
  ) {
    throw new Error(
      "check-extension-api-version: package.json has no string `version` field",
    );
  }
  return /** @type {{ version: string }} */ (packageJson).version;
}

/**
 * Compare the two version sources. Pure — no filesystem access.
 *
 * @param {string} constVersion
 * @param {string} packageVersion
 * @returns {{ ok: boolean, message: string }}
 */
export function compareVersions(constVersion, packageVersion) {
  if (constVersion === packageVersion) {
    return {
      ok: true,
      message: `EXTENSION_API_VERSION ("${constVersion}") matches package.json ("${packageVersion}").`,
    };
  }
  return {
    ok: false,
    message:
      `Version lockstep broken: EXTENSION_API_VERSION = "${constVersion}" in ` +
      `packages/extension-api/src/extension.ts, but package.json version = ` +
      `"${packageVersion}". Bump both together.`,
  };
}
