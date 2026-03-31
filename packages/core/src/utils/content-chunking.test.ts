import { describe, expect, test } from 'bun:test';

import {
  estimateTokens,
  shouldChunk,
  chunkJsonContent,
  chunkTextContent,
  chunkMessageContent
} from './content-chunking';

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  test('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  test('rounds up for partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldChunk
// ---------------------------------------------------------------------------

describe('shouldChunk', () => {
  test('returns false for short content', () => {
    expect(shouldChunk('Hello world', 'text', 1000)).toBe(false);
  });

  test('returns false for content exactly at threshold', () => {
    const content = 'a'.repeat(4000); // 1000 tokens at 4 chars/token
    expect(shouldChunk(content, 'text', 1000)).toBe(false);
  });

  test('returns true for long text content with high density', () => {
    // Create a long text with many capitalized words (> 0.15 ratio)
    const words = Array.from({ length: 500 }, (_, i) =>
      i % 3 === 0 ? 'EntityName' : 'word'
    );
    const content = words.join(' ');
    expect(shouldChunk(content, 'text', 100)).toBe(true);
  });

  test('returns true for very long text over 2000 tokens', () => {
    const content = 'a '.repeat(5000); // > 2000 tokens
    expect(shouldChunk(content, 'text', 100)).toBe(true);
  });

  test('handles json episode type', () => {
    const bigArray = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i })));
    expect(shouldChunk(bigArray, 'json', 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chunkTextContent
// ---------------------------------------------------------------------------

describe('chunkTextContent', () => {
  test('returns single chunk for short content', () => {
    const result = chunkTextContent('Short text.', 1000);
    expect(result).toEqual(['Short text.']);
  });

  test('splits at paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}. `.repeat(20));
    const content = paragraphs.join('\n\n');
    const chunks = chunkTextContent(content, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should contain complete paragraphs
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  test('splits at sentence boundaries when no paragraphs', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}.`);
    const content = sentences.join(' ');
    const chunks = chunkTextContent(content, 50, 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('handles content with no sentence boundaries', () => {
    const content = 'word '.repeat(2000);
    const chunks = chunkTextContent(content, 100, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('handles empty string', () => {
    const result = chunkTextContent('', 1000);
    expect(result).toEqual(['']);
  });
});

// ---------------------------------------------------------------------------
// chunkJsonContent
// ---------------------------------------------------------------------------

describe('chunkJsonContent', () => {
  test('returns single chunk for small JSON array', () => {
    const data = JSON.stringify([1, 2, 3]);
    const result = chunkJsonContent(data, 1000);
    expect(result).toEqual([data]);
  });

  test('chunks large JSON array into multiple parts', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `Entity ${i}`,
      description: 'A fairly long description for this entity. '.repeat(5)
    }));
    const json = JSON.stringify(data);
    const chunks = chunkJsonContent(json, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be valid JSON
    for (const chunk of chunks) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });

  test('chunks large JSON object', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      data[`key_${i}`] = 'value '.repeat(50);
    }
    const json = JSON.stringify(data);
    const chunks = chunkJsonContent(json, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });

  test('falls back to text chunking for invalid JSON', () => {
    // Must exceed chunk size (100 tokens = 400 chars) with sentence boundaries
    const content = Array.from({ length: 50 }, (_, i) => `Not valid json sentence ${i}.`).join(' ');
    const chunks = chunkJsonContent(content, 100, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('handles scalar JSON values', () => {
    // JSON.parse('"hello"') is valid but not array or object
    const content = '"hello"';
    const result = chunkJsonContent(content, 1000);
    expect(result).toEqual([content]);
  });
});

// ---------------------------------------------------------------------------
// chunkMessageContent
// ---------------------------------------------------------------------------

describe('chunkMessageContent', () => {
  test('chunks JSON array of messages', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      speaker: `User${i}`,
      text: `Message content ${i}. `.repeat(10)
    }));
    const content = JSON.stringify(messages);
    const chunks = chunkMessageContent(content, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });

  test('chunks speaker:message format content', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Speaker${i}: This is a message. `.repeat(10)
    );
    const content = lines.join('\n');
    const chunks = chunkMessageContent(content, 200, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('falls back to text chunking for unrecognized format', () => {
    const content = 'Just plain text. '.repeat(500);
    const chunks = chunkMessageContent(content, 100, 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('returns single chunk for short content', () => {
    const result = chunkMessageContent('Alice: Hello!', 1000);
    expect(result).toEqual(['Alice: Hello!']);
  });
});
