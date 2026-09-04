/**
 * cascade-route.ts — pure functional core: decide WHERE an axis-A verdict is
 * settled, not what it says.
 *
 * The axis-A classifier is a two-stage cascade. A cheap scorer runs inline;
 * where its confidence `q̂` clears an operator-set threshold `τ` the verdict
 * settles there. Where it does not, today's only option is `REVIEW` — a queue
 * nobody drains (Decision 10 removed the standing moderator), so "uncertain" is
 * currently a content-LOSS path: the upload sits behind a "processing…"
 * placeholder forever. The deferred lane (`axis-a-escalate`, plan 031) converts
 * uncertain into a slower ANSWER, and this module is its trigger.
 *
 * THIS MODULE DECIDES NOTHING ABOUT THE CONTENT. It returns either "settle with
 * the decision you already have" or "escalate" — never a verdict of its own,
 * never a lifecycle write, never `REVIEW`. Plan 031 §2 is explicit that setting
 * `REVIEW` at trigger time and upgrading later is both a user-visible state flap
 * and a row in the un-drained queue for the whole escalation window.
 *
 * ── τ, AND WHY IT IS NOT IN THIS FILE ──────────────────────────────────────
 *
 * `moderation-deadline.ts` already states the rule for the neighbouring knob and
 * the argument transfers without a word changed: a threshold compiled into a
 * PUBLIC npm tarball is a PUBLISHED threshold. A published τ tells an adversary
 * exactly how confident a cheap verdict must look to avoid the slow model — and,
 * read the other way, exactly how much uncertain content to push to drive spend.
 * So {@link createCascadeRoute} REFUSES to construct without an operator-supplied
 * τ. Absence is a wiring error, not an invitation to invent one.
 *
 * WHICH DIRECTION τ POINTS. Escalation happens when `q̂ < τ`. So τ is "the
 * confidence a cheap verdict must reach to be trusted on its own", and RAISING
 * it escalates MORE, not less. That is the operator's cost dial, and it has two
 * meaningful endpoints:
 *
 *   - `τ = 0` — nothing ever escalates. The lane is off by configuration and
 *     every path degrades to today's behaviour. This is a supported posture, not
 *     a broken one, and it is the safe value to ship before the slow-model
 *     provider is chosen (plan 031 §7.1 — `axis-a-escalate` is still
 *     `DECLARED-UNFILLED`).
 *   - τ above every confidence the provider can report — every grey-band verdict
 *     escalates. Bounded by the per-tenant rate limit and the daily spend cap,
 *     not by this module.
 *
 * ── WHAT ESCALATES, AND WHAT DELIBERATELY DOES NOT ─────────────────────────
 *
 * `review` is not one situation, it is several wearing the same hat, and the
 * expensive mistake is treating them alike. The ground comes from the policy
 * itself ({@link explainFromLabels}) rather than being re-derived here, because
 * two readings of one policy is how the two drift apart.
 *
 * ESCALATES — doubt about the CONTENT, which a better look can resolve:
 *   - `over-review-bar` — a mapped label in the grey band. The real case.
 *   - `unreadable-confidence` — the category matters and the degree is
 *     unreadable. `q̂ = 0`: an unreadable confidence is not a low number, it is
 *     the absence of one, and treating it as anything else invents information.
 *   - `provider-floor` at `review` — the seam's fail-closed contract is
 *     `{ decision: "review", labels: [] }`, so an internally-faulted cheap
 *     scorer looks exactly like this. `q̂ = 0`. This is the case with the most
 *     value in it: the cheap path produced nothing at all, and today that is
 *     guaranteed content loss.
 *
 * DOES NOT ESCALATE — and each of these is a decision, not an omission:
 *   - `taxonomy-pin-failed`. A configuration fault, and re-classifying does not
 *     fix it. Worse, it CANNOT: see the pin trap below.
 *   - `malformed-verdict`. Poison-shaped. Nothing about paying more to re-read
 *     the same unusable bytes changes them.
 *   - `unmapped-category` / `over-quarantine-bar` — already `quarantine`. The
 *     lane cannot approve (plan 031 §7.2), so escalating a quarantine could only
 *     ever confirm it: pure cost, no possible change in outcome.
 *   - `clean` — `approved` is not a dead end, and the lane exists for dead ends.
 *     Escalating approvals would catch UNDER-blocks, which is genuinely the
 *     weakest side of the current calibration — but it would also put a
 *     reasoning-model call behind every successful upload. Scoped out of v1
 *     deliberately, and revisitable against the calibration's numbers rather
 *     than against this comment.
 *
 * ⚠ THE PIN TRAP, which plan 031 does not cover and which decides whether this
 * lane can work at all. Under `pinMode: "config"` the operator names the exact
 * taxonomy version their category map was written for. The escalation runs a
 * DIFFERENT model, which reports a DIFFERENT version — so if the deferred
 * lane's verdict is interpreted by the INLINE lane's policy, it can never clear
 * the pin, floors at `review`, and the entire lane resolves to the outcome it
 * was built to avoid while reporting no errors at all. **The deferred lane needs
 * its own {@link LabelPolicy} instance, pinned to the slow model's taxonomy.**
 * That is a wiring requirement on whoever configures the lane; this module
 * cannot enforce it, so it is stated here and asserted where the config is
 * built.
 *
 * PURITY: no I/O, no clock, no randomness, and no numbers of its own.
 */

