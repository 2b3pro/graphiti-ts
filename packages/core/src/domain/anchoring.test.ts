import { describe, expect, test } from 'bun:test';
import {
  type AnchoredInterpretation,
  type AnchorType,
  ANCHOR_TYPES,
  computeAnchorConfidence,
  type AnchorGraphContext,
} from './anchoring';
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

describe('computeAnchorConfidence', () => {
  test('self-anchored edge (no anchored_by) returns 1.0', () => {
    const edge = makeEdge();
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });

  test('empty anchored_by returns 1.0', () => {
    const edge = makeEdge({ anchored_by: [] });
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });

  test('single valid anchor returns anchor mid-confidence', () => {
    const anchor = makeEdge({ uuid: 'anchor-1', confidence: [0.7, 0.9, 1.0] });
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.9);
  });

  test('missing anchor returns 0.0', () => {
    const edge = makeEdge({ anchored_by: ['nonexistent'] });
    const ctx: AnchorGraphContext = { getEdge: () => null };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.0);
  });

  test('deprecated anchor returns 0.0', () => {
    const anchor = makeEdge({ uuid: 'anchor-1', invalid_at: new Date(), confidence: [0.8, 0.9, 1.0] });
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.0);
  });

  test('best anchor wins (max, not average)', () => {
    const weakAnchor = makeEdge({ uuid: 'anchor-weak', confidence: [0.1, 0.2, 0.3] });
    const strongAnchor = makeEdge({ uuid: 'anchor-strong', confidence: [0.8, 0.95, 1.0] });
    const edge = makeEdge({ anchored_by: ['anchor-weak', 'anchor-strong'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'anchor-weak') return weakAnchor;
        if (uuid === 'anchor-strong') return strongAnchor;
        return null;
      },
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(0.95);
  });

  test('recursive: anchor has its own anchor', () => {
    const rootAnchor = makeEdge({ uuid: 'root', confidence: [0.7, 0.8, 0.9] });
    const midAnchor = makeEdge({ uuid: 'mid', anchored_by: ['root'], confidence: [0.8, 0.9, 1.0] });
    const edge = makeEdge({ anchored_by: ['mid'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'root') return rootAnchor;
        if (uuid === 'mid') return midAnchor;
        return null;
      },
    };
    // mid's anchor confidence = root's mid-confidence = 0.8
    // mid's effective confidence = 0.8 * 0.9 = 0.72
    expect(computeAnchorConfidence(edge, ctx)).toBeCloseTo(0.72, 2);
  });

  test('cycle detection prevents infinite recursion', () => {
    const edgeA = makeEdge({ uuid: 'a', anchored_by: ['b'], confidence: [0.5, 0.8, 1.0] });
    const edgeB = makeEdge({ uuid: 'b', anchored_by: ['a'], confidence: [0.5, 0.8, 1.0] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'a') return edgeA;
        if (uuid === 'b') return edgeB;
        return null;
      },
    };
    const result = computeAnchorConfidence(edgeA, ctx);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test('diamond dependency: shared anchor not penalized', () => {
    // E → {B, C}, B → {C}  — C should not be penalized when evaluated as E's direct anchor
    const anchorC = makeEdge({ uuid: 'c', confidence: [0.7, 0.9, 1.0] });
    const anchorB = makeEdge({ uuid: 'b', anchored_by: ['c'], confidence: [0.6, 0.8, 1.0] });
    const edge = makeEdge({ anchored_by: ['b', 'c'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => {
        if (uuid === 'b') return anchorB;
        if (uuid === 'c') return anchorC;
        return null;
      },
    };
    const result = computeAnchorConfidence(edge, ctx);
    // B's chain: C's conf (0.9) × B's own (0.8) = 0.72
    // C's direct: 0.9
    // max(0.72, 0.9) = 0.9
    expect(result).toBe(0.9);
  });

  test('anchor with no confidence band defaults to 1.0', () => {
    const anchor = makeEdge({ uuid: 'anchor-1' });
    const edge = makeEdge({ anchored_by: ['anchor-1'] });
    const ctx: AnchorGraphContext = {
      getEdge: (uuid) => (uuid === 'anchor-1' ? anchor : null),
    };
    expect(computeAnchorConfidence(edge, ctx)).toBe(1.0);
  });
});

describe('ANCHOR_TYPES', () => {
  test('contains all expected types', () => {
    expect(ANCHOR_TYPES).toContain('scale');
    expect(ANCHOR_TYPES).toContain('definition');
    expect(ANCHOR_TYPES).toContain('baseline');
    expect(ANCHOR_TYPES).toContain('comparison');
    expect(ANCHOR_TYPES).toContain('taxonomy');
    expect(ANCHOR_TYPES).toContain('temporal_frame');
    expect(ANCHOR_TYPES).toContain('scope');
    expect(ANCHOR_TYPES).toContain('methodology');
  });
});
