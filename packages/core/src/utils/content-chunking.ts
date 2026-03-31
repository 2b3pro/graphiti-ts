/**
 * Content chunking utilities — port of Python's graphiti_core/utils/content_chunking.py.
 *
 * Splits large content into smaller overlapping chunks that preserve
 * natural boundaries (sentences, JSON elements, message boundaries).
 */

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from text length (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Determine whether content should be chunked.
 * Returns true if content exceeds chunkSizeTokens and is likely entity-dense.
 */
export function shouldChunk(
  content: string,
  episodeType: 'message' | 'json' | 'text',
  chunkSizeTokens = 1000
): boolean {
  const tokens = estimateTokens(content);
  if (tokens <= chunkSizeTokens) return false;
  return estimateHighDensity(content, episodeType, tokens);
}

function estimateHighDensity(
  content: string,
  episodeType: 'message' | 'json' | 'text',
  tokens: number
): boolean {
  if (episodeType === 'json') return jsonLikelyDense(content, tokens);
  return textLikelyDense(content, tokens);
}

function jsonLikelyDense(content: string, tokens: number): boolean {
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      return data.length > tokens / 50;
    }
    if (typeof data === 'object' && data !== null) {
      return countJsonKeys(data, 3) > tokens / 50;
    }
  } catch {
    // Not valid JSON — fall through to text heuristic
  }
  return textLikelyDense(content, tokens);
}

function countJsonKeys(data: Record<string, unknown>, maxDepth: number, depth = 0): number {
  if (depth >= maxDepth) return 0;
  let count = Object.keys(data).length;
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      count += countJsonKeys(value as Record<string, unknown>, maxDepth, depth + 1);
    }
  }
  return count;
}

function textLikelyDense(content: string, tokens: number): boolean {
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w));
  const ratio = words.length > 0 ? capitalizedWords.length / words.length : 0;
  return ratio > 0.15 || tokens > 2000;
}

/**
 * Chunk JSON content at element/key boundaries.
 */
export function chunkJsonContent(
  content: string,
  chunkSizeTokens = 1000,
  overlapTokens = 100
): string[] {
  const chunkSizeChars = chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      return chunkJsonArray(data, chunkSizeChars, overlapChars);
    }
    if (typeof data === 'object' && data !== null) {
      return chunkJsonObject(data, chunkSizeChars, overlapChars);
    }
  } catch {
    // Not valid JSON — fall through to text chunking
  }

  return chunkTextContent(content, chunkSizeTokens, overlapTokens);
}

function chunkJsonArray(
  data: unknown[],
  chunkSizeChars: number,
  overlapChars: number
): string[] {
  const chunks: string[] = [];
  let currentElements: unknown[] = [];
  let currentSize = 2; // account for []

  for (const element of data) {
    const elementStr = JSON.stringify(element);
    const elementSize = elementStr.length + 2; // comma + space

    if (currentSize + elementSize > chunkSizeChars && currentElements.length > 0) {
      chunks.push(JSON.stringify(currentElements));
      // Overlap: take last elements that fit
      currentElements = getOverlapElements(currentElements, overlapChars);
      currentSize = JSON.stringify(currentElements).length;
    }

    currentElements.push(element);
    currentSize += elementSize;
  }

  if (currentElements.length > 0) {
    chunks.push(JSON.stringify(currentElements));
  }

  return chunks.length > 0 ? chunks : [JSON.stringify(data)];
}

function getOverlapElements(elements: unknown[], overlapChars: number): unknown[] {
  const result: unknown[] = [];
  let size = 0;

  for (let i = elements.length - 1; i >= 0; i--) {
    const elementSize = JSON.stringify(elements[i]).length + 2;
    if (size + elementSize > overlapChars) break;
    result.unshift(elements[i]);
    size += elementSize;
  }

  return result;
}

