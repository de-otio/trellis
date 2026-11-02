// The Dependabot merge gate: a PURE decision function.
//
// Input is plain data describing one pull request; output is `{pass, reasons}`.
// No I/O, no clock, no environment: the thin shell (`gate.mjs`, the workflow)
// gathers the data and acts on the answer. This module only decides, which is
// what makes every rule testable with an inline fixture.
//
// The gate DECIDES; it never chooses who performs the merge. Rule 4 (required
// checks green) is deliberately not reimplemented here: GitHub's auto-merge and
// the merge queue only complete once the required status checks pass, so the
// gate's job is to decide whether auto-merge may be ENABLED at all.
//
// Every rule is fail-closed: an absent, empty or unrecognised input is a
// failure, never a pass. A failure costs a human a look; a wrong pass costs an
// unreviewed change on `main`.
//
// Rules (plans/pocock-brakes-and-dependabot-2026-11.md, W2 section 2):
//   1. The PR author is `dependabot[bot]` and every commit is authored by
//      Dependabot (and carries a valid signature, so a human cannot forge the
//      author field).
//   2. `update-type` is a known non-major value.
//   3. Changed paths are only `package.json`, `**/package.json`,
//      `package-lock.json`, and `.github/workflows/*.yml` files in which every
//      changed line only moves an action pin.
//   4. Required checks green: left to GitHub (see above).
//   5. No `needs-human-review` label.
//   +  Any supply-chain flag from `scripts/supply-chain/flags.mjs`.

export const BOT_LOGIN = "dependabot[bot]";
export const HUMAN_REVIEW_LABEL = "needs-human-review";
export const MAJOR = "version-update:semver-major";
// A whitelist, not "anything but major": an empty or new value must not pass.
export const ALLOWED_UPDATE_TYPES = ["version-update:semver-patch", "version-update:semver-minor"];

const ROOT_FILES = new Set(["package.json", "package-lock.json"]);
const NESTED_PACKAGE_JSON = /^(?:[^/]+\/)+package\.json$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.yml$/;

