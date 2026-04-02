export interface Edge {
  uuid: string;
  group_id: string;
  source_node_uuid: string;
  target_node_uuid: string;
  created_at: Date;
}

export interface EntityEdge extends Edge {
  name: string;
  fact: string;
  fact_embedding?: number[] | null;
  episodes?: string[];
  valid_at?: Date | null;
  invalid_at?: Date | null;
  expired_at?: Date | null;
  attributes?: Record<string, unknown>;

  /**
   * Confidence band: [low, mid, high] expressing uncertainty range.
   * Example: [0.6, 0.8, 0.95] = "probably 0.8, could be as low as 0.6 or as high as 0.95"
   * Default: null (backward-compatible, treated as [1.0, 1.0, 1.0] for existing edges)
   */
  confidence?: [number, number, number] | null;

  /**
   * Epistemic status: the epistemological standing of this edge's fact.
   * Default: null (treated as 'fact' for backward compatibility)
   */
  epistemic_status?: import('./epistemic').EpistemicStatus | null;

  /** Edge UUIDs that provide evidence FOR this edge's claim */
  supported_by?: string[] | null;

  /** Edge UUIDs that this edge provides evidence for */
  supports?: string[] | null;

  /** Edge UUIDs with contradicting claims */
  disputed_by?: string[] | null;

  /** Audit trail of epistemic status transitions (capped at 50 FIFO) */
  epistemic_history?: import('./epistemic').EpistemicTransition[] | null;

  /** Quality gate score recorded at edge creation time */
  birth_score?: import('./epistemic').BirthScore | null;

  /** Conditions under which this edge is valid (null = unconditional) */
  conditions?: import('./conditions').EdgeCondition[] | null;

  /** Edge UUIDs that provide interpretive context for this edge */
  anchored_by?: string[] | null;

  /** Edge UUIDs that this edge provides interpretive context for */
  anchors?: string[] | null;

  /** Computed interpretations derived from anchor edges */
  interpretations?: import('./anchoring').AnchoredInterpretation[] | null;
}

/**
 * Set a confidence band on an entity edge with validation.
 * All values must be between 0.0 and 1.0, and low <= mid <= high.
 * Returns the same edge reference with updated confidence.
 */
export function setConfidence(
  edge: EntityEdge,
  low: number,
  mid: number,
  high: number
): EntityEdge {
  if (!Number.isFinite(low) || !Number.isFinite(mid) || !Number.isFinite(high)) {
    throw new Error('Confidence band values must be finite numbers');
  }
  if (low < 0 || mid < 0 || high < 0) {
    throw new Error('Confidence band values must be >= 0.0');
  }
  if (low > 1 || mid > 1 || high > 1) {
    throw new Error('Confidence band values must be <= 1.0');
  }
  if (low > mid) {
    throw new Error(`Confidence band: low (${low}) must be <= mid (${mid})`);
  }
  if (mid > high) {
    throw new Error(`Confidence band: mid (${mid}) must be <= high (${high})`);
  }
  edge.confidence = [low, mid, high];
  return edge;
}

export interface EpisodicEdge extends Edge {}

export interface CommunityEdge extends Edge {
  rank?: number | null;
}

export interface HasEpisodeEdge extends Edge {}

export interface NextEpisodeEdge extends Edge {}
