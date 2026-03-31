import { describe, expect, test } from 'bun:test';

import {
  luceneSanitize,
  normalizeL2,
  truncateAtSentence,
  buildFulltextQuery,
  MAX_SUMMARY_CHARS
} from './text';

// ---------------------------------------------------------------------------
// luceneSanitize
// ---------------------------------------------------------------------------

describe('luceneSanitize', () => {
  test('escapes all Lucene special characters', () => {
    // Verify each special char gets escaped with a backslash
    expect(luceneSanitize('a+b')).toBe('a\\+b');
    expect(luceneSanitize('a-b')).toBe('a\\-b');
    expect(luceneSanitize('a&b')).toBe('a\\&b');
    expect(luceneSanitize('a|b')).toBe('a\\|b');
    expect(luceneSanitize('a!b')).toBe('a\\!b');
    expect(luceneSanitize('a(b')).toBe('a\\(b');
    expect(luceneSanitize('a)b')).toBe('a\\)b');
    expect(luceneSanitize('a{b')).toBe('a\\{b');
    expect(luceneSanitize('a}b')).toBe('a\\}b');
    expect(luceneSanitize('a[b')).toBe('a\\[b');
    expect(luceneSanitize('a]b')).toBe('a\\]b');
    expect(luceneSanitize('a^b')).toBe('a\\^b');
    expect(luceneSanitize('a"b')).toBe('a\\"b');
    expect(luceneSanitize('a~b')).toBe('a\\~b');
    expect(luceneSanitize('a*b')).toBe('a\\*b');
    expect(luceneSanitize('a?b')).toBe('a\\?b');
    expect(luceneSanitize('a:b')).toBe('a\\:b');
  });

  test('leaves normal text unchanged', () => {
    expect(luceneSanitize('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(luceneSanitize('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeL2
// ---------------------------------------------------------------------------

describe('normalizeL2', () => {
  test('normalizes a non-zero vector to unit length', () => {
    const input = [3, 4];
    const result = normalizeL2(input);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
    // Verify unit length
    const magnitude = Math.sqrt(result[0]! ** 2 + result[1]! ** 2);
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  test('returns zero vector unchanged', () => {
    const input = [0, 0, 0];
    const result = normalizeL2(input);
    expect(result).toEqual([0, 0, 0]);
  });

  test('handles single-element vector', () => {
    const result = normalizeL2([5]);
    expect(result[0]).toBeCloseTo(1.0, 5);
  });

  test('handles empty vector', () => {
    expect(normalizeL2([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// truncateAtSentence
// ---------------------------------------------------------------------------

describe('truncateAtSentence', () => {
  test('returns text unchanged when under maxChars', () => {
    expect(truncateAtSentence('Short text.', 100)).toBe('Short text.');
  });

  test('truncates at last sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence is very long.';
    const result = truncateAtSentence(text, 35);
    expect(result).toBe('First sentence. Second sentence.');
  });

  test('truncates at exclamation mark boundary', () => {
    const text = 'Hello! How are you? I am fine.';
    const result = truncateAtSentence(text, 10);
    expect(result).toBe('Hello!');
  });

  test('truncates at question mark boundary', () => {
    const text = 'What? Really! No way.';
    const result = truncateAtSentence(text, 8);
    expect(result).toBe('What?');
  });

  test('hard truncates when no sentence boundary found', () => {
    const text = 'no punctuation here at all just words';
    const result = truncateAtSentence(text, 15);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test('handles empty string', () => {
    expect(truncateAtSentence('', 100)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildFulltextQuery
// ---------------------------------------------------------------------------

describe('buildFulltextQuery', () => {
  test('sanitizes special characters in query', () => {
    const result = buildFulltextQuery('hello + world');
    expect(result).toContain('\\+');
  });

  test('truncates long queries to maxQueryLength', () => {
    const longQuery = 'a'.repeat(10000);
    const result = buildFulltextQuery(longQuery, null, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  test('trims whitespace', () => {
    const result = buildFulltextQuery('  hello  ');
    expect(result).toBe('hello');
  });

  test('handles empty query', () => {
    expect(buildFulltextQuery('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// MAX_SUMMARY_CHARS
// ---------------------------------------------------------------------------

describe('MAX_SUMMARY_CHARS', () => {
  test('is defined as a positive number', () => {
    expect(MAX_SUMMARY_CHARS).toBeGreaterThan(0);
    expect(MAX_SUMMARY_CHARS).toBe(500);
  });
});
