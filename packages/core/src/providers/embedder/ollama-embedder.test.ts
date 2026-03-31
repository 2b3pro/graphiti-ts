import { describe, expect, test } from 'bun:test';

import { OllamaEmbedder } from './ollama-embedder';

function createMockOpenAI(embeddings: number[][]) {
  return {
    embeddings: {
      create: async () => ({
        data: embeddings.map((e) => ({ embedding: e }))
      })
    }
  } as any;
}

describe('OllamaEmbedder', () => {
  test('creates embedding from string', async () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const embedder = new OllamaEmbedder({}, createMockOpenAI([embedding]));

    const result = await embedder.create('hello world');
    expect(result).toEqual(embedding);
  });

  test('truncates embedding to configured dimension', async () => {
    const embedding = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    const embedder = new OllamaEmbedder({ embeddingDim: 256 }, createMockOpenAI([embedding]));

    const result = await embedder.create('hello');
    expect(result).toHaveLength(256);
  });

  test('creates batch embeddings', async () => {
    const embeddings = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ];
    const embedder = new OllamaEmbedder({ embeddingDim: 3 }, createMockOpenAI(embeddings));

    const result = await embedder.createBatch(['hello', 'world']);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);
  });

  test('uses default model nomic-embed-text', () => {
    const embedder = new OllamaEmbedder({}, createMockOpenAI([[]]));
    // Access private field via any for testing
    expect((embedder as any).embeddingModel).toBe('nomic-embed-text');
  });

  test('uses configured model', () => {
    const embedder = new OllamaEmbedder(
      { embeddingModel: 'mxbai-embed-large' },
      createMockOpenAI([[]])
    );
    expect((embedder as any).embeddingModel).toBe('mxbai-embed-large');
  });
});
