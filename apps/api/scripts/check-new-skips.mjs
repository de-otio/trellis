#!/usr/bin/env node
/**
 * CI gate (AR14): fail when a NEW unconditional `.skip(`/`.only(` is
 * introduced into the test suite.
 *
 * Why: 30 of 550 trellis test files carried a `.skip` before this gate
 * existed, which corrupts "green = verified" — a suite can go fully green
 * while a real bug's regression test sits disabled. The fix is a triage
 * (see test/skip-baseline.json) plus this gate so the inventory can only
 * shrink or move deliberately (baseline + code change in the same diff),
 * never grow silently.
 *
 * What counts as a "dead skip" this gate catches:
 *   it.skip(...), test.skip(...), describe.skip(...),
 *   it.only(...), test.only(...), describe.only(...)
 *
 * What this gate intentionally IGNORES (legitimate guards, not dead skips):
 *   - `describe.skipIf(cond)(...)` / `it.skipIf(cond)(...)` / `.runIf(cond)` —
 *     a different method name (`skipIf`/`runIf`), never matched by the
 *     `(skip|only)\(` pattern below.
 *   - `const suite = TEST_DB_URL ? describe : describe.skip;` — the bare
 *     `describe.skip` reference here has no trailing `(`, so it can't match
 *     the call-form pattern either. This is the pattern AR14's brief calls
 *     out explicitly as legitimate (opt-in DB integration suites, incl. the
 *     graph suites AR8 owns) — left alone on purpose.
 *
 * `.only(` is NEVER accepted, baseline or not — see checkSite() below.
 *
 * Usage: node apps/api/scripts/check-new-skips.mjs
 * Exit code 0 = no new unconditional skip/only. Exit code 1 = new site(s)
 * found (printed to stderr) or `.only(` found anywhere.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, "..");
const TEST_DIR = join(API_DIR, "test");
const BASELINE_PATH = join(TEST_DIR, "skip-baseline.json");

// Matches it.skip(, test.skip(, describe.skip(, it.only(, test.only(,
// describe.only( — requires the literal open-paren so skipIf/runIf and the
// bare-reference ternary pattern never match.
const SITE_PATTERN = /\b(it|test|describe)\.(skip|only)\(/;
// First quoted string literal after the match — used as a stable name key
// (robust to line-number drift from reformatting), scanning forward a few
// lines to cover multi-line call signatures like:
//   it.skip(
//     `serves the public site at ${CUSTOM_DOMAIN}`,
const NAME_PATTERN = /(["'`])((?:\\.|(?!\1).)*)\1/;
const LOOKAHEAD_LINES = 5;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(test|spec)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function findSites(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SITE_PATTERN);
    if (!m) continue;
    const kind = m[2]; // 'skip' | 'only'
    let name = null;
    for (let j = i; j < Math.min(lines.length, i + LOOKAHEAD_LINES); j++) {
      const nm = lines[j].match(NAME_PATTERN);
      if (nm) {
        name = nm[2];
        break;
      }
    }
    sites.push({
      file: relative(API_DIR, filePath).split("\\").join("/"),
      line: i + 1,
      kind,
      name: name ?? `<no string literal within ${LOOKAHEAD_LINES} lines>`,
    });
  }
  return sites;
}

function loadBaseline() {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return raw.accepted ?? [];
}

function key(site) {
  return `${site.file}::${site.kind}::${site.name}`;
}

function main() {
  const files = walk(TEST_DIR);
  const found = files.flatMap(findSites);
  const baseline = loadBaseline();
  const baselineKeys = new Set(baseline.map(key));

  const onlySites = found.filter((s) => s.kind === "only");
  const skipSites = found.filter((s) => s.kind === "skip");

  const newSkips = skipSites.filter((s) => !baselineKeys.has(key(s)));

  const foundKeys = new Set(found.map(key));
  const goneFromBaseline = baseline.filter((b) => !foundKeys.has(key(b)));

  let failed = false;

  if (onlySites.length > 0) {
    failed = true;
    console.error(
      `\n::error::${onlySites.length} \`.only(\` site(s) found. \`.only\` must never be committed — it silently disables every other test in the run.\n`,
    );
    for (const s of onlySites) {
      console.error(`  ${s.file}:${s.line}  ${s.kind}("${s.name}")`);
    }
  }

  if (newSkips.length > 0) {
    failed = true;
    console.error(
      `\n::error::${newSkips.length} new unconditional \`.skip(\` site(s) found that are not in test/skip-baseline.json.\n`,
    );
    console.error(
      "If this skip is legitimate, add an entry to test/skip-baseline.json in the",
    );
    console.error(
      "same PR (file, kind, name, and a one-line reason) — do not silently",
    );
    console.error(
      "grow the skip inventory. Prefer fixing or deleting the test instead.\n",
    );
    for (const s of newSkips) {
      console.error(`  ${s.file}:${s.line}  ${s.kind}("${s.name}")`);
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `OK: ${skipSites.length} baseline-accepted skip(s), 0 new, 0 \`.only(\` sites.`,
  );
  if (goneFromBaseline.length > 0) {
    console.log(
      `\nNote: ${goneFromBaseline.length} baseline entr${goneFromBaseline.length === 1 ? "y" : "ies"} no longer found in the suite (fixed or deleted?). Consider pruning test/skip-baseline.json:`,
    );
    for (const b of goneFromBaseline) {
      console.log(`  ${b.file}  ${b.kind}("${b.name}")`);
    }
  }
}

main();