import type { ModerationDecision } from "./media-lifecycle.js";
import type { ModerationVerdict } from "./moderation-provider.js";
import {
  explainFromLabels,
  type LabelPolicyConfig,
  type LabelPolicyContext,
  type LabelPolicyExplanation,
  type LabelPolicyGround,
} from "./label-policy.js";

/**
 * Why a verdict was escalated. Reported on every escalation so the lane's
 * primary metric — plan 031 §6's shed rate, per cause — can be attributed
 * without re-deriving anything.
 */
export type EscalationCause =
  /** A mapped label in the grey band, below τ. The intended case. */
  | "grey-band"
  /** A mapped category whose confidence could not be read. */
  | "unreadable-confidence"
  /** The cheap scorer returned no usable signal — including its fail-closed shape. */
  | "provider-abstained";

/** Why a verdict was NOT escalated. Same purpose, opposite branch. */
export type SettleReason =
  /** `q̂ >= τ`: the cheap scorer is trusted on its own. */
  | "confident"
  /** Already `approved` or `quarantine` — a decision, not a dead end. */
  | "decided"
  /** The taxonomy pin failed. A config fault; escalation cannot fix it. */
  | "taxonomy-unpinned"
  /** The verdict was unusable. Poison-shaped. */
  | "malformed"
  /** τ is 0, or the lane is switched off. Degrades to today's behaviour. */
  | "lane-closed";

/**
 * Where this verdict is settled.
 *
 * `settle` carries the decision the caller ALREADY has — this module never
 * computes one. `escalate` carries no decision at all, because the escalation
 * has not happened yet and the job must stay open (plan 031 §2).
 */
export type CascadeRoute =
  | {
      readonly kind: "settle";
      readonly decision: ModerationDecision;
      readonly reason: SettleReason;
    }
  | {
      readonly kind: "escalate";
      /** `q̂`, on the provider's own scale. Never rescaled. */
      readonly confidence: number;
      readonly cause: EscalationCause;
    };

/** Thrown at wiring time when the route is unusable. Never thrown per-verdict. */
export class CascadeRouteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeRouteConfigError";
  }
}

/**
 * The operator-supplied cascade config. Both values come from runtime config;
 * neither has a default in this file.
 */
export interface CascadeRouteConfig {
  /**
   * τ — the confidence a cheap verdict must reach to settle inline, expressed
   * on the SAME scale the provider reports confidences on and the category bars
   * are written in. Core never rescales, because a rescale is a policy decision
   * disguised as arithmetic.
   *
   * Must be a finite, non-negative number. `0` disables escalation entirely.
   */
  readonly tau: number;
  /**
   * The master switch. `false` routes everything to `settle` with
   * `"lane-closed"` — the plan 031 §6 degradation row, reached by configuration
   * rather than by deleting code.
   */
  readonly enabled: boolean;
}

