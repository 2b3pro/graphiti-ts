import { describe, expect, test } from 'bun:test';

import { OpenAIEmbedder } from './openai-embedder';

function createMockOpenAI(embeddings: number[][]) {
  return {
    embeddings: {
      create: async () => ({
        data: embeddings.map((embedding, index) => ({ embedding, index }))
      })
    }
  } as any;
}

describe('OpenAIEmbedder', () => {
  test('returns a single embedding truncated to configured dimension', async () => {
    const fullEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const embedder = new OpenAIEmbedder(
      { embeddingDim: 1024 },
      createMockOpenAI([fullEmbedding])
    );

    const result = await embedder.create('hello');

    expect(result).toHaveLength(1024);
    expect(result[0]).toBe(0);
    expect(result[1023]).toBeCloseTo(1.023, 5);
  });

  test('uses default model and dimension', () => {
    const embedder = new OpenAIEmbedder({}, createMockOpenAI([[0.1]]));
    // Should not throw; defaults are applied internally
    expect(embedder).toBeDefined();
  });

  test('handles batch creation', async () => {
    const embeddings = [
      Array.from({ length: 10 }, () => 0.5),
      Array.from({ length: 10 }, () => 0.9)
    ];
    const embedder = new OpenAIEmbedder(
      { embeddingDim: 10 },
      createMockOpenAI(embeddings)
    );

    const result = await embedder.createBatch(['hello', 'world']);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(10);
    expect(result[1]?.[0]).toBe(0.9);
  });

  test('handles string array input via create', async () => {
    const embedding = [0.1, 0.2, 0.3];
    const embedder = new OpenAIEmbedder(
      { embeddingDim: 3 },
      createMockOpenAI([embedding])
    );

    const result = await embedder.create(['hello world']);

    expect(result).toEqual([0.1, 0.2, 0.3]);
  });
});
