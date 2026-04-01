/**
 * Edge Quality Gate — scoring function for edge creation decisions.
 *
 * Called by the consumer (PAI integration layer) during ingestion to decide
 * whether an edge is worth persisting. Does NOT modify the ingestion pipeline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EdgeQualityTier = 'skip' | 'low' | 'standard' | 'high';

export interface EdgeQualityScore {
  /** 1-5: will this matter beyond this conversation? */
  persistence: number;
  /** 1-5: how concrete and retrievable? */
  specificity: number;
  /** 1-5: does this add new information? */
  novelty: number;
  /** Weighted composite: persistence*3 + specificity*2 + novelty*2 */
  composite: number;
  /** Tier derived from composite score */
  tier: EdgeQualityTier;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Compute an edge quality score from dimension inputs.
 *
 * Composite = persistence*3 + specificity*2 + novelty*2
 * Max possible = 5*3 + 5*2 + 5*2 = 35
 *
 * Tier thresholds:
 *   <=  6  → skip     (noise, ephemeral)
 *   <= 14  → low      (might be useful but marginal)
 *   <= 24  → standard (solid knowledge)
 *   <= 35  → high     (core knowledge, high signal)
 */
export function computeEdgeQuality(scores: {
  persistence: number;
  specificity: number;
  novelty: number;
}): EdgeQualityScore {
  const composite =
    scores.persistence * 3 + scores.specificity * 2 + scores.novelty * 2;

  let tier: EdgeQualityTier;
  if (composite <= 6) tier = 'skip';
  else if (composite <= 14) tier = 'low';
  else if (composite <= 24) tier = 'standard';
  else tier = 'high';

  return {
    persistence: scores.persistence,
    specificity: scores.specificity,
    novelty: scores.novelty,
    composite,
    tier,
  };
}

/**
 * Returns true if the edge should be created (tier is not 'skip').
 */
export function shouldCreateEdge(quality: EdgeQualityScore): boolean {
  return quality.tier !== 'skip';
}
