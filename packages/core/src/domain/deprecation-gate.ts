/**
 * Deprecation Confidence Gate (Death Gate) — evidence-weighted contradiction resolution.
 *
 * Scores contradiction strength against existing evidence weight to create
 * epistemic inertia: well-established facts resist casual contradiction,
 * while weakly-evidenced claims yield to authoritative correction.
 *
 * Mirrors the birth gate pattern from `edge-quality.ts`.
 */

import type { EntityEdge } from './edges';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContradictionScores {
  /** How directly does the new evidence contradict the existing edge? (1-5) */
  contradiction_strength: number;
  /** Authority/reliability of the contradicting source (1-5) */
  source_authority: number;
  /** How many independent sources corroborate the contradiction? (1-5) */
  corroboration_count: number;
}

export interface DeprecationGateConfig {
  weights: {
    contradiction_strength: number;
    source_authority: number;
    corroboration_count: number;
  };
  thresholds: {
    ignore: number;     // composite <= ignore → keep existing
    dispute: number;    // ignore < composite <= dispute → dispute both
    deprecate: number;  // dispute < composite <= deprecate → deprecate (if evidence allows)
    replace: number;    // informational: max possible composite (not used in tier logic — any composite > deprecate is replace)
  };
  /** Evidence weight above which the deprecate tier resists and falls back to dispute */
  evidence_resistance_threshold: number;
}

export interface ScoringResult {
  composite: number;
  max_possible: number;
  tier: 'ignore' | 'dispute' | 'deprecate' | 'replace';
  dimensions: Record<string, { raw: number; weighted: number }>;
}

export type ContradictionAction = 'keep_existing' | 'dispute_both' | 'deprecate_existing' | 'replace';

export interface EdgeMutation {
  edge_uuid: string;
  set: Record<string, unknown>;
}

export interface ContradictionResolution {
  action: ContradictionAction;
  reason: string;
  mutations?: EdgeMutation[];
  scoring?: ScoringResult;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_DEPRECATION_GATE_CONFIG: DeprecationGateConfig = {
  weights: {
    contradiction_strength: 3,
    source_authority: 2,
    corroboration_count: 2,
  },
  thresholds: {
    ignore: 7,
    dispute: 17,
    deprecate: 28,
    replace: 35,
  },
  evidence_resistance_threshold: 0.8,
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute a weighted composite score for a set of contradiction dimensions.
 * Returns the composite, max possible, tier classification, and per-dimension breakdown.
 */
export function scoreContradiction(
  scores: ContradictionScores,
  config: DeprecationGateConfig = DEFAULT_DEPRECATION_GATE_CONFIG
): ScoringResult {
  const { weights, thresholds } = config;

  const dimensions: Record<string, { raw: number; weighted: number }> = {
    contradiction_strength: {
      raw: scores.contradiction_strength,
      weighted: scores.contradiction_strength * weights.contradiction_strength,
    },
    source_authority: {
      raw: scores.source_authority,
      weighted: scores.source_authority * weights.source_authority,
    },
    corroboration_count: {
      raw: scores.corroboration_count,
      weighted: scores.corroboration_count * weights.corroboration_count,
    },
  };

  const composite = Object.values(dimensions).reduce((sum, d) => sum + d.weighted, 0);
  const max_possible =
    5 * weights.contradiction_strength +
    5 * weights.source_authority +
    5 * weights.corroboration_count;

  let tier: ScoringResult['tier'];
  if (composite <= thresholds.ignore) tier = 'ignore';
  else if (composite <= thresholds.dispute) tier = 'dispute';
  else if (composite <= thresholds.deprecate) tier = 'deprecate';
  else tier = 'replace';

  return { composite, max_possible, tier, dimensions };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Given an existing edge, a contradicting edge, and scored contradiction dimensions,
 * determine the appropriate action: keep, dispute, deprecate, or replace.
 *
 * The `existingEvidenceWeight` parameter (from `computeEvidenceWeight()`) creates
 * epistemic inertia — well-evidenced facts resist deprecation and fall back to dispute.
 */
export function resolveContradiction(
  existingEdge: EntityEdge,
  contradictingEdge: EntityEdge,
  scores: ContradictionScores,
  existingEvidenceWeight: number = 0,
  config: DeprecationGateConfig = DEFAULT_DEPRECATION_GATE_CONFIG
): ContradictionResolution {
  const scoring = scoreContradiction(scores, config);
  const now = new Date();

  switch (scoring.tier) {
    case 'ignore':
      return { action: 'keep_existing', reason: 'weak_contradiction', scoring };

    case 'dispute':
      return {
        action: 'dispute_both',
        reason: 'moderate_contradiction',
        mutations: [
          {
            edge_uuid: existingEdge.uuid,
            set: {
              epistemic_status: 'disputed',
              disputed_by: [...(existingEdge.disputed_by ?? []), contradictingEdge.uuid],
            },
          },
          {
            edge_uuid: contradictingEdge.uuid,
            set: {
              epistemic_status: 'disputed',
              disputed_by: [...(contradictingEdge.disputed_by ?? []), existingEdge.uuid],
            },
          },
        ],
        scoring,
      };

    case 'deprecate':
      // Epistemic inertia: strong existing evidence resists deprecation
      if (existingEvidenceWeight > config.evidence_resistance_threshold) {
        return {
          action: 'dispute_both',
          reason: 'strong_contradiction_vs_strong_evidence',
          mutations: [
            {
              edge_uuid: existingEdge.uuid,
              set: {
                epistemic_status: 'disputed',
                disputed_by: [...(existingEdge.disputed_by ?? []), contradictingEdge.uuid],
              },
            },
            {
              edge_uuid: contradictingEdge.uuid,
              set: {
                epistemic_status: 'disputed',
                disputed_by: [...(contradictingEdge.disputed_by ?? []), existingEdge.uuid],
              },
            },
          ],
          scoring,
        };
      }
      return {
        action: 'deprecate_existing',
        reason: 'authoritative_contradiction',
        mutations: [{ edge_uuid: existingEdge.uuid, set: { invalid_at: now, expired_at: now, epistemic_status: 'deprecated' } }],
        scoring,
      };

    case 'replace':
      return {
        action: 'replace',
        reason: 'definitive_contradiction',
        mutations: [{ edge_uuid: existingEdge.uuid, set: { invalid_at: now, expired_at: now, epistemic_status: 'deprecated' } }],
        scoring,
      };
  }
}
