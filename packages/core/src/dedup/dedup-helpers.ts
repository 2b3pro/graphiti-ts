import { createHash } from 'node:crypto';

import type { EntityNode } from '../domain/nodes';

// ---------------------------------------------------------------------------
// Constants (matching Python dedup_helpers.py)
// ---------------------------------------------------------------------------

export const NAME_ENTROPY_THRESHOLD = 1.5;
export const MIN_NAME_LENGTH = 6;
export const MIN_TOKEN_COUNT = 2;
export const FUZZY_JACCARD_THRESHOLD = 0.9;
export const MINHASH_PERMUTATIONS = 32;
export const MINHASH_BAND_SIZE = 4;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeStringExact(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeNameForFuzzy(name: string): string {
  const exact = normalizeStringExact(name);
  // Use \w (Unicode word chars) instead of [a-z0-9] to preserve CJK and other non-Latin scripts
  const cleaned = exact.replace(/[^\w' ]/g, ' ').trim();
  return cleaned.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------------

export function nameEntropy(normalizedName: string): number {
  if (!normalizedName) return 0.0;

  const stripped = normalizedName.replace(/ /g, '');
  if (stripped.length === 0) return 0.0;

  const counts = new Map<string, number>();
  for (const char of stripped) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  const total = stripped.length;
  let entropy = 0.0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

export function hasHighEntropy(normalizedName: string): boolean {
  const tokenCount = normalizedName.split(' ').length;
  if (normalizedName.length < MIN_NAME_LENGTH && tokenCount < MIN_TOKEN_COUNT) {
    return false;
  }
  return nameEntropy(normalizedName) >= NAME_ENTROPY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// CJK Detection
// ---------------------------------------------------------------------------

export function hasCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
      (cp >= 0x3000 && cp <= 0x303f) ||   // CJK Symbols and Punctuation
      (cp >= 0x3040 && cp <= 0x30ff) ||   // Hiragana + Katakana
      (cp >= 0xac00 && cp <= 0xd7af)      // Hangul Syllables
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shingles (n-gram: 2 for CJK, 3 for Latin)
// ---------------------------------------------------------------------------

export function shingles(normalizedName: string): Set<string> {
  const cleaned = normalizedName.replace(/ /g, '');
  if (cleaned.length < 2) {
    return cleaned.length > 0 ? new Set([cleaned]) : new Set();
  }

  const n = hasCjk(cleaned) ? 2 : 3;
  if (cleaned.length < n) {
    return new Set([cleaned]);
  }

  const result = new Set<string>();
  for (let i = 0; i <= cleaned.length - n; i++) {
    result.add(cleaned.substring(i, i + n));
  }
  return result;
}

// ---------------------------------------------------------------------------
// MinHash
// ---------------------------------------------------------------------------

export function hashShingle(shingle: string, seed: number): number {
  const h = createHash('blake2b512');
  h.update(`${seed}:${shingle}`);
  const buf = h.digest();
  // Read first 8 bytes as unsigned 64-bit BE, convert to Number
  // Using DataView for portability; values fit in Number's safe range for comparison
  const hi = buf.readUInt32BE(0);
  const lo = buf.readUInt32BE(4);
  return hi * 0x100000000 + lo;
}

export function minhashSignature(shingleSet: Set<string>): number[] {
  if (shingleSet.size === 0) return [];

  const signature: number[] = [];
  const shingleArray = [...shingleSet];

  for (let seed = 0; seed < MINHASH_PERMUTATIONS; seed++) {
    let minHash = Infinity;
    for (const s of shingleArray) {
      const h = hashShingle(s, seed);
      if (h < minHash) minHash = h;
    }
    signature.push(minHash);
  }

  return signature;
}

export function lshBands(signature: number[]): number[][] {
  if (signature.length === 0) return [];

  const bands: number[][] = [];
  for (let start = 0; start < signature.length; start += MINHASH_BAND_SIZE) {
    const band = signature.slice(start, start + MINHASH_BAND_SIZE);
    if (band.length === MINHASH_BAND_SIZE) {
      bands.push(band);
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Jaccard Similarity
// ---------------------------------------------------------------------------

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

// ---------------------------------------------------------------------------
// Candidate Index
// ---------------------------------------------------------------------------

export interface DedupCandidateIndexes {
  existingNodes: EntityNode[];
  nodesByUuid: Map<string, EntityNode>;
  normalizedExisting: Map<string, EntityNode[]>;
  shinglesByCandidate: Map<string, Set<string>>;
  lshBuckets: Map<string, string[]>;
}

function bandKey(bandIndex: number, band: number[]): string {
  return `${bandIndex}:${band.join(',')}`;
}

export function buildCandidateIndexes(existingNodes: EntityNode[]): DedupCandidateIndexes {
  const normalizedExisting = new Map<string, EntityNode[]>();
  const nodesByUuid = new Map<string, EntityNode>();
  const shinglesByCandidate = new Map<string, Set<string>>();
  const lshBuckets = new Map<string, string[]>();

  for (const candidate of existingNodes) {
    const normalized = normalizeStringExact(candidate.name);
    const existing = normalizedExisting.get(normalized);
    if (existing) {
      existing.push(candidate);
    } else {
      normalizedExisting.set(normalized, [candidate]);
    }
    nodesByUuid.set(candidate.uuid, candidate);

    const s = shingles(normalizeNameForFuzzy(candidate.name));
    shinglesByCandidate.set(candidate.uuid, s);

    const signature = minhashSignature(s);
    const bands = lshBands(signature);
    for (let bi = 0; bi < bands.length; bi++) {
      const key = bandKey(bi, bands[bi]);
      const bucket = lshBuckets.get(key);
      if (bucket) {
        bucket.push(candidate.uuid);
      } else {
        lshBuckets.set(key, [candidate.uuid]);
      }
    }
  }

  return { existingNodes, nodesByUuid, normalizedExisting, shinglesByCandidate, lshBuckets };
}

// ---------------------------------------------------------------------------
// Resolution State
// ---------------------------------------------------------------------------

export interface DedupResolutionState {
  resolvedNodes: (EntityNode | null)[];
  uuidMap: Map<string, string>;
  unresolvedIndices: number[];
  duplicatePairs: [EntityNode, EntityNode][];
}

// ---------------------------------------------------------------------------
// Deterministic Resolution (exact + fuzzy)
// ---------------------------------------------------------------------------

export function resolveWithSimilarity(
  extractedNodes: EntityNode[],
  indexes: DedupCandidateIndexes,
  state: DedupResolutionState
): void {
  for (let idx = 0; idx < extractedNodes.length; idx++) {
    const node = extractedNodes[idx];
    const normalizedExact = normalizeStringExact(node.name);
    const normalizedFuzzy = normalizeNameForFuzzy(node.name);

    if (!hasHighEntropy(normalizedFuzzy)) {
      state.unresolvedIndices.push(idx);
      continue;
    }

    // Exact match
    const existingMatches = indexes.normalizedExisting.get(normalizedExact) ?? [];
    if (existingMatches.length === 1) {
      const match = existingMatches[0];
      state.resolvedNodes[idx] = match;
      state.uuidMap.set(node.uuid, match.uuid);
      if (match.uuid !== node.uuid) {
        state.duplicatePairs.push([node, match]);
      }
      continue;
    }
    if (existingMatches.length > 1) {
      state.unresolvedIndices.push(idx);
      continue;
    }

    // Fuzzy match via LSH
    const nodeShingles = shingles(normalizedFuzzy);
    const signature = minhashSignature(nodeShingles);
    const candidateIds = new Set<string>();
    const bands = lshBands(signature);
    for (let bi = 0; bi < bands.length; bi++) {
      const key = bandKey(bi, bands[bi]);
      const bucket = indexes.lshBuckets.get(key);
      if (bucket) {
        for (const id of bucket) candidateIds.add(id);
      }
    }

    let bestCandidate: EntityNode | null = null;
    let bestScore = 0.0;
    for (const candidateId of candidateIds) {
      const candidateShingles = indexes.shinglesByCandidate.get(candidateId);
      if (!candidateShingles) continue;
      const score = jaccardSimilarity(nodeShingles, candidateShingles);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = indexes.nodesByUuid.get(candidateId) ?? null;
      }
    }

    if (bestCandidate !== null && bestScore >= FUZZY_JACCARD_THRESHOLD) {
      state.resolvedNodes[idx] = bestCandidate;
      state.uuidMap.set(node.uuid, bestCandidate.uuid);
      if (bestCandidate.uuid !== node.uuid) {
        state.duplicatePairs.push([node, bestCandidate]);
      }
      continue;
    }

    state.unresolvedIndices.push(idx);
  }
}
