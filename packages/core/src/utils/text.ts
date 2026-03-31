export const MAX_SUMMARY_CHARS = 500;

const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * Escape Lucene special characters in a query string.
 * Port of Python's lucene_sanitize().
 */
export function luceneSanitize(query: string): string {
  return query.replace(LUCENE_SPECIAL_CHARS, '\\$&');
}

/**
 * L2-normalize an embedding vector.
 * Port of Python's normalize_l2() (without numpy dependency).
 */
export function normalizeL2(embedding: number[]): number[] {
  let sumSquared = 0;
  for (const value of embedding) {
    sumSquared += value * value;
  }
  const norm = Math.sqrt(sumSquared);

  if (norm === 0) return embedding;

  return embedding.map((value) => value / norm);
}

/**
 * Truncate text at the last sentence boundary within maxChars.
 * Port of Python's truncate_at_sentence().
 */
/**
 * Build a sanitized fulltext search query string.
 * Port of Python's driver.build_fulltext_query().
 */
export function buildFulltextQuery(
  query: string,
  groupIds?: string[] | null,
  maxQueryLength = 8000
): string {
  let sanitized = luceneSanitize(query);

  // Truncate if needed
  if (sanitized.length > maxQueryLength) {
    sanitized = sanitized.slice(0, maxQueryLength);
  }

  return sanitized.trim();
}

export function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);

  // Find last sentence-ending punctuation
  let lastSentenceEnd = -1;
  for (let i = truncated.length - 1; i >= 0; i--) {
    if (truncated[i] === '.' || truncated[i] === '!' || truncated[i] === '?') {
      lastSentenceEnd = i;
      break;
    }
  }

  if (lastSentenceEnd > 0) {
    return truncated.slice(0, lastSentenceEnd + 1).trimEnd();
  }

  // No sentence boundary found — hard truncate
  return truncated.trimEnd();
}
