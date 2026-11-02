/**
 * Thin I/O shell for the Dependabot stall alarm.
 *
 *   node scripts/dependabot-stall/run.mjs <prs.json>
 *
 * <prs.json> is the output of `gh pr list --state open --json
 * number,title,url,createdAt,isDraft,state,author,autoMergeRequest`.
 * Env: NTFY_TOPIC (required; a secret in this public repo), GITHUB_REPOSITORY.
 *
 * All decisions live in select-stalled.mjs. This file only reads, calls the
 * pure functions, and POSTs once to ntfy (JSON publish, so the topic stays out
 * of the URL and out of any error text).
 *
 * Exit codes: 0 nothing stalled or notification delivered; 1 anything else.
 * A missing NTFY_TOPIC fails even on a day with nothing stalled: a silent
 * alarm is worse than no alarm.
 */

import { readFileSync } from "node:fs";
import { formatNotification, selectStalled } from "./select-stalled.mjs";

const NTFY_URL = "https://ntfy.sh/";

function fail(message) {
  console.error(`dependabot-stall: ${message}`);
  process.exit(1);
}

const topic = process.env.NTFY_TOPIC?.trim();
if (!topic) {
  fail("NTFY_TOPIC is not set; refusing to run an alarm that cannot notify");
}

const file = process.argv[2];
if (!file) fail("usage: run.mjs <prs.json>");

const repo = process.env.GITHUB_REPOSITORY || "repo";
const prs = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(prs)) fail("input is not a JSON array of PRs");

const stalled = selectStalled(prs, new Date());
const notification = formatNotification(stalled, repo);

console.log(`dependabot-stall: ${prs.length} PRs inspected, ${stalled.length} stalled`);
for (const pr of stalled) {
  console.log(`  #${pr.number} ${pr.reasons.map((r) => r.kind).join(", ")}`);
}

if (notification) {
  let res;
  try {
    res = await fetch(NTFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: notification.title,
        message: notification.message,
        priority: 3,
        tags: ["warning"],
        click: `https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Message only: never the URL/body, which carry the topic.
    fail(`ntfy request failed: ${err instanceof Error ? err.name : "error"}`);
  }
  if (!res.ok) fail(`ntfy responded HTTP ${res.status}`);
  console.log("dependabot-stall: notification sent");
}