function chunkJsonObject(
  data: Record<string, unknown>,
  chunkSizeChars: number,
  overlapChars: number
): string[] {
  const chunks: string[] = [];
  const keys = Object.keys(data);
  let currentObj: Record<string, unknown> = {};
  let currentSize = 2; // account for {}

  for (const key of keys) {
    const pairStr = JSON.stringify({ [key]: data[key] });
    const pairSize = pairStr.length;

    if (currentSize + pairSize > chunkSizeChars && Object.keys(currentObj).length > 0) {
      chunks.push(JSON.stringify(currentObj));
      // Overlap: take last key-value pairs that fit
      currentObj = getOverlapDict(data, Object.keys(currentObj), overlapChars);
      currentSize = JSON.stringify(currentObj).length;
    }

    currentObj[key] = data[key];
    currentSize += pairSize;
  }

  if (Object.keys(currentObj).length > 0) {
    chunks.push(JSON.stringify(currentObj));
  }

  return chunks.length > 0 ? chunks : [JSON.stringify(data)];
}

function getOverlapDict(
  data: Record<string, unknown>,
  usedKeys: string[],
  overlapChars: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let size = 0;

  for (let i = usedKeys.length - 1; i >= 0; i--) {
    const key = usedKeys[i]!;
    const pairSize = JSON.stringify({ [key]: data[key] }).length;
    if (size + pairSize > overlapChars) break;
    result[key] = data[key];
    size += pairSize;
  }

  return result;
}

/**
 * Chunk text content at paragraph/sentence boundaries.
 */
export function chunkTextContent(
  content: string,
  chunkSizeTokens = 1000,
  overlapTokens = 100
): string[] {
  const chunkSizeChars = chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  if (content.length <= chunkSizeChars) return [content];

  // Try splitting by paragraphs first
  const paragraphs = content.split(/\n\n+/);
  if (paragraphs.length > 1) {
    return chunkByParts(paragraphs, chunkSizeChars, overlapChars, '\n\n');
  }

  // Fall back to sentence splitting
  return chunkBySentences(content, chunkSizeChars, overlapChars);
}

function chunkBySentences(
  text: string,
  chunkSizeChars: number,
  overlapChars: number
): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  return chunkByParts(sentences, chunkSizeChars, overlapChars, '');
}

function chunkByParts(
  parts: string[],
  chunkSizeChars: number,
  overlapChars: number,
  separator: string
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentSize = 0;

  for (const part of parts) {
    const partSize = part.length + separator.length;

    if (currentSize + partSize > chunkSizeChars && current.length > 0) {
      chunks.push(current.join(separator).trim());
      // Overlap: take last parts that fit
      const overlap = getOverlapParts(current, overlapChars, separator);
      current = overlap;
      currentSize = overlap.reduce((sum, p) => sum + p.length + separator.length, 0);
    }

    current.push(part);
    currentSize += partSize;
  }

  if (current.length > 0) {
    chunks.push(current.join(separator).trim());
  }

  return chunks;
}

function getOverlapParts(
  parts: string[],
  overlapChars: number,
  separator: string
): string[] {
  const result: string[] = [];
  let size = 0;

  for (let i = parts.length - 1; i >= 0; i--) {
    const partSize = parts[i]!.length + separator.length;
    if (size + partSize > overlapChars) break;
    result.unshift(parts[i]!);
    size += partSize;
  }

  return result;
}

/**
 * Chunk message content preserving message boundaries.
 * Supports JSON arrays of messages or "Speaker: message" format.
 */
export function chunkMessageContent(
  content: string,
  chunkSizeTokens = 1000,
  overlapTokens = 100
): string[] {
  const chunkSizeChars = chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  // Try JSON array of messages
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      return chunkJsonArray(data, chunkSizeChars, overlapChars);
    }
  } catch {
    // Not JSON — try speaker format
  }

  // Try "Speaker: message" line format
  const lines = content.split('\n');
  if (lines.some((line) => /^[A-Za-z\s]+:/.test(line))) {
    return chunkByParts(lines, chunkSizeChars, overlapChars, '\n');
  }

  // Fall back to text chunking
  return chunkTextContent(content, chunkSizeTokens, overlapTokens);
}
