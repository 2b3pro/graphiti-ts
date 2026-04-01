import { describe, expect, it } from 'bun:test';
import type { EntityEdge } from './edges';
import { setConfidence } from './edges';

function makeEdge(overrides: Partial<EntityEdge> = {}): EntityEdge {
  return {
    uuid: 'test-uuid',
    group_id: 'test-group',
    source_node_uuid: 'source-uuid',
    target_node_uuid: 'target-uuid',
    created_at: new Date('2026-01-01'),
    name: 'TEST_EDGE',
    fact: 'A test fact',
    ...overrides
  };
}

describe('setConfidence', () => {
  it('sets a valid confidence band on an edge', () => {
    const edge = makeEdge();
    const result = setConfidence(edge, 0.6, 0.8, 0.95);
    expect(result.confidence).toEqual([0.6, 0.8, 0.95]);
  });

  it('returns the same edge reference with updated confidence', () => {
    const edge = makeEdge();
    const result = setConfidence(edge, 0.5, 0.7, 0.9);
    expect(result).toBe(edge);
  });

  it('accepts equal values (point estimate)', () => {
    const edge = makeEdge();
    const result = setConfidence(edge, 0.8, 0.8, 0.8);
    expect(result.confidence).toEqual([0.8, 0.8, 0.8]);
  });

  it('accepts boundary values 0.0 and 1.0', () => {
    const edge = makeEdge();
    const result = setConfidence(edge, 0.0, 0.5, 1.0);
    expect(result.confidence).toEqual([0.0, 0.5, 1.0]);
  });

  it('throws when low > mid', () => {
    const edge = makeEdge();
    expect(() => setConfidence(edge, 0.9, 0.5, 1.0)).toThrow();
  });

  it('throws when mid > high', () => {
    const edge = makeEdge();
    expect(() => setConfidence(edge, 0.3, 0.9, 0.5)).toThrow();
  });

  it('throws when low is negative', () => {
    const edge = makeEdge();
    expect(() => setConfidence(edge, -0.1, 0.5, 0.9)).toThrow();
  });

  it('throws when high exceeds 1.0', () => {
    const edge = makeEdge();
    expect(() => setConfidence(edge, 0.1, 0.5, 1.1)).toThrow();
  });

  it('throws when any value is NaN', () => {
    const edge = makeEdge();
    expect(() => setConfidence(edge, NaN, 0.5, 0.9)).toThrow();
  });

  it('does not modify other edge fields', () => {
    const edge = makeEdge({ fact: 'important fact' });
    setConfidence(edge, 0.2, 0.6, 0.9);
    expect(edge.fact).toBe('important fact');
    expect(edge.name).toBe('TEST_EDGE');
    expect(edge.uuid).toBe('test-uuid');
  });
});

describe('EntityEdge confidence field', () => {
  it('defaults to undefined when not set', () => {
    const edge = makeEdge();
    expect(edge.confidence).toBeUndefined();
  });

  it('can be explicitly set to null', () => {
    const edge = makeEdge({ confidence: null });
    expect(edge.confidence).toBeNull();
  });

  it('can hold a confidence band tuple', () => {
    const edge = makeEdge({ confidence: [0.4, 0.7, 0.9] });
    expect(edge.confidence).toEqual([0.4, 0.7, 0.9]);
  });
});
