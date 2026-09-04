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
      'check-extension-api-version: no `export const EXTENSION_API_VERSION = "...";` ' +
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
 * Extract the version the reference doc claims, from its
 * `> **Current version: \`x.y.z\`.**` line.
 *
 * WHY: the doc is what an extension author — increasingly, an author's coding
 * agent — reads as ground truth, and it had drifted a full version behind the
 * code (claiming 0.8.0 against a 0.8.1 package) with nothing to catch it. A
 * stale reference doc is worse than no doc: generated code is written against
 * it.
 *
 * Anchored on the exact callout shape, and requires exactly one match, so a
 * restructured doc fails loudly rather than silently passing.
 *
 * @param {string} source - full contents of docs/reference/extension-api.md
 * @returns {string} the version string the doc claims
 */
export function extractDocVersion(source) {
  const pattern = /^>\s*\*\*Current version:\s*`([^`]+)`\.\*\*/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(
      "check-extension-api-version: no `> **Current version: `x.y.z`.**` line found in " +
        "docs/reference/extension-api.md (anchored pattern did not match — did the " +
        "callout shape change?)",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `check-extension-api-version: found ${matches.length} "Current version" callouts ` +
        "in docs/reference/extension-api.md; expected exactly one.",
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
    typeof (/** @type {any} */ (packageJson).version) !== "string"
  ) {
    throw new Error("check-extension-api-version: package.json has no string `version` field");
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

/**
 * Compare all three sources of the contract version: the runtime const, the
 * published package.json, and the reference doc's stated version. Pure.
 *
 * All three must agree. Any disagreement is reported with every value, so the
 * fix is obvious from the failure alone.
 *
 * @param {string} constVersion
 * @param {string} packageVersion
 * @param {string} docVersion
 * @returns {{ ok: boolean, message: string }}
 */
export function compareAllVersions(constVersion, packageVersion, docVersion) {
  const pair = compareVersions(constVersion, packageVersion);
  if (!pair.ok) return pair;

  if (constVersion === docVersion) {
    return {
      ok: true,
      message:
        `EXTENSION_API_VERSION, package.json and the reference doc all agree ` +
        `("${constVersion}").`,
    };
  }
  return {
    ok: false,
    message:
      `Reference doc is stale: docs/reference/extension-api.md states ` +
      `"${docVersion}", but the contract is at "${constVersion}" ` +
      `(package.json "${packageVersion}"). Update the "Current version" ` +
      `callout — an extension author, or their agent, reads that doc as ground ` +
      `truth and will generate code against it.`,
  };
}

/**
 * Does a caret range admit a concrete version?
 *
 * Deliberately narrow: this understands ONLY the `^x.y.z` form the workspace
 * actually uses, and throws on anything else rather than guessing. A wrong
 * "yes" here would re-open exactly the hole this function exists to close, and
 * a full semver implementation is not worth owning — `semver` itself resolves
 * in this repo only as a transitive dependency of something else, which is not
 * a foundation for a CI gate.
 *
 * Caret semantics, per npm: below 1.0.0 a caret pins the MINOR (`^0.9.0`
 * admits `0.9.x` but not `0.10.0`); at or above 1.0.0 it pins the MAJOR.
 *
 * @param {string} range - e.g. "^0.9.0"
 * @param {string} version - e.g. "0.9.0"
 * @returns {boolean}
 */
export function caretRangeAdmits(range, version) {
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!caret) {
    throw new Error(
      `check-extension-api-version: unsupported dependency range "${range}". ` +
        "This gate understands only plain caret ranges (^x.y.z), which is what " +
        "the workspace uses. Extend caretRangeAdmits() deliberately rather than " +
        "loosening the gate.",
    );
  }
  const target = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!target) {
    throw new Error(
      `check-extension-api-version: package version "${version}" is not a plain ` +
        "x.y.z release version; this gate does not evaluate pre-release ranges.",
    );
  }
  const [rMajor, rMinor, rPatch] = caret.slice(1).map(Number);
  const [vMajor, vMinor, vPatch] = target.slice(1).map(Number);

  if (vMajor !== rMajor) return false;
  if (rMajor === 0) {
    // Pre-1.0: the minor is the breaking axis, so it must match exactly.
    return vMinor === rMinor && vPatch >= rPatch;
  }
  return vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch);
}

/**
 * Check that every in-repo consumer's declared dependency range still admits
 * the version extension-api is being published at. Pure.
 *
 * WHY THIS IS A FOURTH SOURCE
 * ---------------------------
 * The version is stated in five places, not three: the runtime const, the
 * package's own `version`, the reference doc, and the range each consuming
 * workspace declares. The 0.8.1 -> 0.9.0 bump was made in the first three and
 * missed the ranges, which still said `^0.8.0` — a range that EXCLUDES 0.9.0,
 * because pre-1.0 a caret pins the minor.
 *
 * Nothing local caught it. A `node_modules` tree installed before the bump
 * keeps its workspace symlink, so typecheck, the full unit suite, and the
 * packed-tarball smoke test all passed against a dependency graph that could
 * not be reinstalled from scratch. It surfaced only in CI, at `npm ci`, which
 * refuses a lockfile out of sync with its manifests. That is the same
 * stale-resolution trap that makes a dependency bump appear to have taken
 * effect when it has not.
 *
 * @param {string} packageVersion - version extension-api declares
 * @param {Array<{ path: string, range: string }>} consumers
 * @returns {{ ok: boolean, message: string }}
 */
export function checkConsumerRanges(packageVersion, consumers) {
  if (consumers.length === 0) {
    throw new Error(
      "check-extension-api-version: found no in-repo consumer of " +
        "@de-otio/trellis-extension-api. Expected at least one — did a manifest " +
        "path change, or the dependency name?",
    );
  }

  const stale = consumers.filter((c) => !caretRangeAdmits(c.range, packageVersion));
  if (stale.length === 0) {
    return {
      ok: true,
      message: `All ${consumers.length} in-repo consumer range(s) admit ` + `"${packageVersion}".`,
    };
  }
  return {
    ok: false,
    message:
      `Consumer dependency range(s) exclude the version being published:\n` +
      stale.map((c) => `  ${c.path}: "${c.range}"`).join("\n") +
      `\nextension-api is at "${packageVersion}". Below 1.0.0 a caret pins the ` +
      `minor, so "^0.8.0" does not admit "0.9.0". Bump the range(s) and run ` +
      `\`npm install --package-lock-only\` — otherwise \`npm ci\` fails on a ` +
      `lockfile out of sync with its manifests.`,
  };
}
