import { describe, expect, test } from 'bun:test';

import { GeminiEmbedder } from './gemini-embedder';

function createMockModel(embedding: number[] = [0.1, 0.2, 0.3]) {
  return {
    embedContent: async () => ({
      embedding: { values: embedding }
    })
  } as any;
}

describe('GeminiEmbedder', () => {
  test('creates embedding from string input', async () => {
    const embedder = new GeminiEmbedder({}, { model: createMockModel([0.1, 0.2, 0.3]) });

    const result = await embedder.create('hello world');

    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  test('creates embedding from string array input', async () => {
    const embedder = new GeminiEmbedder({}, { model: createMockModel([0.4, 0.5]) });

    const result = await embedder.create(['hello world']);

    expect(result).toEqual([0.4, 0.5]);
  });

  test('creates batch embeddings', async () => {
    let callCount = 0;
    const mockModel = {
      embedContent: async () => {
        callCount++;
        return {
          embedding: { values: [callCount * 0.1, callCount * 0.2] }
        };
      }
    } as any;

    const embedder = new GeminiEmbedder({}, { model: mockModel });

    const results = await embedder.createBatch(['hello', 'world']);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([0.1, 0.2]);
    expect(results[1]).toEqual([0.2, 0.4]);
  });

  test('handles empty batch', async () => {
    const embedder = new GeminiEmbedder({}, { model: createMockModel() });

    const results = await embedder.createBatch([]);

    expect(results).toHaveLength(0);
  });
});
