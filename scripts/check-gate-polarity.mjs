#!/usr/bin/env node
// Fail the build when a gate whose purpose is to RESTRICT produces its most
// permissive answer from absence, error, or an unrecognised value.
//
// WHY THIS EXISTS
// ---------------
// The alpha.15 quality sweep found the same habit in several places written by
// authors who never saw each other's work: an age tier that defaults to ADULT,
// a scope declaration whose absence skipped the gate, an `auth` value compared
// only against the strict literal so `"optional"` slid past, an unknown `auth`
// string treated as optional, and a block class whose absence reads as
// appealable. None is a typo; each is what you get when you write
// `x ?? default` without asking which direction "default" points.
//
// Fail-open is a SEMANTIC property, so this checker does not try to infer it.
// It carries a hand-maintained REGISTRY of restricting vocabularies — the
// enums and fields whose values are ordered from most-restrictive to
// most-permissive — and then applies five syntactic rules that each describe
// one way a permissive value is manufactured out of absence. Adding a new
// gate means adding its vocabulary here; that is the point, not a cost.
//
// A finding is not forbidden. It has to be DELIBERATE. Say so on the line, or
// on the line above:
//
//   return toggle?.enabled ?? true; // gate-polarity-ok: safety gate, ON is
//                                   // the restrictive answer (moderate)
//
// The marker requires a reason after the colon. That converts a silent default
// into a decision someone signed, and makes every one of them greppable.
//
// Usage: node scripts/check-gate-polarity.mjs [root ...]
//        (default roots: apps/api/src apps/worker/src)
//
// The rule engine is exported and unit-tested against inline fixtures in
// `apps/api/test/unit/scripts/check-gate-polarity.test.ts` — a checker nobody
// has watched fail is not a checker. The CLI half only runs on direct
// execution, so importing this file walks nothing and exits nothing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_ROOTS = ["apps/api/src", "apps/worker/src"];

export const ALLOW_MARKER = /gate-polarity-ok:\s*\S/;

// ───────────────────────────────────────────────────────────────────────────
// The registry. Every entry is a vocabulary whose values are ORDERED, least
// permissive first. `permissive` is what must never be reached by accident.
// ───────────────────────────────────────────────────────────────────────────
export const VOCABULARIES = [
  {
    name: "AgeTier",
    idents: /age.?tier/i,
    values: ['"CHILD"', '"TEEN"', '"ADULT"'],
    permissive: ['"ADULT"'],
    strictest: '"CHILD"',
  },
  {
    name: "ScopeSet",
    idents: /scopes?\b/i,
    values: ['"*"'],
    permissive: ['"*"'],
    strictest: null,
  },
  {
    name: "RouteAuthLevel",
    idents: /auth(Level)?\b/i,
    // Least permissive first, like every other entry — `values[0]` and
    // `strictest` are the same fact, and the registry test asserts they agree.
    values: ['"required"', '"optional"', '"none"'],
    permissive: ['"none"', '"optional"'],
    strictest: '"required"',
  },
  {
    name: "BlockClass",
    idents: /block.?class/i,
    values: ['"illegal-suspected"', '"lawful-flagged"', "null"],
    permissive: ["null", "undefined"],
    strictest: '"illegal-suspected"',
  },
  {
    name: "UserRole/TenantRole",
    idents: /\brole\b/i,
    values: ['"GUEST"', '"MEMBER"', '"ADMIN"', '"OWNER"', '"SUPER_ADMIN"'],
    permissive: ['"OWNER"', '"SUPER_ADMIN"', '"ADMIN"'],
    strictest: '"GUEST"',
  },
];

// Identifiers that mark a value as gate-carrying, for the boolean rules where
// there is no enum to key on.
const GATE_IDENT =
  /\b(allow|can|may|is[A-Z]|enabled|permit|granted|appeal|visible|public|bypass|access|bypassed|unrestricted)\w*/;

