import { describe, expect, test } from 'bun:test';

import { GeminiRerankerClient } from './gemini-reranker';
import { RateLimitError } from '../errors';

function createMockModel(responses: string[]) {
  let callIdx = 0;
  return {
    generateContent: async () => ({
      response: {
        text: () => responses[callIdx++] ?? '0'
      }
    })
  } as any;
}

describe('GeminiRerankerClient', () => {
  test('ranks passages by relevance score', async () => {
    const client = new GeminiRerankerClient({
      model: createMockModel(['85', '30', '95'])
    });

    const results = await client.rank('What is AI?', [
      'AI is artificial intelligence',
      'The weather is nice',
      'Machine learning is a subset of AI'
    ]);

    expect(results).toHaveLength(3);
    // Sorted descending by score
    expect(results[0]![1]).toBeGreaterThanOrEqual(results[1]![1]);
    expect(results[1]![1]).toBeGreaterThanOrEqual(results[2]![1]);
    // 95/100 = 0.95
    expect(results[0]![1]).toBeCloseTo(0.95, 2);
  });

  test('single passage returns score 1.0', async () => {
    const client = new GeminiRerankerClient({
      model: createMockModel([])
    });

    const results = await client.rank('query', ['passage']);
    expect(results).toEqual([['passage', 1.0]]);
  });

  test('empty passages returns empty', async () => {
    const client = new GeminiRerankerClient({
      model: createMockModel([])
    });

    const results = await client.rank('query', []);
    expect(results).toEqual([]);
  });

  test('non-numeric response scores 0', async () => {
    const client = new GeminiRerankerClient({
      model: createMockModel(['not a number', '75'])
    });

    const results = await client.rank('query', ['passage1', 'passage2']);
    expect(results).toHaveLength(2);
    // passage2 (75) should rank higher than passage1 (0)
    expect(results[0]![0]).toBe('passage2');
    expect(results[0]![1]).toBeCloseTo(0.75, 2);
    expect(results[1]![1]).toBe(0);
  });

  test('clamps scores to [0, 1]', async () => {
    const client = new GeminiRerankerClient({
      model: createMockModel(['150', '0'])
    });

    const results = await client.rank('q', ['p1', 'p2']);
    expect(results[0]![1]).toBeLessThanOrEqual(1.0);
    expect(results[1]![1]).toBeGreaterThanOrEqual(0.0);
  });

  test('rate limit error is thrown', async () => {
    const model = {
      generateContent: async () => {
        throw new Error('429 rate limit exceeded');
      }
    } as any;

    const client = new GeminiRerankerClient({ model });

    await expect(client.rank('q', ['p1', 'p2'])).rejects.toThrow(RateLimitError);
  });
});
