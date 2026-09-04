// CONTRACT: stable — coordinate changes.
//
// Request-path provider seam for SYNCHRONOUS image moderation. Mirrors the
// realtime-transport seam (apps/api/src/lib/realtime/index.ts): a consuming app
// (Skybber) calls setMediaModerationProvider() ONCE at startup with its concrete
// cloud adapter, and the upload handler reads it via getMediaModerationProvider()
// on every sync-image request. Core imports no cloud SDK.
//
// FAIL-CLOSED DEFAULT: when no provider has been injected, getMediaModerationProvider()
// returns a NullModerationProvider (every verdict = "review") rather than throwing.
// An un-wired deploy must degrade to REVIEW (never serve, never 500) — a thrown
// error here would turn every image upload into a 500. The startup guard
// (assertModerationProviderAllowed) is the place that loudly refuses to run Null
// outside dev; this seam is the safe runtime fallback.

import {
  type MediaModerationProvider,
  type ModerationVerdict,
  NullModerationProvider,
} from "./moderation-provider.js";
import type {
  LabelPolicy,
  LabelPolicyContext,
} from "./label-policy.js";
import type { ModerationDecision } from "./media-lifecycle.js";

// ---------------------------------------------------------------------------
// Provider-injection hook (mirrors setRealtimeProvider). A consuming app calls
// setMediaModerationProvider() at startup, BEFORE the upload route serves, with
// its concrete provider. getMediaModerationProvider() returns the injected
// provider if present, else a fail-closed Null default.
// ---------------------------------------------------------------------------

let injected: MediaModerationProvider | undefined;

/**
 * Consuming app (Skybber) calls this at startup with its concrete moderation
 * provider (e.g. an AWS Rekognition adapter). MUST run before the upload route
 * serves. Re-exported from `@de-otio/trellis` (apps/api/src/index.ts).
 */
export function setMediaModerationProvider(
  provider: MediaModerationProvider,
): void {
  injected = provider;
}

/**
 * Returns the injected provider if one was registered, else a fail-closed
 * {@link NullModerationProvider} (every verdict = `review`). The upload handler
 * calls this on each sync-image request. Defaulting to Null — rather than
 * throwing — means an un-wired deploy degrades to REVIEW (never serves, never
 * 500), which is the safe behaviour for a moderation seam.
 */
export function getMediaModerationProvider(): MediaModerationProvider {
  return injected ?? new NullModerationProvider();
}

/** Test-only: clear the injected provider so tests don't leak across cases. */
export function __resetMediaModerationProviderForTests(): void {
  injected = undefined;
  injectedPolicy = undefined;
}

// ---------------------------------------------------------------------------
// Label-policy hook.
//
// A provider returns BOTH a decision and its labels. Trusting the decision
// means the provider owns the policy; supplying a label policy means the
// OPERATOR owns it — which category tokens matter, at what confidence, and
// against which taxonomy version. The two are not equivalent, and the second is
// the one an operator can audit and change without asking a vendor.
//
// Optional: with no policy the provider's own decision stands, exactly as
// before. When a policy IS set it is authoritative, and because the policy can
// only ever degrade a verdict (unmapped categories quarantine, an unverifiable
// taxonomy floors at review), turning it on cannot make anything more
// permissive than the provider already was.
// ---------------------------------------------------------------------------

let injectedPolicy: LabelPolicy | undefined;

/**
 * Consuming app calls this at startup to make the operator's label policy
 * authoritative over the provider's own decision. Re-exported from
 * `@de-otio/trellis`.
 */
export function setMediaLabelPolicy(policy: LabelPolicy): void {
  injectedPolicy = policy;
}

/** The operator's label policy, or undefined when the provider's decision stands. */
export function getMediaLabelPolicy(): LabelPolicy | undefined {
  return injectedPolicy;
}

/**
 * Apply the operator's policy to a verdict, or pass the provider's own decision
 * through when no policy is configured. Total: a policy that somehow throws is
 * treated as doubt, and doubt reviews.
 */
export function interpretVerdict(
  verdict: ModerationVerdict,
  context?: LabelPolicyContext,
): ModerationDecision {
  const policy = injectedPolicy;
  if (policy === undefined) return verdict.decision;
  try {
    return policy.decide(verdict, context);
  } catch {
    return "review";
  }
}
