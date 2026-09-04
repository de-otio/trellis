#!/usr/bin/env node
// OpenAPI additivity gate.
//
// Generates the current OpenAPI document from the live route registry and
// compares it against the committed snapshot (`apps/api/openapi.snapshot.json`)
// using the pure classifier in `openapi-additivity-core.mjs`.
//
// Two modes, exposed as npm scripts (see tmp/handoff-T2.md — this task does
// not own package.json):
//   node scripts/check-openapi-additivity.mjs check   (default; CI gate)
//   node scripts/check-openapi-additivity.mjs update   (regenerate snapshot)
//
// Must be invoked through `tsx` (already a devDependency) because it imports
// the TypeScript route registry and generator directly:
//   npx tsx scripts/check-openapi-additivity.mjs check
//
// Exit codes: 0 = clean or additive-only (with a "snapshot is stale" notice);
// 1 = at least one BREAKING finding, or no snapshot exists yet for `check`.
//
// All eight classifier rules are live against real generator output for any
// route that has adopted `requestSchema`/`responseSchema`/`scopes` — see the
// header comment in openapi-additivity-core.mjs. No route in this repo has
// adopted them yet (lane A/G's job), so the schema- and scope-shape rules
// currently have nothing real to fire against; they're proven end-to-end,
// with the real generator (not hand-written fixtures), in
// test/unit/openapi/additivity-gate.test.ts.
//
// PROVISIONAL SNAPSHOT NOTICE: the `openapi.snapshot.json` committed by this
// task is provisional (fan-out race rule, plan §2.3) — and, as of lane B,
// near-empty: `generateOpenApiDoc` omits any route whose `scopes` is still
// undeclared (plan 034 lane B / B.2), which today is every real route.
// T-INT regenerates the canonical snapshot at the integration barrier after
// all sibling route changes (lanes A/G annotating real routes) land.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { classify } from "./openapi-additivity-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "..", "openapi.snapshot.json");

async function generateCurrentDoc() {
  const { generateOpenApiDoc } = await import("../src/lib/openapi/generator.js");
  const { routes } = await import("../src/lib/routes/index.js");
  return generateOpenApiDoc(routes);
}

function printFindings(label, findings) {
  console.log(label);
  for (const f of findings) {
    console.log(`  - [${f.rule}] ${f.detail}`);
  }
}

async function main() {
  const mode = process.argv[2] === "update" ? "update" : "check";
  const doc = await generateCurrentDoc();

  if (mode === "update") {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`Wrote ${SNAPSHOT_PATH}`);
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(
      `No snapshot found at ${SNAPSHOT_PATH}. Run 'node scripts/check-openapi-additivity.mjs update' (via tsx) first.`,
    );
    process.exitCode = 1;
    return;
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const { breaking, additions } = classify(snapshot, doc);

  if (breaking.length > 0) {
    printFindings("BREAKING OpenAPI changes detected (fails the gate):", breaking);
    process.exitCode = 1;
    return;
  }

  if (additions.length > 0) {
    printFindings(
      "OK: only additive OpenAPI changes detected. The committed snapshot is stale — run " +
        "'node scripts/check-openapi-additivity.mjs update' (via tsx) and commit the result:",
      additions,
    );
    return;
  }

  console.log("OK: generated OpenAPI document matches the committed snapshot exactly.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