export interface CascadeRouter {
  /** Route one verdict. Total: never throws, for any verdict shape. */
  route(verdict: ModerationVerdict, context?: LabelPolicyContext): CascadeRoute;
  /** True when this route can never escalate, whatever arrives. */
  readonly inert: boolean;
}

/**
 * Build a cascade route, or refuse.
 *
 * Refuses when τ is absent, non-finite, or negative. It does NOT refuse τ = 0:
 * that is a coherent operator posture (escalate nothing) and the one to ship
 * with while the slow-model provider is undecided.
 */
export function createCascadeRoute(
  config: CascadeRouteConfig,
  policy: LabelPolicyConfig,
): CascadeRouter {
  if (config === null || typeof config !== "object") {
    throw new CascadeRouteConfigError(
      "cascade route requires a config; refusing to construct a route nobody configured",
    );
  }
  if (typeof config.enabled !== "boolean") {
    throw new CascadeRouteConfigError(
      "cascade route requires an explicit `enabled` boolean — running the deferred lane is a decision, not a default",
    );
  }
  if (typeof config.tau !== "number" || !Number.isFinite(config.tau) || config.tau < 0) {
    throw new CascadeRouteConfigError(
      "cascade route requires a finite, non-negative τ from operator config; there is no compiled-in default",
    );
  }

  const frozen: CascadeRouteConfig = { tau: config.tau, enabled: config.enabled };
  const inert = !frozen.enabled || frozen.tau === 0;

  return {
    inert,
    route(verdict, context) {
      return routeOnConfidence(explainFromLabels(verdict, policy, context), frozen);
    },
  };
}

/**
 * The route function itself, over an explanation rather than a raw verdict, and
 * exported for direct table-driven testing.
 *
 * Taking the EXPLANATION rather than the verdict is the point: this function
 * cannot second-guess the policy, cannot reach a different decision from it,
 * and cannot be handed a verdict the policy never saw.
 *
 * Total by construction: every {@link LabelPolicyGround} is handled, and the
 * fallthrough settles rather than escalating — an unrecognised ground must
 * never be able to start spending money.
 */
export function routeOnConfidence(
  explanation: LabelPolicyExplanation,
  config: CascadeRouteConfig,
): CascadeRoute {
  const { decision, ground, drivingConfidence } = explanation;

  if (!config.enabled || config.tau === 0) {
    return { kind: "settle", decision, reason: "lane-closed" };
  }

  // Anything that is not a `review` is a decision, and decisions are settled.
  // The lane exists for dead ends; `approved` and `quarantine` are not dead
  // ends, they are answers.
  if (decision !== "review") {
    return { kind: "settle", decision, reason: "decided" };
  }

  const cause = escalatableCause(ground);
  if (cause === null) {
    return {
      kind: "settle",
      decision,
      reason: ground === "taxonomy-pin-failed" ? "taxonomy-unpinned" : "malformed",
    };
  }

  // q̂. For the grey band it is the provider's own reported confidence for the
  // label that drove the decision. For the other two causes there is no number
  // to report and 0 is the honest value: an unreadable confidence and a silent
  // provider are both the ABSENCE of a signal, not a weak one.
  const confidence = cause === "grey-band" && drivingConfidence !== null ? drivingConfidence : 0;

  if (confidence >= config.tau) {
    return { kind: "settle", decision, reason: "confident" };
  }
  return { kind: "escalate", confidence, cause };
}

/**
 * Map a policy ground onto an escalation cause, or `null` when this ground must
 * not escalate. Exhaustive over {@link LabelPolicyGround} on purpose: adding a
 * ground to the policy without deciding its routing should be a type error, not
 * a silent default.
 */
function escalatableCause(ground: LabelPolicyGround): EscalationCause | null {
  switch (ground) {
    case "over-review-bar":
      return "grey-band";
    case "unreadable-confidence":
      return "unreadable-confidence";
    case "provider-floor":
      return "provider-abstained";
    case "taxonomy-pin-failed":
    case "malformed-verdict":
    // `clean`, `unmapped-category` and `over-quarantine-bar` never reach here
    // (their decisions are not `review`), but they are listed so the switch is
    // exhaustive and a new ground cannot slip through as `undefined`.
    case "clean":
    case "unmapped-category":
    case "over-quarantine-bar":
      return null;
  }
}
