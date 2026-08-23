/**
 * C3 — the source scan (plan 031 §8, §4.2, §7.2).
 *
 * Two properties that cannot be tested by running the code, because the thing
 * that makes them dangerous is that the code RUNS FINE while violating them:
 *
 *  1. **No task body catches broadly and returns normally.** A `catch` that
 *     returns is indistinguishable from success at the engine, so "this failed"
 *     silently becomes "this is done" — in a moderation pipeline, content
 *     released or lost without a verdict. There is no runtime assertion that
 *     catches this; the failing run just looks like a successful one.
 *
 *  2. **No code path in the lane can emit `approved`** while the lane ships
 *     closed. `clampEscalatedDecision` is the single place that decision is
 *     made, and the way to keep it single is to assert that nothing else in the
 *     lane so much as names the value.
 *
 * ── WHY THE SCANNER GETS ITS OWN NEGATIVE CONTROLS ─────────────────────────
 *
 * A source scan that finds nothing is indistinguishable from a source scan
 * whose pattern is broken — and the broken one is the one that reports a clean
 * bill of health forever. So every check below is run twice: once over the real
 * files, which must be clean, and once over a synthetic sample that MUST be
 * flagged. If a negative control ever passes, the corresponding real-file
 * assertion has stopped meaning anything.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_DIR = join(HERE, "..", "..", "..", "..", "worker", "src", "moderation");

function laneSources(): ReadonlyArray<{ file: string; source: string }> {
  return readdirSync(LANE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, source: readFileSync(join(LANE_DIR, f), "utf8") }));
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * Extract each `catch` block's body by brace matching.
 *
 * Brace matching rather than a regex because a regex cannot find the END of a
 * block, and a check that only looks at the first line of a catch is a check
 * that misses every interesting case.
 */
export function catchBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(source.slice(m.index + m[0].length, i - 1));
  }
  return blocks;
}

/** Strip line and block comments, so a phrase in prose is never a finding. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * A catch block is a SWALLOW when it neither rethrows nor consults the module
 * that owns the retry/drop decision. Returning from a catch is allowed here
 * exactly once — `runEscalation` returns a typed {@link Disposition} — and the
 * thing that makes it legitimate is that the disposition came from
 * `dispositionForError` rather than from the catch's own judgement.
 */
export function swallowingCatches(source: string): string[] {
  return catchBlocks(stripComments(source)).filter((body) => {
    const rethrows = /\bthrow\b/.test(body);
    const classifies = /\bdispositionFor\w*\s*\(/.test(body);
    const returns = /\breturn\b/.test(body);
    if (!returns) return false; // falls through — not a swallow
    return !rethrows && !classifies;
  });
}

/** Any literal `approved` outside a comment. */
export function namesApproved(source: string): boolean {
  return /["'`]approved["'`]/.test(stripComments(source));
}

// ---------------------------------------------------------------------------
// 1. No task body catches broadly and returns normally
// ---------------------------------------------------------------------------

describe("C3 — no task body swallows an error", () => {
  it("the real lane sources are clean", () => {
    for (const { file, source } of laneSources()) {
      expect(swallowingCatches(source), `${file} swallows an error in a catch`).toEqual([]);
    }
  });

  it("the durable task body contains NO catch at all", () => {
    // The registration's `fn` must not decide anything about errors. The
    // decision is made once, by `dispositionForError`, and the body's only job
    // is to turn `fail` into a throw. A catch here would be a second, quieter
    // policy.
    const registration = laneSources().find((s) => s.file === "axis-a-escalate.ts");
    expect(registration).toBeDefined();
    expect(catchBlocks(stripComments(registration!.source))).toEqual([]);
  });

  it("the one catch that does exist consults the classifier", () => {
    const body = laneSources().find((s) => s.file === "escalation-run.ts");
    expect(body).toBeDefined();
    const blocks = catchBlocks(stripComments(body!.source));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/dispositionForError\s*\(/);
  });

  it("NEGATIVE CONTROL: a bare swallow is flagged", () => {
    const bad = `
      async function task() {
        try { await work(); } catch { return { outcome: "ack" }; }
      }`;
    expect(swallowingCatches(bad)).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: a log-and-return swallow is flagged", () => {
    // The most common shape, and the most convincing one — it looks like
    // handling because something was written to a log.
    const bad = `
      async function task() {
        try { await work(); } catch (err) {
          logger.error("escalation failed", { err });
          return { outcome: "ack-drop" };
        }
      }`;
    expect(swallowingCatches(bad)).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: a rethrow is NOT flagged", () => {
    const ok = `try { await work(); } catch (err) { logger.error("x"); throw err; }`;
    expect(swallowingCatches(ok)).toEqual([]);
  });

  it("NEGATIVE CONTROL: a classified return is NOT flagged", () => {
    const ok = `try { await work(); } catch (err) { return dispositionForError(err); }`;
    expect(swallowingCatches(ok)).toEqual([]);
  });

  it("the brace matcher finds the END of a block, not just its start", () => {
    // A scanner that reads only the first line of a catch misses everything
    // interesting. This is the check that the matcher actually spans the body.
    const src = `try { a(); } catch (e) { if (x) { nested(); } return 1; }`;
    const blocks = catchBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("nested()");
    expect(blocks[0]).toContain("return 1");
    expect(blocks[0]).not.toContain("a()");
  });

  it("prose in a comment is never a finding", () => {
    const ok = `
      // This function must never catch broadly and return normally.
      /* A catch { return } here would be a swallow. */
      async function task() { return work(); }`;
    expect(swallowingCatches(ok)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The lane cannot emit `approved`
// ---------------------------------------------------------------------------

describe("C3 — the lane ships unable to approve", () => {
  it("no lane source names the value `approved` at all", () => {
    // Not "does not currently emit it" — does not NAME it. The only place the
    // decision is made is `clampEscalatedDecision`, in core, under test. Keeping
    // the token out of the lane entirely is what makes that single place stay
    // single.
    for (const { file, source } of laneSources()) {
      expect(namesApproved(source), `${file} names "approved"`).toBe(false);
    }
  });

  it("the body DOES run the clamp — absence is not the same as safety", () => {
    // The check above passes trivially on a file that never decides anything.
    // This is what distinguishes "does not name approved because it clamps" from
    // "does not name approved because it forgot to look".
    const body = laneSources().find((s) => s.file === "escalation-run.ts");
    expect(stripComments(body!.source)).toMatch(/clampEscalatedDecision\s*\(/);
  });

  it("NEGATIVE CONTROL: a source that names `approved` is flagged", () => {
    expect(namesApproved(`const d = "approved";`)).toBe(true);
    expect(namesApproved(`if (v === 'approved') release();`)).toBe(true);
    expect(namesApproved("const d = `approved`;")).toBe(true);
  });

  it("NEGATIVE CONTROL: the word in a comment is NOT flagged", () => {
    expect(namesApproved(`// the lane must never return "approved" while closed`)).toBe(false);
    expect(namesApproved(`/* permitted outcomes exclude "approved" */`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The scan has something to scan
// ---------------------------------------------------------------------------

describe("C3 — the scan is not vacuous", () => {
  it("finds the lane's sources", () => {
    // A scan over an empty directory passes every assertion above. If the lane
    // is ever moved or renamed, this fails rather than silently going quiet.
    const files = laneSources().map((s) => s.file).sort();
    expect(files).toEqual(["axis-a-escalate.ts", "escalation-run.ts"]);
  });

  it("the sources are non-trivial", () => {
    for (const { file, source } of laneSources()) {
      expect(stripComments(source).trim().length, `${file} is empty`).toBeGreaterThan(500);
    }
  });
});
