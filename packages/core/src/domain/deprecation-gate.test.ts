import { describe, expect, test } from 'bun:test';
import {
  type DeprecationGateConfig,
  DEFAULT_DEPRECATION_GATE_CONFIG,
  scoreContradiction,
  resolveContradiction,
  type ContradictionScores,
  type ContradictionResolution,
} from './deprecation-gate';
import type { EntityEdge } from './edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: 'edge-1',
    group_id: 'test',
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: new Date(),
    name: 'TEST',
    fact: 'test fact',
    ...overrides,
  };
}

describe('scoreContradiction', () => {
  test('returns weighted composite score', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 3,
      corroboration_count: 2,
    };
    const result = scoreContradiction(scores);
    // (4*3) + (3*2) + (2*2) = 12 + 6 + 4 = 22
    expect(result.composite).toBe(22);
    expect(result.max_possible).toBe(35);
  });

  test('minimum scores', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 1,
      source_authority: 1,
      corroboration_count: 1,
    };
    const result = scoreContradiction(scores);
    // (1*3) + (1*2) + (1*2) = 7
    expect(result.composite).toBe(7);
  });

  test('maximum scores', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 5,
      source_authority: 5,
      corroboration_count: 5,
    };
    const result = scoreContradiction(scores);
    // (5*3) + (5*2) + (5*2) = 35
    expect(result.composite).toBe(35);
  });

  test('custom config weights', () => {
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 3,
      corroboration_count: 3,
    };
    const config: DeprecationGateConfig = {
      ...DEFAULT_DEPRECATION_GATE_CONFIG,
      weights: { contradiction_strength: 1, source_authority: 1, corroboration_count: 1 },
    };
    const result = scoreContradiction(scores, config);
    // (3*1) + (3*1) + (3*1) = 9
    expect(result.composite).toBe(9);
  });
});

describe('resolveContradiction', () => {
  test('ignore tier: keep existing', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 1,
      source_authority: 1,
      corroboration_count: 1,
    };
    // composite = 7, which is <= ignore threshold (7)
    const result = resolveContradiction(existing, contradicting, scores);
    expect(result.action).toBe('keep_existing');
  });

  test('dispute tier: both edges disputed', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 2,
      corroboration_count: 2,
    };
    // composite = (3*3)+(2*2)+(2*2) = 9+4+4 = 17
    const result = resolveContradiction(existing, contradicting, scores);
    expect(result.action).toBe('dispute_both');
    expect(result.mutations).toHaveLength(2);
  });

  test('deprecate tier with low evidence weight: deprecate existing', () => {
    const existing = makeEdge({ uuid: 'existing', epistemic_status: 'claim' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = (4*3)+(4*2)+(3*2) = 12+8+6 = 26
    const result = resolveContradiction(existing, contradicting, scores, 0.5);
    expect(result.action).toBe('deprecate_existing');
  });

  test('deprecate tier with HIGH evidence weight: resist — dispute instead', () => {
    const existing = makeEdge({ uuid: 'existing', epistemic_status: 'fact' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = 26 (deprecate tier), but evidence weight > 0.8
    const result = resolveContradiction(existing, contradicting, scores, 1.5);
    expect(result.action).toBe('dispute_both');
    expect(result.reason).toBe('strong_contradiction_vs_strong_evidence');
  });

  test('replace tier: deprecate regardless of evidence weight', () => {
    const existing = makeEdge({ uuid: 'existing', epistemic_status: 'fact' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 5,
      source_authority: 5,
      corroboration_count: 5,
    };
    // composite = 35 (replace tier)
    const result = resolveContradiction(existing, contradicting, scores, 2.0);
    expect(result.action).toBe('replace');
  });

  test('custom thresholds', () => {
    const config: DeprecationGateConfig = {
      ...DEFAULT_DEPRECATION_GATE_CONFIG,
      thresholds: { ignore: 10, dispute: 20, deprecate: 30, replace: 35 },
    };
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 3,
      source_authority: 2,
      corroboration_count: 1,
    };
    // composite = (3*3)+(2*2)+(1*2) = 9+4+2 = 15, 10 < 15 <= 20 → dispute
    const result = resolveContradiction(existing, contradicting, scores, 0.5, config);
    expect(result.action).toBe('dispute_both');
  });

  test('evidence weight resistance threshold is 0.8 (strict >)', () => {
    const existing = makeEdge({ uuid: 'existing' });
    const contradicting = makeEdge({ uuid: 'new' });
    const scores: ContradictionScores = {
      contradiction_strength: 4,
      source_authority: 4,
      corroboration_count: 3,
    };
    // composite = 26 (deprecate tier)
    // weight exactly 0.8 — should NOT resist (threshold is >0.8)
    const result = resolveContradiction(existing, contradicting, scores, 0.8);
    expect(result.action).toBe('deprecate_existing');

    // weight 0.81 — should resist
    const result2 = resolveContradiction(existing, contradicting, scores, 0.81);
    expect(result2.action).toBe('dispute_both');
  });
});
