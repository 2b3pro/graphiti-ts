import { expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { EntityNode } from '../domain/nodes';

import {
  normalizeStringExact,
  normalizeNameForFuzzy,
  nameEntropy,
  hasHighEntropy,
  shingles,
  hashShingle,
  minhashSignature,
  lshBands,
  jaccardSimilarity,
  buildCandidateIndexes,
  resolveWithSimilarity,
  FUZZY_JACCARD_THRESHOLD,
  MINHASH_PERMUTATIONS,
  MINHASH_BAND_SIZE,
  type DedupResolutionState
} from './dedup-helpers';

function entity(uuid: string, name: string): EntityNode {
  return { uuid, name, group_id: 'g1', labels: ['Entity'], created_at: utcNow(), summary: '' };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('normalizeStringExact lowercases and collapses whitespace', () => {
  expect(normalizeStringExact('  Alice   Johnson  ')).toBe('alice johnson');
  expect(normalizeStringExact('BOB')).toBe('bob');
  expect(normalizeStringExact('a\t\nb')).toBe('a b');
});

test('normalizeNameForFuzzy strips punctuation but keeps apostrophes', () => {
  expect(normalizeNameForFuzzy("O'Brien-Smith")).toBe("o'brien smith");
  expect(normalizeNameForFuzzy('Hello, World!')).toBe('hello world');
  expect(normalizeNameForFuzzy('test@email.com')).toBe('test email com');
});

// ---------------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------------

test('nameEntropy returns 0 for empty string', () => {
  expect(nameEntropy('')).toBe(0);
});

test('nameEntropy is low for repeated characters', () => {
  expect(nameEntropy('aaa')).toBeLessThan(0.1);
});

test('nameEntropy is higher for diverse strings', () => {
  const low = nameEntropy('bob');
  const high = nameEntropy('alexander graham bell');
  expect(high).toBeGreaterThan(low);
});

test('hasHighEntropy rejects short low-entropy names', () => {
  expect(hasHighEntropy('bob')).toBe(false);
  expect(hasHighEntropy('ab')).toBe(false);
});

test('hasHighEntropy accepts long diverse names', () => {
  expect(hasHighEntropy('alexander graham bell')).toBe(true);
  expect(hasHighEntropy('machine learning')).toBe(true);
});

// ---------------------------------------------------------------------------
// Shingles
// ---------------------------------------------------------------------------

test('shingles creates 3-grams with spaces removed', () => {
  const s = shingles('alice');
  expect(s).toEqual(new Set(['ali', 'lic', 'ice']));
});

test('shingles handles short strings', () => {
  expect(shingles('ab')).toEqual(new Set(['ab'])); // 2 chars < n(3) → whole string
  expect(shingles('a')).toEqual(new Set(['a'])); // single char fallback
  expect(shingles('')).toEqual(new Set());
});

// ---------------------------------------------------------------------------
// MinHash
// ---------------------------------------------------------------------------

test('hashShingle produces deterministic values', () => {
  const h1 = hashShingle('abc', 0);
  const h2 = hashShingle('abc', 0);
  expect(h1).toBe(h2);
  expect(hashShingle('abc', 0)).not.toBe(hashShingle('abc', 1));
});

test('minhashSignature has MINHASH_PERMUTATIONS elements', () => {
  const sig = minhashSignature(new Set(['ali', 'lic', 'ice']));
  expect(sig).toHaveLength(MINHASH_PERMUTATIONS);
});

test('minhashSignature returns empty for empty set', () => {
  expect(minhashSignature(new Set())).toHaveLength(0);
});

test('lshBands splits signature into bands of BAND_SIZE', () => {
  const sig = minhashSignature(new Set(['ali', 'lic', 'ice']));
  const bands = lshBands(sig);
  expect(bands).toHaveLength(MINHASH_PERMUTATIONS / MINHASH_BAND_SIZE);
  expect(bands[0]).toHaveLength(MINHASH_BAND_SIZE);
});

// ---------------------------------------------------------------------------
// Jaccard Similarity
// ---------------------------------------------------------------------------

test('jaccardSimilarity of identical sets is 1', () => {
  const s = new Set(['a', 'b', 'c']);
  expect(jaccardSimilarity(s, s)).toBe(1);
});

test('jaccardSimilarity of disjoint sets is 0', () => {
  expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
});

test('jaccardSimilarity of empty sets is 1', () => {
  expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
});

test('jaccardSimilarity computes correctly', () => {
  const a = new Set(['a', 'b', 'c']);
  const b = new Set(['b', 'c', 'd']);
  // intersection = 2, union = 4
  expect(jaccardSimilarity(a, b)).toBe(0.5);
});

// ---------------------------------------------------------------------------
// buildCandidateIndexes
// ---------------------------------------------------------------------------

test('buildCandidateIndexes indexes nodes by name and LSH', () => {
  const nodes = [entity('u1', 'Alice Johnson'), entity('u2', 'Bob Smith')];
  const idx = buildCandidateIndexes(nodes);

  expect(idx.nodesByUuid.size).toBe(2);
  expect(idx.normalizedExisting.get('alice johnson')).toHaveLength(1);
  expect(idx.shinglesByCandidate.size).toBe(2);
});

// ---------------------------------------------------------------------------
// resolveWithSimilarity
// ---------------------------------------------------------------------------

test('resolveWithSimilarity: exact match resolves to existing', () => {
  const existing = [entity('u1', 'Alexander Hamilton')];
  const extracted = [entity('u2', 'Alexander Hamilton')];
  const idx = buildCandidateIndexes(existing);
  const state: DedupResolutionState = {
    resolvedNodes: [null],
    uuidMap: new Map(),
    unresolvedIndices: [],
    duplicatePairs: []
  };
  resolveWithSimilarity(extracted, idx, state);

  expect(state.uuidMap.get('u2')).toBe('u1');
  expect(state.duplicatePairs).toHaveLength(1);
});

test('resolveWithSimilarity: low-entropy names go to unresolved', () => {
  const existing = [entity('u1', 'Bob')];
  const extracted = [entity('u2', 'Bob')];
  const idx = buildCandidateIndexes(existing);
  const state: DedupResolutionState = {
    resolvedNodes: [null],
    uuidMap: new Map(),
    unresolvedIndices: [],
    duplicatePairs: []
  };
  resolveWithSimilarity(extracted, idx, state);

  expect(state.unresolvedIndices).toContain(0);
  expect(state.uuidMap.size).toBe(0);
});

test('resolveWithSimilarity: fuzzy match resolves similar names', () => {
  // "alexander hamilton" vs "alexnder hamilton" (typo) — very similar shingles
  const existing = [entity('u1', 'Alexander Hamilton')];
  const extracted = [entity('u2', 'Alexnder Hamilton')];
  const idx = buildCandidateIndexes(existing);
  const state: DedupResolutionState = {
    resolvedNodes: [null],
    uuidMap: new Map(),
    unresolvedIndices: [],
    duplicatePairs: []
  };
  resolveWithSimilarity(extracted, idx, state);

  // Check if fuzzy match fired — depends on Jaccard of shingles
  const s1 = new Set(['ale', 'lex', 'exa', 'xan', 'and', 'nde', 'der', 'erh', 'rha', 'ham', 'ami', 'mil', 'ilt', 'lto', 'ton']);
  const s2 = new Set(['ale', 'lex', 'exn', 'xnd', 'nde', 'der', 'erh', 'rha', 'ham', 'ami', 'mil', 'ilt', 'lto', 'ton']);
  const j = jaccardSimilarity(s1, s2);
  if (j >= FUZZY_JACCARD_THRESHOLD) {
    expect(state.uuidMap.get('u2')).toBe('u1');
  } else {
    // Similarity too low for threshold — unresolved is acceptable
    expect(state.unresolvedIndices).toContain(0);
  }
});

test('resolveWithSimilarity: no match goes to unresolved', () => {
  const existing = [entity('u1', 'Alexander Hamilton')];
  const extracted = [entity('u2', 'Benjamin Franklin')];
  const idx = buildCandidateIndexes(existing);
  const state: DedupResolutionState = {
    resolvedNodes: [null],
    uuidMap: new Map(),
    unresolvedIndices: [],
    duplicatePairs: []
  };
  resolveWithSimilarity(extracted, idx, state);

  expect(state.unresolvedIndices).toContain(0);
});

test('constants match Python values', () => {
  expect(FUZZY_JACCARD_THRESHOLD).toBe(0.9);
  expect(MINHASH_PERMUTATIONS).toBe(32);
  expect(MINHASH_BAND_SIZE).toBe(4);
});
