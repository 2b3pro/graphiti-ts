import { describe, expect, it } from 'bun:test';
import {
  validateTransition,
  computeEvidenceWeight,
  addEpistemicTransition,
  BASE_WEIGHTS,
  VALID_TRANSITIONS,
  EPISTEMIC_HISTORY_CAP,
  type EpistemicStatus,
  type EpistemicTransition,
} from './epistemic';

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

describe('validateTransition', () => {
  it('allows claim -> fact', () => {
    expect(validateTransition('claim', 'fact')).toBe(true);
  });

  it('allows claim -> disputed', () => {
    expect(validateTransition('claim', 'disputed')).toBe(true);
  });

  it('allows claim -> deprecated', () => {
    expect(validateTransition('claim', 'deprecated')).toBe(true);
  });

  it('rejects claim -> observation (not in allowed list)', () => {
    expect(validateTransition('claim', 'observation')).toBe(false);
  });

  it('allows hypothesis -> fact', () => {
    expect(validateTransition('hypothesis', 'fact')).toBe(true);
  });

  it('allows hypothesis -> disputed', () => {
    expect(validateTransition('hypothesis', 'disputed')).toBe(true);
  });

  it('allows opinion -> decision', () => {
    expect(validateTransition('opinion', 'decision')).toBe(true);
  });

  it('rejects opinion -> fact', () => {
    expect(validateTransition('opinion', 'fact')).toBe(false);
  });

  it('allows fact -> disputed', () => {
    expect(validateTransition('fact', 'disputed')).toBe(true);
  });

  it('rejects fact -> claim (cannot go backward)', () => {
    expect(validateTransition('fact', 'claim')).toBe(false);
  });

  it('allows disputed -> fact (re-corroboration)', () => {
    expect(validateTransition('disputed', 'fact')).toBe(true);
  });

  it('rejects deprecated -> anything (terminal state)', () => {
    expect(validateTransition('deprecated', 'fact')).toBe(false);
    expect(validateTransition('deprecated', 'claim')).toBe(false);
  });

  it('allows all statuses to transition to deprecated', () => {
    const nonTerminal: EpistemicStatus[] = [
      'claim', 'hypothesis', 'opinion', 'disputed',
      'fact', 'decision', 'observation', 'preference',
    ];
    for (const status of nonTerminal) {
      expect(validateTransition(status, 'deprecated')).toBe(true);
    }
  });

  it('decision can only go to deprecated', () => {
    expect(validateTransition('decision', 'deprecated')).toBe(true);
    expect(validateTransition('decision', 'fact')).toBe(false);
    expect(validateTransition('decision', 'disputed')).toBe(false);
  });

  it('observation can only go to deprecated', () => {
    expect(validateTransition('observation', 'deprecated')).toBe(true);
    expect(validateTransition('observation', 'fact')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeEvidenceWeight
// ---------------------------------------------------------------------------

describe('computeEvidenceWeight', () => {
  it('returns base weight when no supporting edges and no confidence', () => {
    expect(computeEvidenceWeight({ epistemic_status: 'fact' })).toBe(1.0);
    expect(computeEvidenceWeight({ epistemic_status: 'observation' })).toBe(0.9);
    expect(computeEvidenceWeight({ epistemic_status: 'decision' })).toBe(0.8);
    expect(computeEvidenceWeight({ epistemic_status: 'preference' })).toBe(0.7);
    expect(computeEvidenceWeight({ epistemic_status: 'claim' })).toBe(0.5);
    expect(computeEvidenceWeight({ epistemic_status: 'opinion' })).toBe(0.5);
    expect(computeEvidenceWeight({ epistemic_status: 'disputed' })).toBe(0.3);
    expect(computeEvidenceWeight({ epistemic_status: 'hypothesis' })).toBe(0.3);
  });

  it('defaults to fact (weight 1.0) when epistemic_status is null', () => {
    expect(computeEvidenceWeight({ epistemic_status: null })).toBe(1.0);
  });

  it('defaults to fact (weight 1.0) when epistemic_status is undefined', () => {
    expect(computeEvidenceWeight({})).toBe(1.0);
  });

  it('scales by confidence mid band', () => {
    const weight = computeEvidenceWeight({
      epistemic_status: 'fact',
      confidence: [0.6, 0.8, 0.95],
    });
    // 1.0 * 1.0 * 0.8 = 0.8
    expect(weight).toBeCloseTo(0.8, 10);
  });

  it('increases with fact-type supporting edges', () => {
    const weight = computeEvidenceWeight(
      { epistemic_status: 'claim' },
      [{ epistemic_status: 'fact' }, { epistemic_status: 'observation' }]
    );
    // base=0.5, multiplier = min(2.0, 1.0 + 2*0.2) = 1.4, confidence=1.0
    // 0.5 * 1.4 = 0.7
    expect(weight).toBeCloseTo(0.7, 10);
  });

  it('increases less with opinion-type supporting edges', () => {
    const weight = computeEvidenceWeight(
      { epistemic_status: 'claim' },
      [{ epistemic_status: 'opinion' }, { epistemic_status: 'claim' }]
    );
    // base=0.5, multiplier = min(2.0, 1.0 + 0 + 2*0.05) = 1.1
    // 0.5 * 1.1 = 0.55
    expect(weight).toBeCloseTo(0.55, 10);
  });

  it('caps evidence multiplier at 2.0', () => {
    // 10 fact supports = 1.0 + 10*0.2 = 3.0, capped at 2.0
    const supports = Array.from({ length: 10 }, () => ({ epistemic_status: 'fact' as const }));
    const weight = computeEvidenceWeight({ epistemic_status: 'claim' }, supports);
    // 0.5 * 2.0 * 1.0 = 1.0
    expect(weight).toBeCloseTo(1.0, 10);
  });

  it('combines all three factors correctly', () => {
    const weight = computeEvidenceWeight(
      { epistemic_status: 'hypothesis', confidence: [0.2, 0.5, 0.8] },
      [{ epistemic_status: 'fact' }]
    );
    // base=0.3, multiplier = min(2.0, 1.0 + 1*0.2) = 1.2, confidence=0.5
    // 0.3 * 1.2 * 0.5 = 0.18
    expect(weight).toBeCloseTo(0.18, 10);
  });

  it('returns 0 for deprecated status', () => {
    expect(computeEvidenceWeight({ epistemic_status: 'deprecated' })).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// addEpistemicTransition
// ---------------------------------------------------------------------------

describe('addEpistemicTransition', () => {
  function makeTransition(
    from: EpistemicStatus,
    to: EpistemicStatus
  ): EpistemicTransition {
    return {
      from,
      to,
      trigger: 'corroboration',
      timestamp: new Date('2026-03-01'),
    };
  }

  it('initializes epistemic_history when null', () => {
    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } =
      { epistemic_status: 'claim', epistemic_history: null };
    addEpistemicTransition(edge, makeTransition('claim', 'fact'));
    expect(edge.epistemic_history).toHaveLength(1);
    expect(edge.epistemic_status).toBe('fact');
  });

  it('initializes epistemic_history when undefined', () => {
    const edge: { epistemic_status: EpistemicStatus | null } = { epistemic_status: 'claim' };
    addEpistemicTransition(edge, makeTransition('claim', 'fact'));
    expect((edge as { epistemic_history?: EpistemicTransition[] }).epistemic_history).toHaveLength(1);
  });

  it('appends to existing history', () => {
    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } = {
      epistemic_status: 'claim',
      epistemic_history: [makeTransition('hypothesis', 'claim')],
    };
    addEpistemicTransition(edge, makeTransition('claim', 'fact'));
    expect(edge.epistemic_history).toHaveLength(2);
    expect(edge.epistemic_status).toBe('fact');
  });

  it('updates epistemic_status to transition target', () => {
    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } =
      { epistemic_status: 'claim', epistemic_history: null };
    addEpistemicTransition(edge, makeTransition('claim', 'disputed'));
    expect(edge.epistemic_status).toBe('disputed');
  });

  it('returns the same edge reference', () => {
    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } =
      { epistemic_status: 'claim', epistemic_history: null };
    const result = addEpistemicTransition(edge, makeTransition('claim', 'fact'));
    expect(result).toBe(edge);
  });

  it('caps history at EPISTEMIC_HISTORY_CAP (50) using FIFO', () => {
    const history: EpistemicTransition[] = [];
    for (let i = 0; i < EPISTEMIC_HISTORY_CAP; i++) {
      history.push({
        ...makeTransition('claim', 'disputed'),
        timestamp: new Date(`2026-01-${String(i + 1).padStart(2, '0')}`),
      });
    }

    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } = {
      epistemic_status: 'disputed',
      epistemic_history: history,
    };

    const newTransition = makeTransition('disputed', 'fact');
    newTransition.timestamp = new Date('2026-06-01');
    addEpistemicTransition(edge, newTransition);

    expect(edge.epistemic_history).toHaveLength(EPISTEMIC_HISTORY_CAP);
    // The oldest entry (index 0 originally) should have been dropped
    // The newest entry should be the one we just added
    expect(edge.epistemic_history![EPISTEMIC_HISTORY_CAP - 1]!.timestamp).toEqual(
      new Date('2026-06-01')
    );
    // First entry should be the second original entry (index 1)
    expect(edge.epistemic_history![0]!.timestamp).toEqual(new Date('2026-01-02'));
  });

  it('preserves transition details (trigger, editor, gate_score)', () => {
    const edge: { epistemic_status: EpistemicStatus | null; epistemic_history: EpistemicTransition[] | null } =
      { epistemic_status: 'claim', epistemic_history: null };
    const transition: EpistemicTransition = {
      from: 'claim',
      to: 'fact',
      trigger: 'corroboration',
      trigger_edge_uuid: 'edge-123',
      timestamp: new Date('2026-03-15'),
      editor: 'nova',
      gate_score: {
        rubric: 'standard',
        tier: 'high',
        composite: 28,
        max_possible: 35,
        dimensions: { persistence: { raw: 5, weighted: 15 } },
      },
    };
    addEpistemicTransition(edge, transition);
    expect(edge.epistemic_history![0]).toEqual(transition);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('epistemic constants', () => {
  it('BASE_WEIGHTS covers all EpistemicStatus values', () => {
    const allStatuses: EpistemicStatus[] = [
      'fact', 'claim', 'disputed', 'decision',
      'opinion', 'hypothesis', 'observation', 'preference', 'deprecated',
    ];
    for (const status of allStatuses) {
      expect(BASE_WEIGHTS[status]).toBeDefined();
      expect(typeof BASE_WEIGHTS[status]).toBe('number');
    }
  });

  it('VALID_TRANSITIONS covers all EpistemicStatus values', () => {
    const allStatuses: EpistemicStatus[] = [
      'fact', 'claim', 'disputed', 'decision',
      'opinion', 'hypothesis', 'observation', 'preference', 'deprecated',
    ];
    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  it('EPISTEMIC_HISTORY_CAP is 50', () => {
    expect(EPISTEMIC_HISTORY_CAP).toBe(50);
  });
});
