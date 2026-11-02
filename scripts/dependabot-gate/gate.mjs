#!/usr/bin/env node
// Thin I/O shell around evaluate.mjs: gather one PR's facts through the GitHub
// API (as DATA), run the pure decision, print the result as JSON.
//
// Usage:
//   node scripts/dependabot-gate/gate.mjs \
//     --repo owner/name --pr 123 --expected-head <sha> \
//     --update-type version-update:semver-minor --flags-file flags.json
//
// Needs `gh` on PATH and GH_TOKEN with read access to pull requests. It never
// checks out, installs or executes anything from the PR: the pull_request_target
// workflow that calls it runs this file from the BASE branch.
//
// stdout: {"pass": bool, "reasons": string[], "alreadyLabeled": bool,
//          "updateType": string, "head": string}
// Exit 0 whenever a decision was made (pass or not); non-zero only when the
// facts could not be gathered, which the workflow treats as "do not merge".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { evaluate, HUMAN_REVIEW_LABEL } from "./evaluate.mjs";

/** @param {string[]} args */
function gh(args) {
  return execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
}

/** @param {string} endpoint */
function ghPaginated(endpoint) {
  // --slurp wraps the pages in one outer array.
  return JSON.parse(gh(["--paginate", "--slurp", endpoint])).flat();
}

/** One line, no control characters, bounded: reasons end up in a PR comment. */
const tidy = (/** @type {string} */ s) =>
  s
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/`/g, "'")
    .slice(0, 300);

function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      "expected-head": { type: "string" },
      "update-type": { type: "string", default: "" },
      "flags-file": { type: "string" },
    },
  });
  const repo = values.repo;
  const pr = values.pr;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !pr || !/^\d+$/.test(pr)) {
    throw new Error("--repo owner/name and numeric --pr are required");
  }

  const pull = JSON.parse(gh([`repos/${repo}/pulls/${pr}`]));
  const commits = ghPaginated(`repos/${repo}/pulls/${pr}/commits`).map((c) => ({
    authorLogin: c.author?.login ?? null,
    verified: c.commit?.verification?.verified === true,
  }));
  const files = ghPaginated(`repos/${repo}/pulls/${pr}/files`).map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch,
  }));
  const labels = (pull.labels ?? []).map((/** @type {{name: string}} */ l) => l.name);

  /** @type {{package: string, reason: string}[] | undefined} */
  let supplyChainFlags;
  if (values["flags-file"]) {
    const parsed = JSON.parse(readFileSync(values["flags-file"], "utf8"));
    if (Array.isArray(parsed?.flags)) supplyChainFlags = parsed.flags;
  }

  const result = evaluate({
    author: pull.user?.login,
    commits,
    files,
    expectedFileCount: pull.changed_files,
    labels,
    updateType: values["update-type"] ?? "",
    supplyChainFlags,
  });
  const reasons = [...result.reasons];

  // The facts above are the PR as it is NOW. The decision only holds for the
  // commit the workflow was started for; a push in between starts a new run.
  if (!values["expected-head"] || pull.head?.sha !== values["expected-head"]) {
    reasons.push("head moved since this run started; a newer run will decide");
  }

  process.stdout.write(
    `${JSON.stringify({
      pass: reasons.length === 0,
      reasons: reasons.slice(0, 25).map(tidy),
      alreadyLabeled: labels.includes(HUMAN_REVIEW_LABEL),
      updateType: values["update-type"] ?? "",
      head: pull.head?.sha ?? "",
    })}\n`,
  );
}

main();
