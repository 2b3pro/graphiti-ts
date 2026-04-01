/**
 * Epistemic Status + Evidence Weight system for entity edges.
 *
 * Tracks the epistemological standing of facts stored in the knowledge graph:
 * how certain we are, what evidence supports or disputes a claim, and the
 * audit trail of status transitions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpistemicStatus =
  | 'fact'            // Verified/corroborated (weight 1.0)
  | 'claim'           // Asserted, not verified (weight 0.5)
  | 'disputed'        // Contradicting evidence (weight 0.3)
  | 'decision'        // Chosen by principal (weight 0.8)
  | 'opinion'         // Subjective assessment (weight 0.5)
  | 'hypothesis'      // Proposed for testing (weight 0.3)
  | 'observation'     // Directly witnessed (weight 0.9)
  | 'preference'      // Personal preference (weight 0.7)
  | 'deprecated';     // Terminal state — no longer valid

export type EpistemicTrigger =
  | 'corroboration'
  | 'contradiction'
  | 'testing'
  | 'decision'
  | 'deprecation'
  | 'manual_edit';

export interface EpistemicGateScore {
  rubric: string;
  tier: string;
  composite: number;
  max_possible: number;
  dimensions: Record<string, { raw: number; weighted: number }>;
  existing_weight?: number;
}

export interface EpistemicTransition {
  from: EpistemicStatus;
  to: EpistemicStatus;
  trigger: EpistemicTrigger;
  trigger_edge_uuid?: string;
  timestamp: Date;
  editor?: string;           // 'nova' | 'ian' | 'system'
  gate_score?: EpistemicGateScore;
}

export interface BirthScore {
  composite: number;
  tier: string;
  dimensions: Record<string, { raw: number; weighted: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_WEIGHTS: Record<EpistemicStatus, number> = {
  fact:        1.0,
  observation: 0.9,
  decision:    0.8,
  preference:  0.7,
  claim:       0.5,
  opinion:     0.5,
  disputed:    0.3,
  hypothesis:  0.3,
  deprecated:  0.0,
} as const;

/**
 * Valid epistemic state transitions.
 * 'deprecated' is a terminal state available from all statuses.
 */
export const VALID_TRANSITIONS: Record<EpistemicStatus, EpistemicStatus[]> = {
  claim:       ['fact', 'disputed', 'deprecated'],
  hypothesis:  ['fact', 'disputed', 'deprecated'],
  opinion:     ['decision', 'deprecated'],
  disputed:    ['fact', 'deprecated'],
  fact:        ['disputed', 'deprecated'],
  decision:    ['deprecated'],
  observation: ['deprecated'],
  preference:  ['deprecated'],
  deprecated:  [],  // Terminal state — no transitions out
};

/** Maximum number of transitions retained in epistemic_history (FIFO). */
export const EPISTEMIC_HISTORY_CAP = 50;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether an epistemic status transition is valid.
 */
export function validateTransition(from: EpistemicStatus, to: EpistemicStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Compute the evidence weight of an edge given its epistemic status,
 * supporting edges, and confidence band.
 *
 * Formula:
 *   base_weight(status) x evidence_multiplier x confidence_mid
 *
 * evidence_multiplier = min(2.0, 1.0 + factSupports * 0.2 + opinionSupports * 0.05)
 *
 * - factSupports: edges in supportingEdges with status 'fact' or 'observation'
 * - opinionSupports: all other supporting edges
 * - confidence_mid: middle band value, defaults to 1.0 if absent
 */
export function computeEvidenceWeight(
  edge: {
    epistemic_status?: EpistemicStatus | null;
    confidence?: [number, number, number] | null;
  },
  supportingEdges: Array<{ epistemic_status?: EpistemicStatus | null }> = []
): number {
  const status: EpistemicStatus = edge.epistemic_status ?? 'fact';
  const baseWeight = BASE_WEIGHTS[status] ?? 1.0;

  let factSupports = 0;
  let opinionSupports = 0;
  for (const se of supportingEdges) {
    const seStatus = se.epistemic_status ?? 'fact';
    if (seStatus === 'fact' || seStatus === 'observation') {
      factSupports++;
    } else {
      opinionSupports++;
    }
  }

  const evidenceMultiplier = Math.min(2.0, 1.0 + factSupports * 0.2 + opinionSupports * 0.05);

  const confidenceMid = edge.confidence?.[1] ?? 1.0;

  return baseWeight * evidenceMultiplier * confidenceMid;
}

/**
 * Append an epistemic transition to an edge's history, capping at FIFO limit.
 * Mutates the edge in place and returns it.
 */
export function addEpistemicTransition<
  T extends { epistemic_history?: EpistemicTransition[] | null; epistemic_status?: EpistemicStatus | null }
>(edge: T, transition: EpistemicTransition): T {
  if (!edge.epistemic_history) {
    edge.epistemic_history = [];
  }

  edge.epistemic_history.push(transition);

  // FIFO cap: drop oldest entries
  if (edge.epistemic_history.length > EPISTEMIC_HISTORY_CAP) {
    edge.epistemic_history = edge.epistemic_history.slice(
      edge.epistemic_history.length - EPISTEMIC_HISTORY_CAP
    );
  }

  // Update current status to match transition target
  edge.epistemic_status = transition.to;

  return edge;
}
