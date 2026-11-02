/**
 * Unit tests: scripts/dependabot-stall/select-stalled.mjs
 *
 * The alarm exists to catch silent auto-merge stalls, so the assertions that
 * matter are the edges: exactly on a threshold is NOT stalled, one millisecond
 * past it is. The clock is a fixed `NOW` passed in; nothing reads Date.now().
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs script, deliberately untyped (same pattern as
// check-gate-polarity.test.ts).
import * as stall from "../../../../../scripts/dependabot-stall/select-stalled.mjs";

interface Reason {
  kind: string;
  ageMs: number;
  thresholdMs: number;
}
interface Stalled {
  number: number;
  title: string;
  url: string;
  reasons: Reason[];
}
interface Pr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  state: string;
  author: { login: string };
  autoMergeRequest: { enabledAt: string } | null;
}

const selectStalled = stall.selectStalled as (prs: Pr[], now: Date) => Stalled[];
const formatNotification = stall.formatNotification as (
  stalled: Stalled[],
  repo: string,
  opts?: { maxBytes?: number },
) => { title: string; message: string } | null;
const formatAge = stall.formatAge as (ms: number) => string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 1,
  title: "chore(deps): bump foo from 1.0.0 to 1.0.1",
  url: "https://github.com/example/repo/pull/1",
  createdAt: ago(1 * HOUR),
  isDraft: false,
  state: "OPEN",
  author: { login: "app/dependabot" },
  autoMergeRequest: null,
  ...over,
});

const kinds = (prs: Pr[]) => selectStalled(prs, NOW).map((s) => s.reasons.map((r) => r.kind));

describe("open longer than 7 days", () => {
  it("does not flag a PR open for exactly 7 days", () => {
    expect(kinds([pr({ createdAt: ago(7 * DAY) })])).toEqual([]);
  });

  it("flags a PR open for 7 days and 1 ms", () => {
    expect(kinds([pr({ createdAt: ago(7 * DAY + 1) })])).toEqual([["open-too-long"]]);
  });

  it("does not flag a PR open for 7 days minus 1 ms", () => {
    expect(kinds([pr({ createdAt: ago(7 * DAY - 1) })])).toEqual([]);
  });

  it("reports the measured age and the threshold", () => {
    const [s] = selectStalled([pr({ createdAt: ago(45 * DAY) })], NOW);
    expect(s?.reasons).toEqual([{ kind: "open-too-long", ageMs: 45 * DAY, thresholdMs: 7 * DAY }]);
  });
});

describe("auto-merge enabled for more than 48 hours", () => {
  const young = ago(1 * HOUR); // keep the open-too-long rule out of the picture

  it("does not flag auto-merge enabled exactly 48 hours ago", () => {
    expect(
      kinds([pr({ createdAt: young, autoMergeRequest: { enabledAt: ago(48 * HOUR) } })]),
    ).toEqual([]);
  });

  it("flags auto-merge enabled 48 hours and 1 ms ago", () => {
    expect(
      kinds([pr({ createdAt: young, autoMergeRequest: { enabledAt: ago(48 * HOUR + 1) } })]),
    ).toEqual([["auto-merge-stalled"]]);
  });

  it("does not flag auto-merge enabled 48 hours minus 1 ms ago", () => {
    expect(
      kinds([pr({ createdAt: young, autoMergeRequest: { enabledAt: ago(48 * HOUR - 1) } })]),
    ).toEqual([]);
  });

  it("does not flag an old PR whose auto-merge is disabled (null)", () => {
    // 3 days old: past the 48 h mark but short of 7 d, and no auto-merge request.
    expect(kinds([pr({ createdAt: ago(3 * DAY), autoMergeRequest: null })])).toEqual([]);
  });

  it("measures from enabledAt, not from createdAt", () => {
    // Created 5 days ago, auto-merge enabled 1 hour ago: not stalled.
    expect(
      kinds([pr({ createdAt: ago(5 * DAY), autoMergeRequest: { enabledAt: ago(1 * HOUR) } })]),
    ).toEqual([]);
  });

  it("lists both reasons, open-too-long first, when both apply", () => {
    expect(
      kinds([pr({ createdAt: ago(45 * DAY), autoMergeRequest: { enabledAt: ago(45 * DAY) } })]),
    ).toEqual([["open-too-long", "auto-merge-stalled"]]);
  });
});

describe("exclusions", () => {
  const old = { createdAt: ago(30 * DAY), autoMergeRequest: { enabledAt: ago(30 * DAY) } };

  it("excludes PRs not authored by Dependabot", () => {
    expect(kinds([pr({ ...old, author: { login: "renovate[bot]" } })])).toEqual([]);
    expect(kinds([pr({ ...old, author: { login: "some-human" } })])).toEqual([]);
    // A look-alike must not slip through a substring match.
    expect(kinds([pr({ ...old, author: { login: "not-dependabot" } })])).toEqual([]);
    expect(kinds([pr({ ...old, author: { login: "dependabot-fan" } })])).toEqual([]);
  });

  it("accepts every spelling of the Dependabot login", () => {
    for (const login of ["app/dependabot", "dependabot", "dependabot[bot]"]) {
      expect(kinds([pr({ ...old, author: { login } })])).toEqual([
        ["open-too-long", "auto-merge-stalled"],
      ]);
    }
  });

  it("excludes drafts", () => {
    expect(kinds([pr({ ...old, isDraft: true })])).toEqual([]);
  });

  it("excludes closed and merged PRs", () => {
    expect(kinds([pr({ ...old, state: "CLOSED" })])).toEqual([]);
    expect(kinds([pr({ ...old, state: "MERGED" })])).toEqual([]);
  });

  it("tolerates a missing author (deleted account)", () => {
    const { author: _author, ...rest } = pr(old);
    expect(kinds([rest as unknown as Pr])).toEqual([]);
  });
});

describe("ordering and bad input", () => {
  it("returns stalled PRs sorted by number", () => {
    const stalled = selectStalled(
      [
        pr({ number: 30, createdAt: ago(9 * DAY) }),
        pr({ number: 10, createdAt: ago(8 * DAY) }),
        pr({ number: 20, createdAt: ago(1 * DAY) }),
      ],
      NOW,
    );
    expect(stalled.map((s) => s.number)).toEqual([10, 30]);
  });

  it("returns nothing for an empty list", () => {
    expect(selectStalled([], NOW)).toEqual([]);
  });

  it("throws on an unparseable timestamp instead of guessing", () => {
    expect(() => selectStalled([pr({ createdAt: "not-a-date" })], NOW)).toThrow(/createdAt/);
    expect(() => selectStalled([pr({ autoMergeRequest: { enabledAt: "garbage" } })], NOW)).toThrow(
      /enabledAt/,
    );
  });
});

describe("formatAge", () => {
  it("uses hours below 2 days and floors", () => {
    expect(formatAge(30 * HOUR + 59 * 60_000)).toBe("30h");
    expect(formatAge(48 * HOUR - 1)).toBe("47h");
  });
  it("uses whole days from 2 days up and floors", () => {
    expect(formatAge(48 * HOUR)).toBe("2d");
    expect(formatAge(45 * DAY + 23 * HOUR)).toBe("45d");
  });
});

describe("formatNotification", () => {
  const stalledOne: Stalled = {
    number: 269,
    title: "chore(deps): bump foo\nfrom 1 to 2",
    url: "https://github.com/example/repo/pull/269",
    reasons: [
      { kind: "open-too-long", ageMs: 45 * DAY, thresholdMs: 7 * DAY },
      { kind: "auto-merge-stalled", ageMs: 45 * DAY, thresholdMs: 48 * HOUR },
    ],
  };

  it("returns null when nothing is stalled (no notification)", () => {
    expect(formatNotification([], "example/repo")).toBeNull();
  });

  it("names the PR number, one-line title, age, reason and link", () => {
    const n = formatNotification([stalledOne], "example/repo");
    expect(n?.title).toBe("example/repo: 1 stalled Dependabot PR");
    expect(n?.message).toBe(
      [
        "#269 chore(deps): bump foo from 1 to 2",
        "open 45d (>7d), auto-merge on 45d (>48h)",
        "https://github.com/example/repo/pull/269",
      ].join("\n"),
    );
  });

  it("pluralises the title and sends one message for several PRs", () => {
    const n = formatNotification([stalledOne, { ...stalledOne, number: 270 }], "example/repo");
    expect(n?.title).toBe("example/repo: 2 stalled Dependabot PRs");
    expect(n?.message).toContain("#269");
    expect(n?.message).toContain("#270");
  });

  it("cuts the list at the byte budget with an explicit +N more line", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...stalledOne, number: 100 + i }));
    const n = formatNotification(many, "example/repo", { maxBytes: 600 });
    expect(Buffer.byteLength(n!.message)).toBeLessThan(900);
    expect(n!.message).toMatch(/\n\n\+\d+ more$/);
    const shown = (n!.message.match(/^#\d+ /gm) ?? []).length;
    const more = Number(/\+(\d+) more$/.exec(n!.message)?.[1]);
    expect(shown + more).toBe(50);
  });

  it("always shows at least one PR even if it alone exceeds the budget", () => {
    const n = formatNotification([stalledOne], "example/repo", { maxBytes: 1 });
    expect(n?.message).toContain("#269");
  });
});