// `uses: owner/repo[/path]@ref`, optionally a list item, optionally followed by
// a trailing `# version` comment. No quotes, no local (`./`) or `docker://`
// references: anything unusual falls out of the pin shape and fails the rule.
const PIN_LINE =
  /^\s*(?:-\s+)?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@([A-Za-z0-9_./-]+)\s*(?:#.*)?$/;

/** @param {string} filename */
export function isAllowedPath(filename) {
  if (typeof filename !== "string" || filename === "") return false;
  if (filename.split("/").some((s) => s === ".." || s === ".")) return false;
  if (ROOT_FILES.has(filename)) return true;
  if (NESTED_PACKAGE_JSON.test(filename)) {
    // A vendored copy under node_modules is not a manifest we expect to move.
    return !filename.split("/").includes("node_modules");
  }
  return WORKFLOW_FILE.test(filename);
}

/** @param {string} filename */
export const isWorkflowFile = (filename) => WORKFLOW_FILE.test(filename);

/**
 * Does this unified-diff patch only move action pins?
 *
 * Every added or removed line must be a `uses: owner/repo@ref [# comment]`
 * line, and the multiset of action names removed must equal the multiset added
 * (so a pin cannot be swapped for a different repository).
 *
 * @param {unknown} patch GitHub's per-file `patch` string (absent for large or binary files)
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function checkActionPinPatch(patch) {
  if (typeof patch !== "string" || patch === "") {
    return { ok: false, why: "no patch available to inspect" };
  }
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const added = [];
  for (const line of patch.split("\n")) {
    if (line === "" || line.startsWith("@@") || line.startsWith(" ")) continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-") {
      return { ok: false, why: `unexpected diff line: ${clip(line)}` };
    }
    const m = PIN_LINE.exec(line.slice(1));
    if (!m) {
      return { ok: false, why: `changed line is not an action pin: ${clip(line)}` };
    }
    (marker === "-" ? removed : added).push(m[1]);
  }
  if (removed.length === 0 && added.length === 0) {
    return { ok: false, why: "patch changes nothing" };
  }
  if (
    removed.length !== added.length ||
    [...removed].sort().join("\n") !== [...added].sort().join("\n")
  ) {
    return { ok: false, why: "pin change swaps, adds or removes an action" };
  }
  return { ok: true };
}

/** @param {string} s */
function clip(s) {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * @typedef {object} GateInput
 * @property {string} author PR author login
 * @property {{authorLogin: string|null, verified: boolean}[]} commits every commit on the PR
 * @property {{filename: string, status: string, patch?: string}[]} files every changed file
 * @property {number} [expectedFileCount] GitHub's `changed_files`; a shorter list means truncation
 * @property {string[]} labels label names currently on the PR
 * @property {string} updateType `dependabot/fetch-metadata` `update-type` output
 * @property {{package: string, reason: string}[]} supplyChainFlags output of flags.mjs
 */

/**
 * @param {GateInput} input
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function evaluate(input) {
  /** @type {string[]} */
  const reasons = [];
  const { author, commits, files, labels, updateType, supplyChainFlags } = input;

  // Rule 1: author and every commit are Dependabot's.
  if (author !== BOT_LOGIN) {
    reasons.push(`rule 1: PR author is not ${BOT_LOGIN}`);
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    reasons.push("rule 1: no commits to inspect");
  } else {
    const foreign = commits.filter((c) => c?.authorLogin !== BOT_LOGIN).length;
    if (foreign > 0) {
      reasons.push(`rule 1: ${foreign} commit(s) not authored by ${BOT_LOGIN}`);
    }
    const unsigned = commits.filter((c) => c?.verified !== true).length;
    if (unsigned > 0) {
      reasons.push(`rule 1: ${unsigned} commit(s) without a verified signature`);
    }
  }

  // Rule 2: a known, non-major update type.
  if (updateType === MAJOR) {
    reasons.push("rule 2: semver-major update");
  } else if (!ALLOWED_UPDATE_TYPES.includes(updateType)) {
    reasons.push(
      `rule 2: update-type is not a known patch/minor value (${JSON.stringify(updateType ?? null)})`,
    );
  }

  // Rule 3: only manifests, the root lockfile, and pin-only workflow edits.
  if (!Array.isArray(files) || files.length === 0) {
    reasons.push("rule 3: no changed files to inspect");
  } else {
    if (typeof input.expectedFileCount === "number" && input.expectedFileCount !== files.length) {
      reasons.push(`rule 3: saw ${files.length} of ${input.expectedFileCount} changed files`);
    }
    for (const f of files) {
      if (!isAllowedPath(f?.filename)) {
        reasons.push(`rule 3: path not allowed: ${clip(String(f?.filename))}`);
        continue;
      }
      if (f.status !== "modified") {
        reasons.push(`rule 3: ${f.filename} is ${String(f.status)}, not modified`);
        continue;
      }
      if (isWorkflowFile(f.filename)) {
        const r = checkActionPinPatch(f.patch);
        if (!r.ok) reasons.push(`rule 3: ${f.filename}: ${r.why}`);
      }
    }
  }

  // Rule 5: a human (or the gate itself, earlier) asked for review.
  if (!Array.isArray(labels) || labels.includes(HUMAN_REVIEW_LABEL)) {
    reasons.push(
      Array.isArray(labels)
        ? `rule 5: carries the ${HUMAN_REVIEW_LABEL} label`
        : "rule 5: labels unknown",
    );
  }

  // Supply-chain flags (W3). Absent input is a failure, not "no flags".
  if (!Array.isArray(supplyChainFlags)) {
    reasons.push("supply-chain: flags were not provided");
  } else {
    for (const flag of supplyChainFlags) {
      reasons.push(`supply-chain: ${clip(String(flag?.package))} (${clip(String(flag?.reason))})`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}
