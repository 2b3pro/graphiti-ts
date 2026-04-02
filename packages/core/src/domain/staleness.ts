/**
 * Staleness Scoring for knowledge graph edges.
 *
 * Computes an on-the-fly freshness signal (0.0 = fresh, 1.0 = stale) for any
 * edge at query time. The score is never persisted — it is derived from:
 *   - how old the edge is (sigmoid over age_days)
 *   - how many times it has been reinforced (reduces base staleness)
 *   - how recently it was last reinforced (recency window dampening)
 *   - the expected change rate of the edge's entity type (domain velocity)
 */

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Sigmoid steepness — controls how sharply the score rises with age. */
export const STALENESS_SLOPE = 0.05;

/** Age in days at which the sigmoid produces a staleness score of 0.5. */
export const STALENESS_MIDPOINT_DAYS = 90;

/** Per-reinforcement reduction factor applied to the base age factor. */
export const REINFORCEMENT_DECAY = 0.1;

/**
 * Days within which a reinforcement is considered "recent."
 * Reinforcements older than this window apply a full recency penalty.
 */
export const RECENCY_WINDOW_DAYS = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input factors required to compute a staleness score. */
export interface StalenessFactors {
  /** Age of the edge in days since it was created or last updated. */
  age_days: number;
  /**
   * Days since the edge was last reinforced.
   * `null` when the edge has never been reinforced.
   */
  last_reinforced_days: number | null;
  /** Expected change rate for the entity type (0.0–1.0). */
  domain_velocity: number;
  /** Total number of times the edge has been reinforced. */
  reinforcement_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default domain velocity per entity type.
 *
 * Higher values mean the entity type changes frequently (e.g., Tool configs
 * change more often than a Person's identity). Used as a multiplier in
 * `computeStaleness` so fast-moving domains age more aggressively.
 */
export const DOMAIN_VELOCITY: Record<string, number> = {
  Tool:      0.7,
  Server:    0.6,
  Project:   0.5,
  Decision:  0.5,
  Feedback:  0.4,
  Concept:   0.3,
  Person:    0.2,
  Reference: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Logistic sigmoid function.
 * Returns a value in (0, 1) that grows from 0 toward 1 as `x` increases.
 *
 * Formula: 1 / (1 + exp(-slope * (x - midpoint)))
 */
function sigmoid(x: number, slope: number, midpoint: number): number {
  return 1 / (1 + Math.exp(-slope * (x - midpoint)));
}

/** Clamp a number to the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Compute a staleness score for an edge given its lifecycle factors.
 *
 * @returns A value in [0.0, 1.0] where 0.0 is fully fresh and 1.0 is maximally stale.
 *
 * Calculation:
 *   ageFactor           = sigmoid(age_days, STALENESS_SLOPE, STALENESS_MIDPOINT_DAYS)
 *   reinforcementFactor = max(0, 1 - reinforcement_count × REINFORCEMENT_DECAY)
 *   velocityMultiplier  = 0.5 + domain_velocity
 *   recencyFactor       = last_reinforced_days !== null
 *                           ? min(1, last_reinforced_days / RECENCY_WINDOW_DAYS)
 *                           : 1
 *   result              = clamp(ageFactor × reinforcementFactor × velocityMultiplier × recencyFactor, 0, 1)
 */
export function computeStaleness(factors: StalenessFactors): number {
  const { age_days, last_reinforced_days, domain_velocity, reinforcement_count } = factors;

  const ageFactor = sigmoid(age_days, STALENESS_SLOPE, STALENESS_MIDPOINT_DAYS);

  const reinforcementFactor = Math.max(0, 1 - reinforcement_count * REINFORCEMENT_DECAY);

  const velocityMultiplier = 0.5 + domain_velocity;

  const recencyFactor =
    last_reinforced_days !== null
      ? Math.min(1, last_reinforced_days / RECENCY_WINDOW_DAYS)
      : 1;

  return clamp(ageFactor * reinforcementFactor * velocityMultiplier * recencyFactor, 0, 1);
}