// The gate functions whose call must not be optional.
const GATE_CALL =
  /\b(requireScope|requireCapability|requireRole|requireFirstParty|requireAuth|assertScope|assertCapability)\s*\(/;

// Every rule appends through this, so a rule never sees module state and
// `analyzeSource` is a pure function of (file, src).
function flag(findings, rule, file, line, text, why) {
  findings.push({ rule, file, line, text: text.trim(), why });
}

// ───────────────────────────────────────────────────────────────────────────
// R1 — PERMISSIVE-DEFAULT. `x ?? P` / `x || P` where P is a permissive member
//      of a registered vocabulary, or `true` on a gate-shaped identifier.
// ───────────────────────────────────────────────────────────────────────────
function r1(findings, file, lines) {
  const re = /(\?\?|\|\|)\s*(("[^"]*")|true|null|undefined)/g;
  lines.forEach((raw, i) => {
    for (const m of raw.matchAll(re)) {
      const lit = m[2];
      // The identifier chain immediately to the left of the operator. A bare
      // `?? null` on a DTO field is not a gate; `blockClass ?? null` is. The
      // registry decides, so the checker never guesses.
      const lhs = raw.slice(0, m.index);
      const tail = /([A-Za-z0-9_$.[\]"']+)\s*$/.exec(lhs)?.[1] ?? "";
      // For a distinctive STRING literal (`"ADULT"`, `"*"`, `"none"`) the whole
      // left-hand side is searched, so a cast — `(claims["custom:ageTier"] as
      // AgeTier) || "ADULT"` — is still matched. `null`/`undefined` are far too
      // common to search loosely, so those need the tight adjacent-token match.
      const loose = /^"/.test(lit) ? lhs.slice(-80) : tail;
      const hit = VOCABULARIES.find(
        (v) => v.permissive.includes(lit) && v.idents.test(loose),
      );
      if (hit) {
        flag(
          findings,
          "R1",
          file,
          i + 1,
          raw,
          `${hit.name}: absence defaults to the permissive ${lit}`,
        );
      } else if (lit === "true" && GATE_IDENT.test(tail)) {
        flag(findings, "R1", file, i + 1, raw, "gate-shaped flag defaults to true");
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// R2 — SWITCH WITHOUT `default`. A `switch` over a gate-shaped discriminant
//      that falls through to `undefined`.
// ───────────────────────────────────────────────────────────────────────────
function r2(findings, file, lines, src) {
  const re = /switch\s*\(\s*([A-Za-z0-9_.?]+)\s*\)\s*\{/g;
  for (const m of src.matchAll(re)) {
    const ident = m[1];
    const gateish =
      VOCABULARIES.some((v) => v.idents.test(ident)) || GATE_IDENT.test(ident);
    if (!gateish) continue;
    // Walk balanced braces from the `{`.
    let depth = 0;
    let end = -1;
    for (let p = m.index + m[0].length - 1; p < src.length; p++) {
      if (src[p] === "{") depth++;
      else if (src[p] === "}") {
        depth--;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    const body = src.slice(m.index, end);
    if (/^\s*default\s*:/m.test(body)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    flag(
      findings,
      "R2",
      file,
      line,
      lines[line - 1] ?? "",
      `switch on \`${ident}\` has no default:`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// R3 — NEGATIVE GATE. `x !== "<strictest>"` as the whole answer: everything
//      the checker has never heard of gets the permissive result.
// ───────────────────────────────────────────────────────────────────────────
function r3(findings, file, lines) {
  lines.forEach((raw, i) => {
    for (const v of VOCABULARIES) {
      if (!v.strictest) continue;
      const re = new RegExp(
        `return\\s+[^;]*!==?\\s*${v.strictest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );
      if (re.test(raw)) {
        flag(
          findings,
          "R3",
          file,
          i + 1,
          raw,
          `deny-only comparison against ${v.name}'s strictest value; every other value passes`,
        );
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// R4 — STRICT-LITERAL GUARD. A denial guarded by `=== "<strictest>"` on a
//      3+-value vocabulary: the middle members are unhandled.
// ───────────────────────────────────────────────────────────────────────────
const DENIAL =
  /\b(401|403|Unauthorized|Forbidden|forbidden\(|throw new \w*(Error|Denied)|INSUFFICIENT|NOT_PERMITTED)\b/;

function r4(findings, file, lines) {
  lines.forEach((raw, i) => {
    for (const v of VOCABULARIES) {
      if (!v.strictest || v.values.length < 3) continue;
      const lit = v.strictest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Only a guard whose BODY is a denial is fail-open: the strict literal
      // is the only value that gets refused, so every other one walks through.
      // A guard whose body RESTRICTS (`if (tier === "CHILD") hideThings()`) is
      // the correct polarity and must not be flagged.
      const body = lines.slice(i, i + 5).join("\n");
      if (!DENIAL.test(body)) continue;
      if (new RegExp(`===\\s*${lit}`).test(raw) && /\bif\s*\(/.test(raw)) {
        flag(
          findings,
          "R4",
          file,
          i + 1,
          raw,
          `gate keyed on ${v.name}'s strictest literal only; ${v.values
            .filter((x) => x !== v.strictest)
            .join("/")} are ungated`,
        );
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// R5 — GATE UNDER A TRUTHINESS TEST. A `require*` call whose only reason to
//      run is that a declaration was present. Absence therefore skips the
//      gate.
// ───────────────────────────────────────────────────────────────────────────
function r5(findings, file, lines) {
  lines.forEach((raw, i) => {
    if (!GATE_CALL.test(raw)) return;
    for (let back = 1; back <= 6 && i - back >= 0; back++) {
      const prev = lines[i - back];
      // Must be a block OPENER — a completed one-line `if (x) return x;` above
      // the gate does not enclose it.
      if (!/\bif\s*\(.*\)\s*\{\s*$/.test(prev)) continue;
      const test = prev.slice(prev.indexOf("if ("));
      // A comparison is a decision; a bare truthiness test is an omission.
      if (/===|!==|instanceof|typeof|undefined|null/.test(test)) break;
      if (
        /&&|\.length|\?\./.test(test) ||
        /\bif\s*\(\s*[A-Za-z0-9_.]+\s*\)/.test(test)
      ) {
        flag(
          findings,
          "R5",
          file,
          i + 1,
          raw,
          `gate runs only when \`${test.trim()}\` is truthy`,
        );
      }
      break;
    }
  });
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "dist")
        continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.(test|spec|test-d)\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Run all five rules over one source string and return the surviving findings.
 *
 * `file` is only a label for the report, so a caller can pass a fixture name.
 * Filtering happens here, against the same `lines`, rather than by re-reading
 * the file from disk: that is what makes this callable on a string.
 */
export function analyzeSource(file, src) {
  const lines = src.split("\n");
  const findings = [];
  r1(findings, file, lines);
  r2(findings, file, lines, src);
  r3(findings, file, lines);
  r4(findings, file, lines);
  r5(findings, file, lines);

  // Comment lines and annotated lines are not findings. The marker has to sit
  // ON the flagged line or DIRECTLY above it — a reason three lines up is prose
  // about the code, not a signature on this line.
  return findings.filter((f) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(f.text)) return false;
    const here = lines[f.line - 1] ?? "";
    const above = lines[f.line - 2] ?? "";
    return !(ALLOW_MARKER.test(here) || ALLOW_MARKER.test(above));
  });
}

/** Findings across every non-test `.ts` file under `roots`. */
export function scanTree(roots = DEFAULT_ROOTS) {
  const files = [];
  for (const root of roots) {
    try {
      walk(root, files);
    } catch {
      /* root absent in this checkout */
    }
  }
  const findings = files.flatMap((file) =>
    analyzeSource(relative(process.cwd(), file), readFileSync(file, "utf8")),
  );
  return { files, findings };
}

const isDirectExecution =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;
  const { files, findings } = scanTree(roots);
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  [${f.rule}] ${f.why}\n    ${f.text}`);
  }
  console.log(`\n${findings.length} finding(s) across ${files.length} file(s).`);
  if (findings.length > 0) {
    console.log(
      "\nA gate that answers permissively on absence, error or an unrecognised\n" +
        "value must deny instead. If a default really is the RESTRICTIVE answer,\n" +
        "say so on the line or the line above:\n" +
        "  // gate-polarity-ok: <why this direction is the closed one>",
    );
  }
  process.exit(findings.length === 0 ? 0 : 1);
}
