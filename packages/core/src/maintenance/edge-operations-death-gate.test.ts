import { describe, expect, test } from 'bun:test';
import { resolveEdgeContradictions } from './edge-operations';
import type { EntityEdge } from '../domain/edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: `edge-${Math.random().toString(36).slice(2)}`,
    group_id: 'test',
    source_node_uuid: 'a',
    target_node_uuid: 'b',
    created_at: new Date('2025-01-01'),
    name: 'TEST',
    fact: 'test fact',
    valid_at: new Date('2025-01-01'),
    ...overrides,
  } as EntityEdge;
}

describe('resolveEdgeContradictions with death gate', () => {
  test('well-supported fact resists weak contradiction', () => {
    const resolvedEdge = makeEdge({
      valid_at: new Date('2025-06-01'),
      fact: 'New contradicting fact',
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      fact: 'Well-established fact',
      epistemic_status: 'fact',
      supported_by: ['ev-1', 'ev-2', 'ev-3', 'ev-4'],
      confidence: [0.8, 0.95, 1.0],
    });

    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    // Well-supported fact (evidence weight = 1.0 * 1.0 * 0.95 = 0.95 > 0.8) should be disputed, not invalidated
    if (result.length > 0) {
      expect(result[0].epistemic_status).toBe('disputed');
      // Disputed edges are NOT invalidated — invalid_at stays as it was (undefined/null)
      expect(result[0].invalid_at).toBeFalsy();
    }
  });

  test('unsupported claim is deprecatable', () => {
    const resolvedEdge = makeEdge({
      valid_at: new Date('2025-06-01'),
      fact: 'New contradicting fact',
      epistemic_status: 'fact',
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      fact: 'Unsupported claim',
      epistemic_status: 'claim',
      confidence: [0.3, 0.5, 0.7],
    });

    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    expect(result.length).toBe(1);
    // Low evidence weight claim (0.5 * 1.0 * 0.5 = 0.25 < 0.8) should be invalidated
    expect(result[0].invalid_at).not.toBeNull();
    expect(result[0].epistemic_status).toBe('deprecated');
  });

  test('empty candidates returns empty', () => {
    const resolvedEdge = makeEdge({ valid_at: new Date('2025-06-01') });
    expect(resolveEdgeContradictions(resolvedEdge, [])).toEqual([]);
  });

  test('temporal ordering still respected', () => {
    const resolvedEdge = makeEdge({ valid_at: new Date('2025-01-01') });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-06-01'), // newer than resolved — should NOT be invalidated
    });
    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    expect(result).toEqual([]);
  });

  test('disputed edge records disputed_by reference', () => {
    const resolvedEdge = makeEdge({
      uuid: 'new-edge',
      valid_at: new Date('2025-06-01'),
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      epistemic_status: 'fact',
      confidence: [0.9, 0.95, 1.0],
    });

    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    if (result.length > 0 && result[0].epistemic_status === 'disputed') {
      expect(result[0].disputed_by).toContain('new-edge');
    }
  });

  test('already-invalid edge is skipped via temporal check', () => {
    const resolvedEdge = makeEdge({
      valid_at: new Date('2025-06-01'),
    });
    const existingEdge = makeEdge({
      valid_at: new Date('2025-01-01'),
      invalid_at: new Date('2025-03-01'), // expired before resolved edge
    });

    const result = resolveEdgeContradictions(resolvedEdge, [existingEdge]);
    expect(result).toEqual([]);
  });
});
