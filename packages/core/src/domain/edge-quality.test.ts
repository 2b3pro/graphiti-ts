import { describe, expect, it } from 'bun:test';
import { computeEdgeQuality, shouldCreateEdge, type EdgeQualityScore } from './edge-quality';

// ---------------------------------------------------------------------------
// computeEdgeQuality
// ---------------------------------------------------------------------------

describe('computeEdgeQuality', () => {
  it('computes composite as persistence*3 + specificity*2 + novelty*2', () => {
    const result = computeEdgeQuality({ persistence: 3, specificity: 4, novelty: 2 });
    // 3*3 + 4*2 + 2*2 = 9 + 8 + 4 = 21
    expect(result.composite).toBe(21);
  });

  it('returns skip tier for composite <= 6', () => {
    // Min: 1*3 + 1*2 + 1*2 = 7 — that's already above 6
    // So we need persistence=1, specificity=1, novelty=0 (if 0 is allowed) or all sub-1
    // Actually with integers 1-5, minimum is 7. Let's test exact boundary.
    const result = computeEdgeQuality({ persistence: 1, specificity: 1, novelty: 0 });
    // 1*3 + 1*2 + 0*2 = 5
    expect(result.composite).toBe(5);
    expect(result.tier).toBe('skip');
  });

  it('returns skip tier at boundary composite = 6', () => {
    const result = computeEdgeQuality({ persistence: 2, specificity: 0, novelty: 0 });
    // 2*3 + 0 + 0 = 6
    expect(result.composite).toBe(6);
    expect(result.tier).toBe('skip');
  });

  it('returns low tier for composite 7-14', () => {
    const result = computeEdgeQuality({ persistence: 1, specificity: 1, novelty: 1 });
    // 1*3 + 1*2 + 1*2 = 7
    expect(result.composite).toBe(7);
    expect(result.tier).toBe('low');
  });

  it('returns low tier at upper boundary composite = 14', () => {
    const result = computeEdgeQuality({ persistence: 2, specificity: 2, novelty: 2 });
    // 2*3 + 2*2 + 2*2 = 6 + 4 + 4 = 14
    expect(result.composite).toBe(14);
    expect(result.tier).toBe('low');
  });

  it('returns standard tier for composite 15-24', () => {
    const result = computeEdgeQuality({ persistence: 3, specificity: 3, novelty: 3 });
    // 3*3 + 3*2 + 3*2 = 9 + 6 + 6 = 21
    expect(result.composite).toBe(21);
    expect(result.tier).toBe('standard');
  });

  it('returns standard tier at upper boundary composite = 24', () => {
    const result = computeEdgeQuality({ persistence: 4, specificity: 4, novelty: 2 });
    // 4*3 + 4*2 + 2*2 = 12 + 8 + 4 = 24
    expect(result.composite).toBe(24);
    expect(result.tier).toBe('standard');
  });

  it('returns high tier for composite 25-35', () => {
    const result = computeEdgeQuality({ persistence: 5, specificity: 5, novelty: 5 });
    // 5*3 + 5*2 + 5*2 = 15 + 10 + 10 = 35
    expect(result.composite).toBe(35);
    expect(result.tier).toBe('high');
  });

  it('returns high tier at lower boundary composite = 25', () => {
    const result = computeEdgeQuality({ persistence: 5, specificity: 3, novelty: 2 });
    // 5*3 + 3*2 + 2*2 = 15 + 6 + 4 = 25
    expect(result.composite).toBe(25);
    expect(result.tier).toBe('high');
  });

  it('preserves input scores in result', () => {
    const result = computeEdgeQuality({ persistence: 4, specificity: 3, novelty: 5 });
    expect(result.persistence).toBe(4);
    expect(result.specificity).toBe(3);
    expect(result.novelty).toBe(5);
  });

  it('handles maximum scores correctly', () => {
    const result = computeEdgeQuality({ persistence: 5, specificity: 5, novelty: 5 });
    expect(result.composite).toBe(35);
    expect(result.tier).toBe('high');
  });

  it('handles minimum scores correctly', () => {
    const result = computeEdgeQuality({ persistence: 0, specificity: 0, novelty: 0 });
    expect(result.composite).toBe(0);
    expect(result.tier).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// shouldCreateEdge
// ---------------------------------------------------------------------------

describe('shouldCreateEdge', () => {
  it('returns false for skip tier', () => {
    const quality = computeEdgeQuality({ persistence: 1, specificity: 0, novelty: 0 });
    expect(quality.tier).toBe('skip');
    expect(shouldCreateEdge(quality)).toBe(false);
  });

  it('returns true for low tier', () => {
    const quality = computeEdgeQuality({ persistence: 1, specificity: 1, novelty: 1 });
    expect(quality.tier).toBe('low');
    expect(shouldCreateEdge(quality)).toBe(true);
  });

  it('returns true for standard tier', () => {
    const quality = computeEdgeQuality({ persistence: 3, specificity: 3, novelty: 3 });
    expect(quality.tier).toBe('standard');
    expect(shouldCreateEdge(quality)).toBe(true);
  });

  it('returns true for high tier', () => {
    const quality = computeEdgeQuality({ persistence: 5, specificity: 5, novelty: 5 });
    expect(quality.tier).toBe('high');
    expect(shouldCreateEdge(quality)).toBe(true);
  });
});
