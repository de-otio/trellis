import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * CI coverage gate — Surveillance-hardening Phase 0.
 *
 * Why a separate config: the FULL-suite coverage baseline on `main` already
 * passes 80% for statements/lines/functions but sits at ~78% BRANCHES — a
 * pre-existing legacy gap, not introduced by this plan. Wiring the global
 * `test:coverage` (80% branches) straight into CI would fail on day one for
 * reasons unrelated to Phase 0, so the global gate stays a local/aspirational
 * check while the legacy branch gap is paid down separately.
 *
 * To ship a coverage gate that CAN actually fail (README §Test-first: "Do not
 * silently ship a gate that can't fail"), this config enforces the full 80%
 * thresholds on ONLY the NEW source files this plan adds. `all: true` means an
 * untested new file counts as 0% and fails the gate rather than silently
 * escaping it.
 *
 * Each stage appends its new source file(s) to PHASE0_NEW_FILES below.
 *
 * NOTE: this does NOT use vitest's `mergeConfig`, which concatenates the
 * `coverage.include` arrays (re-including all of `src/**`). We spread the base
 * test options and REPLACE `coverage.include` with the scoped list.
 */

const PHASE0_NEW_FILES = [
  // P1 — schema enablers
  "src/lib/feature-toggle-global-client.ts",
  // P2 — interaction event capture
  //   "src/lib/graph/postgres/interaction-events.ts",
  // P3 — signup metadata capture
  //   "src/lib/signup-metadata.ts",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseTest = (base as any).test ?? {};

export default defineConfig({
  test: {
    ...baseTest,
    coverage: {
      ...baseTest.coverage,
      all: true,
      include: PHASE0_NEW_FILES,
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        autoUpdate: false,
      },
    },
  },
});
