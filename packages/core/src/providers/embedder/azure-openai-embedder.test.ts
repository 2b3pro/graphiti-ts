import { describe, expect, test } from 'bun:test';

import { AzureOpenAIEmbedder } from './azure-openai-embedder';

function createMockClient(embeddings: number[][]) {
  return {
    embeddings: {
      create: async () => ({
        data: embeddings.map((e) => ({ embedding: e }))
      })
    }
  } as any;
}

describe('AzureOpenAIEmbedder', () => {
  test('creates embedding from string', async () => {
    const embedding = [0.1, 0.2, 0.3];
    const embedder = new AzureOpenAIEmbedder({ client: createMockClient([embedding]) });
    const result = await embedder.create('hello');
    expect(result).toEqual(embedding);
  });

  test('truncates to configured dimension', async () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    const embedder = new AzureOpenAIEmbedder({
      client: createMockClient([embedding]),
      embeddingDim: 512
    });
    const result = await embedder.create('hello');
    expect(result).toHaveLength(512);
  });

  test('returns full embedding when no dim configured', async () => {
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const embedder = new AzureOpenAIEmbedder({ client: createMockClient([embedding]) });
    const result = await embedder.create('hello');
    expect(result).toHaveLength(5);
  });

  test('creates batch embeddings', async () => {
    const embeddings = [[0.1, 0.2], [0.3, 0.4]];
    const embedder = new AzureOpenAIEmbedder({ client: createMockClient(embeddings) });
    const result = await embedder.createBatch(['a', 'b']);
    expect(result).toHaveLength(2);
  });
});
