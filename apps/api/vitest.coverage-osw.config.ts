import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Coverage gate — Open Social Web (follow-by-email, collections, year-in-review).
 *
 * Same mechanism as `vitest.coverage-ci.config.ts`: the full-suite branch
 * baseline sits below 80% for pre-existing legacy reasons, so instead of a
 * global gate that fails on day one for unrelated code, this enforces the full
 * 80% thresholds on ONLY the NEW logic files this plan adds. `all: true` means
 * an untested new file counts as 0% and fails the gate rather than escaping it
 * (README §Test-first: "Do not silently ship a gate that can't fail").
 *
 * Thin route wrappers (routes/email-subscriptions.ts, routes/collections.ts,
 * routes/recap.ts) are intentionally excluded — matching the PHASE0 precedent,
 * they are declarative Route[] arrays covered by route-mount-parity + e2e, not
 * unit coverage. The gated set is the behavioral logic.
 */

const OPEN_SOCIAL_WEB_NEW_FILES = [
  // follow-by-email
  "src/lib/field-encryption.ts",
  "src/lib/email-subscription-token.ts",
  "src/lib/email-subscription-handler.ts",
  "src/lib/email/templates/confirm.ts",
  "src/lib/email/templates/unsubscribe.ts",
  "src/lib/feature-gate-middleware.ts",
  // collections
  "src/lib/collection-handler.ts",
  // year-in-review
  "src/lib/recap-service.ts",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseTest = (base as any).test ?? {};

export default defineConfig({
  test: {
    ...baseTest,
    coverage: {
      ...baseTest.coverage,
      all: true,
      include: OPEN_SOCIAL_WEB_NEW_FILES,
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
