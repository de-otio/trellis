/**
 * Relationship Scoring Engine
 *
 * Computes relationship scores for User→User and User→Entity edges.
 * Two distinct formulas:
 *
 * - **User→User**: Reciprocity-weighted (w_reciprocity=0.25, w_frequency=0.20,
 *   w_connection=0.10, w_decay=0.10). Manual calibration overrides all.
 *
 * - **User→Entity**: Engagement-depth-weighted (w_engagement=0.35,
 *   w_frequency=0.25, w_owner=0.15, w_creation=0.10, w_connection=0.10,
 *   w_decay=0.05). Owned entities auto-pin at 1.0.
 *
 * @see /analysis/redesign/06-entities-over-people/09-scoring-without-reciprocity.md
 * @see /analysis/redesign/02-new-core-primitives.md
 *
 * CODEBOOK: Every constant in this file (weights, decay half-lives, engagement
 * scores, connection bonuses, tier thresholds) is documented with rationale in
 * the sibling file SCORING-CODEBOOK.md.  The codebook and this file are
 * versioned together — change a constant here, update the codebook in the same
 * commit/PR.
 */

import type {
  CircleTier,
  ConnectionMethod,
  GraphNodeType,
  InteractionType,
  ScoringWeights,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default scoring weights for User→User relationships */
export const USER_WEIGHTS: ScoringWeights = {
  reciprocity: 0.25,
  frequency: 0.20,
  engagement: 0, // Not used for user→user
  ownerProximity: 0, // Not used for user→user
  contentCreation: 0, // Not used for user→user
  connection: 0.10,
  decay: 0.10,
};

/** Default scoring weights for User→Entity relationships */
export const ENTITY_WEIGHTS: ScoringWeights = {
  engagement: 0.35,
  frequency: 0.25,
  ownerProximity: 0.15,
  contentCreation: 0.10,
  connection: 0.10,
  decay: 0.05,
  reciprocity: 0, // Not applicable for entities
};

/** Decay half-life in days for user→user relationships */
export const USER_DECAY_HALF_LIFE_DAYS = 60;

/** Decay half-life in days for user→entity relationships */
export const ENTITY_DECAY_HALF_LIFE_DAYS = 120;

/** Score contribution per interaction type (engagement depth) */
export const ENGAGEMENT_SCORES: Record<InteractionType, number> = {
  view: 0.01,
  react: 0.05,
  comment: 0.10,
  share: 0.10,
  depth_mode: 0.08,
  profile_visit: 0.03,
  content_creation: 0.15,
};

/** Initial score bonus per connection method */
export const CONNECTION_BONUSES: Record<ConnectionMethod, number> = {
  code: 0.7,
  import: 0.5,
  suggestion: 0.3,
  discovery: 0.3,
};

/** Tier thresholds — score >= threshold maps to that tier */
export const TIER_THRESHOLDS: { tier: CircleTier; minScore: number }[] = [
  { tier: 0, minScore: 0.7 }, // Inner circle
  { tier: 1, minScore: 0.4 }, // Close friends
  { tier: 2, minScore: 0.15 }, // Community
  { tier: 3, minScore: 0.0 }, // Ambient
];

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/** Interaction counts broken down by type, for computing engagement depth */
export interface InteractionCounts {
  view: number;
  react: number;
  comment: number;
  share: number;
  depth_mode: number;
  profile_visit: number;
  content_creation: number;
}

/** All signals needed to compute a relationship score */
export interface ScoringInput {
  /** Target type determines which formula to use */
  targetType: GraphNodeType;

  /** How the relationship was created */
  connectionMethod: ConnectionMethod;

  /** Total interaction count (for frequency signal) */
  interactionCount: number;

  /** Breakdown of interactions by type (for engagement depth signal) */
  interactionsByType: InteractionCounts;

  /** Timestamp of the last interaction (for decay calculation) */
  lastInteractionAt: Date | null;

  /** Whether the relationship is reciprocated (user→user only) */
  reciprocated: boolean;

  /** When the relationship was created */
  createdAt: Date;

  /** User-set manual score override (null if not set) */
  manualScore: number | null;

  /** Whether the user owns the target entity (entity targets only) */
  isOwned: boolean;

  /**
   * The user's score with the entity's owner(s).
   * Used for owner proximity boost. Average of all owner scores.
   * Null if no owner relationship exists or if target is a user.
   */
  ownerScore: number | null;

  /** Current timestamp for decay calculation */
  now: Date;
}

// ---------------------------------------------------------------------------
// Scoring Functions
// ---------------------------------------------------------------------------

/**
 * Compute the effective score for a relationship.
 *
 * - Owned entities always return 1.0 (auto-pin).
 * - If manualScore is set, it overrides the computed score.
 * - Otherwise, applies the target-type-aware formula.
 *
 * @returns A score clamped to [0, 1]
 */
export function computeScore(input: ScoringInput): number {
  // Auto-pin: owned entities always score 1.0
  if (input.targetType === "entity" && input.isOwned) {
    return 1.0;
  }

  // Manual override takes precedence
  if (input.manualScore !== null && input.manualScore !== undefined) {
    return clamp(input.manualScore);
  }

  // Delegate to target-type-specific formula
  if (input.targetType === "user") {
    return computeUserScore(input);
  }
  return computeEntityScore(input);
}

/**
 * Compute the effective score for display/tier resolution.
 * Returns manualScore if set, otherwise computedScore.
 */
export function effectiveScore(
  manualScore: number | null,
  computedScore: number,
): number {
  return manualScore ?? computedScore;
}

/**
 * Resolve the circle tier from a score using default thresholds.
 *
 * @param score - The effective score (0.0 to 1.0)
 * @returns The circle tier (0 = inner, 3 = ambient)
 */
export function scoreToTier(score: number): CircleTier {
  for (const { tier, minScore } of TIER_THRESHOLDS) {
    if (score >= minScore) {
      return tier;
    }
  }
  return 3; // Ambient fallback
}

/**
 * Compute the exponential decay factor based on time since last interaction.
 *
 * Uses the formula: decay = 1 - (0.5 ^ (daysSinceInteraction / halfLifeDays))
 * - Returns 0 when daysSinceInteraction = 0 (no decay)
 * - Returns 0.5 when daysSinceInteraction = halfLifeDays
 * - Approaches 1.0 as daysSinceInteraction → ∞
 *
 * @param lastInteractionAt - When the last interaction occurred
 * @param now - Current time
 * @param halfLifeDays - Days until 50% decay
 * @returns Decay penalty in [0, 1]
 */
export function computeDecay(
  lastInteractionAt: Date | null,
  now: Date,
  halfLifeDays: number,
): number {
  if (!lastInteractionAt) {
    // No interaction ever — use creation-based decay (treat as max decay)
    return 1.0;
  }

  const msPerDay = 86_400_000;
  const daysSince =
    (now.getTime() - lastInteractionAt.getTime()) / msPerDay;

  if (daysSince <= 0) {
    return 0;
  }

  // Exponential decay: 1 - 2^(-t/halfLife)
  return 1 - Math.pow(2, -daysSince / halfLifeDays);
}

/**
 * Compute the engagement depth signal from interaction type breakdown.
 *
 * Sums the per-type scores weighted by count, then normalizes to [0, 1]
 * using a sigmoid-like saturation curve so that diminishing returns
 * apply after ~50 total weighted interactions.
 *
 * @returns Engagement depth in [0, 1]
 */
export function computeEngagementDepth(
  interactionsByType: InteractionCounts,
): number {
  let rawScore = 0;

  for (const [type, count] of Object.entries(interactionsByType)) {
    const weight = ENGAGEMENT_SCORES[type as InteractionType] ?? 0;
    rawScore += weight * count;
  }

  // Saturating function: score = raw / (raw + k)
  // k = 5 means ~50% saturation at rawScore=5, ~83% at rawScore=25
  const k = 5;
  return rawScore / (rawScore + k);
}

/**
 * Compute the frequency signal from total interaction count.
 *
 * Uses a saturating curve so that early interactions have more impact
 * and the signal asymptotically approaches 1.0.
 *
 * @returns Frequency signal in [0, 1]
 */
export function computeFrequencySignal(interactionCount: number): number {
  if (interactionCount <= 0) return 0;

  // k = 20 means ~50% saturation at 20 interactions
  const k = 20;
  return interactionCount / (interactionCount + k);
}

/**
 * Get the initial connection bonus for a connection method.
 *
 * @returns Connection bonus in [0, 1]
 */
export function connectionBonus(method: ConnectionMethod): number {
  return CONNECTION_BONUSES[method] ?? 0.3;
}

/**
 * Compute the content creation signal for entity relationships.
 *
 * Content creation about a non-owned entity is a strong signal.
 * For owned entities this is not meaningful (handled by auto-pin).
 *
 * @returns Content creation signal in [0, 1]
 */
export function computeContentCreationSignal(
  contentCreationCount: number,
): number {
  if (contentCreationCount <= 0) return 0;

  // Saturating: k=3 means ~50% at 3 posts about this entity
  const k = 3;
  return contentCreationCount / (contentCreationCount + k);
}

/**
 * Compute the owner proximity boost for entity relationships.
 *
 * If the viewer has a strong relationship with the entity's owner,
 * the entity gets a boost. This creates "inherited closeness".
 *
 * @param ownerScore - The viewer's score with the entity owner (or avg of owners)
 * @returns Owner proximity signal in [0, 1]
 */
export function computeOwnerProximity(ownerScore: number | null): number {
  if (ownerScore === null || ownerScore <= 0) return 0;
  // Pass through: the viewer's score with the owner IS the proximity signal
  return clamp(ownerScore);
}

// ---------------------------------------------------------------------------
// Internal Formula Implementations
// ---------------------------------------------------------------------------

/**
 * User→User scoring formula (reciprocity-weighted).
 *
 * score = w_reciprocity * reciprocitySignal
 *       + w_frequency * frequencySignal
 *       + w_connection * connectionBonus
 *       - w_decay * decayPenalty
 *
 * The remaining weight (0.35) is implicitly allocated to explicit calibration
 * (manual score), which overrides the computed score entirely when set.
 */
function computeUserScore(input: ScoringInput): number {
  const w = USER_WEIGHTS;

  const reciprocitySignal = input.reciprocated ? 1.0 : 0.0;
  const frequencySignal = computeFrequencySignal(input.interactionCount);
  const connBonus = connectionBonus(input.connectionMethod);
  const decayPenalty = computeDecay(
    input.lastInteractionAt,
    input.now,
    USER_DECAY_HALF_LIFE_DAYS,
  );

  const raw =
    w.reciprocity * reciprocitySignal +
    w.frequency * frequencySignal +
    w.connection * connBonus -
    w.decay * decayPenalty;

  return clamp(raw);
}

/**
 * User→Entity scoring formula (engagement-depth-weighted).
 *
 * score = w_engagement * engagementDepth
 *       + w_frequency * frequencySignal
 *       + w_owner * ownerProximity
 *       + w_creation * contentCreationSignal
 *       + w_connection * connectionBonus
 *       - w_decay * decayPenalty
 */
function computeEntityScore(input: ScoringInput): number {
  const w = ENTITY_WEIGHTS;

  const engagementDepth = computeEngagementDepth(input.interactionsByType);
  const frequencySignal = computeFrequencySignal(input.interactionCount);
  const ownerProx = computeOwnerProximity(input.ownerScore);
  const creationSignal = computeContentCreationSignal(
    input.interactionsByType.content_creation,
  );
  const connBonus = connectionBonus(input.connectionMethod);
  const decayPenalty = computeDecay(
    input.lastInteractionAt,
    input.now,
    ENTITY_DECAY_HALF_LIFE_DAYS,
  );

  const raw =
    w.engagement * engagementDepth +
    w.frequency * frequencySignal +
    w.ownerProximity * ownerProx +
    w.contentCreation * creationSignal +
    w.connection * connBonus -
    w.decay * decayPenalty;

  return clamp(raw);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a value to [0, 1] */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
