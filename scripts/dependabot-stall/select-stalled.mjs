/**
 * Pure selection + formatting for the Dependabot stall alarm.
 *
 * No I/O, no clock reads: callers pass the PR list and `now`. The thin shell
 * (run.mjs) fetches PRs and posts to ntfy; the workflow is
 * .github/workflows/dependabot-stall-alarm.yml; tests are
 * apps/api/test/unit/scripts/select-stalled.test.ts.
 *
 * Why this exists: with the code-owner-approval ruleset, Dependabot's
 * auto-merge waits forever without an error. A regressed bypass or a renamed
 * required check fails the same way. Age is the symptom that is cheap to see.
 *
 * Input shape is `gh pr list --json
 * number,title,url,createdAt,isDraft,state,author,autoMergeRequest`:
 *   - author.login is "app/dependabot" (newer gh), "dependabot" (GraphQL bot
 *     actor) or "dependabot[bot]" (REST); all are accepted.
 *   - autoMergeRequest is null, or has `enabledAt` (ISO 8601).
 */

export const OPEN_TOO_LONG_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTO_MERGE_STALLED_MS = 48 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "app/dependabot" | "dependabot" | "dependabot[bot]" -> true. */
export function isDependabotLogin(login) {
  if (typeof login !== "string") return false;
  const normalised = login
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
  return normalised === "dependabot";
}

/** Milliseconds from an ISO timestamp to `now`; throws on garbage rather than guessing. */
function elapsedMs(iso, now, what) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new Error(`unparseable ${what} timestamp: ${JSON.stringify(iso)}`);
  }
  return now.getTime() - t;
}

/**
 * Select the Dependabot PRs that look stalled.
 *
 * A PR is stalled when it is OPEN, not a draft, authored by Dependabot, and
 * either
 *   - "open-too-long": open for strictly more than 7 days, or
 *   - "auto-merge-stalled": auto-merge enabled for strictly more than 48 hours.
 * Exactly on a threshold is not yet stalled.
 *
 * @param {ReadonlyArray<object>} prs
 * @param {Date} now
 * @returns {Array<{number:number,title:string,url:string,reasons:Array<{kind:string,ageMs:number,thresholdMs:number}>}>}
 *   sorted by PR number; reasons are in a fixed order (open-too-long first).
 */
export function selectStalled(prs, now) {
  const stalled = [];
  for (const pr of prs) {
    if (!isDependabotLogin(pr.author?.login)) continue;
    if (pr.state !== "OPEN") continue;
    if (pr.isDraft === true) continue;

    const reasons = [];
    const openMs = elapsedMs(pr.createdAt, now, `PR #${pr.number} createdAt`);
    if (openMs > OPEN_TOO_LONG_MS) {
      reasons.push({
        kind: "open-too-long",
        ageMs: openMs,
        thresholdMs: OPEN_TOO_LONG_MS,
      });
    }
    const enabledAt = pr.autoMergeRequest?.enabledAt;
    if (enabledAt) {
      const amMs = elapsedMs(enabledAt, now, `PR #${pr.number} autoMergeRequest.enabledAt`);
      if (amMs > AUTO_MERGE_STALLED_MS) {
        reasons.push({
          kind: "auto-merge-stalled",
          ageMs: amMs,
          thresholdMs: AUTO_MERGE_STALLED_MS,
        });
      }
    }
    if (reasons.length > 0) {
      stalled.push({ number: pr.number, title: pr.title, url: pr.url, reasons });
    }
  }
  return stalled.sort((a, b) => a.number - b.number);
}

/** "45d" from 2 days up, otherwise whole hours ("49h"). Floors; never rounds up past a threshold. */
export function formatAge(ms) {
  if (ms >= 2 * DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  return `${Math.floor(ms / HOUR_MS)}h`;
}

const REASON_LABEL = {
  "open-too-long": "open",
  "auto-merge-stalled": "auto-merge on",
};

const REASON_THRESHOLD = {
  "open-too-long": ">7d",
  "auto-merge-stalled": ">48h",
};

/** Titles are third-party text: collapse to one line. */
const oneLine = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * One notification for the whole run. Returns null when nothing is stalled
 * (so the caller sends nothing).
 *
 * ntfy caps a message at 4096 bytes; the list is cut at `maxBytes` with an
 * explicit "+N more" line rather than silently truncated mid-entry.
 *
 * @returns {{title:string,message:string}|null}
 */
export function formatNotification(stalled, repo, { maxBytes = 3500 } = {}) {
  if (stalled.length === 0) return null;
  const title = `${repo}: ${stalled.length} stalled Dependabot PR${stalled.length === 1 ? "" : "s"}`;
  const entries = stalled.map((pr) => {
    const why = pr.reasons
      .map((r) => `${REASON_LABEL[r.kind]} ${formatAge(r.ageMs)} (${REASON_THRESHOLD[r.kind]})`)
      .join(", ");
    return `#${pr.number} ${oneLine(pr.title)}\n${why}\n${pr.url}`;
  });

  const kept = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry) + 2;
    if (kept.length > 0 && bytes + size > maxBytes) break;
    kept.push(entry);
    bytes += size;
  }
  const dropped = entries.length - kept.length;
  if (dropped > 0) kept.push(`+${dropped} more`);
  return { title, message: kept.join("\n\n") };
}
