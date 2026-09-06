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
  "src/lib/graph/postgres/interaction-events.ts",
  // P3 — signup metadata capture
  "src/lib/signup-metadata.ts",
  // R1 — Events primitive (new source files)
  "src/lib/events/seams.ts",
  "src/lib/events/event-core.ts",
  "src/lib/events/event-visibility.ts",
  "src/lib/events/event-handler.ts",
  "src/lib/events/rsvp-handler.ts",
  "src/lib/events/shift-handler.ts",
  "src/lib/events/event-notifications.ts",
  "src/lib/events/post-feed-announcer.ts",
  "src/lib/routes/events.ts",
  // O-1 — extension-owned schema mechanism (Phase 3 coverage gate)
  "src/lib/extension-scoped-db.ts",
  "src/lib/extension-schema-composer.ts",
  "src/lib/extension-job-runner.ts",
  "src/lib/mint-tenant-id.ts",
  // AI Act Art. 50 — synthetic-content provenance. The pure cores, all of which
  // are at or near 100%; listing them here is what stops that eroding, since a
  // disclosure that silently stops being computed is the failure mode with legal
  // consequences rather than merely a broken feature.
  //
  // `src/lib/routes/provenance-correction.ts` now has its own route-level
  // suite too (test/unit/routes/provenance-correction.test.ts) — see the
  // entry near the end of this list. Its pure decision logic lives in
  // provenance/correction.ts, listed here since before.
  "src/lib/provenance/types.ts",
  "src/lib/provenance/resolve.ts",
  "src/lib/provenance/response.ts",
  "src/lib/provenance/posture.ts",
  "src/lib/provenance/posture-gate.ts",
  "src/lib/provenance/correction.ts",
  "src/lib/provenance/metrics.ts",
  "src/lib/metadata/provenance-reader.ts",
  "src/lib/activitypub/provenance-jsonld.ts",
  // Evolvability mechanisms — forced-upgrade version policy (T7). T9's
  // feature-flags `platform` block and T5's extensionApiVersion startup
  // check are existing-file edits (routes/feature-flags.ts,
  // feature-flags.ts, extension-validator.ts, extension.ts) — the whole-file
  // `include` mechanism here isn't diff-aware, so whitelisting an
  // already-large existing file would gate on code this plan didn't touch;
  // those edits are covered by their own suites but not added to this list.
  "src/lib/client-version.ts",
  "src/lib/routes/app-meta.ts",
  // Media-moderation seam flexibility — the NEW modules only. Each carries its
  // own per-file bar below rather than hiding inside the aggregate, because
  // these are the modules that decide whether media is served: an aggregate
  // that stays green while one of them rots is not a gate.
  //
  // The CHANGED existing files (media-completion.ts, media-ports.ts,
  // media-review-handler.ts, classify-worker-error.ts, routes/media.ts,
  // workers/media-processing.ts) are deliberately NOT listed: this mechanism
  // is whole-file, not diff-aware, so adding them would gate on a great deal of
  // code this change never touched.
  "src/lib/media/label-policy.ts",
  "src/lib/media/frame-aggregation.ts",
  "src/lib/media/frame-sampling-adapter.ts",
  "src/lib/media/completion-envelope.ts",
  "src/lib/media/moderation-deadline.ts",
  "src/lib/media/moderation-metrics.ts",
  "src/lib/media/media-bytes-access.ts",
  "src/lib/media/promote-staging.ts",
  // Previously zero-reference modules (no test file imported them). Each now
  // has a direct unit suite (100% branches locally; see the matching
  // test/unit path) rather than only incidental coverage from callers' tests.
  "src/lib/routes/provenance-correction.ts",
  "src/lib/media/scaleway-vision-shared.ts",
  "src/lib/events/extension-emitter.ts",
  "src/lib/routes/admin-costs.ts",
  "src/lib/routes/email-subscriptions.ts",
  "src/lib/extension-read-delegate.ts",
  // Zero-runtime-footprint compile-time contract (`export {}`) — the gate
  // here is vacuous (0 executable statements), the real gate is `tsc
  // --build`. Listed so a FUTURE accidental runtime export is caught by
  // this gate too, not just by someone noticing.
  "src/lib/extension-dto-contract.ts",
];

/**
 * Per-file bars for the modules above, stricter than the repo-wide aggregate
 * (which sits at 80/80/80/78). The three PURE decision modules — how labels
 * become a verdict, how frames become a video's verdict, how an untrusted body
 * becomes a pointer — are held higher still: they have no I/O to excuse a gap,
 * and an untested branch in one of them is an untested way to approve media.
 */
const DECISION_MODULE_THRESHOLDS = {
  "src/lib/media/label-policy.ts": {
    lines: 90,
    functions: 90,
    branches: 90,
    statements: 90,
  },
  "src/lib/media/frame-aggregation.ts": {
    lines: 90,
    functions: 90,
    branches: 90,
    statements: 90,
  },
  "src/lib/media/completion-envelope.ts": {
    lines: 90,
    functions: 90,
    branches: 90,
    statements: 90,
  },
  "src/lib/media/frame-sampling-adapter.ts": {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
  "src/lib/media/moderation-deadline.ts": {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
  "src/lib/media/moderation-metrics.ts": {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
  "src/lib/media/media-bytes-access.ts": {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
  "src/lib/media/promote-staging.ts": {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
};

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
        ...DECISION_MODULE_THRESHOLDS,
      },
    },
  },
});
