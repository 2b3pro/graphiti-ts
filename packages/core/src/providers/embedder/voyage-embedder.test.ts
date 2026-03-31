import { describe, expect, test } from 'bun:test';

import { VoyageEmbedder } from './voyage-embedder';

describe('VoyageEmbedder', () => {
  test('defaults to voyage-3 model and 1024 dims', () => {
    const embedder = new VoyageEmbedder({ apiKey: 'test' });
    expect((embedder as any).embeddingModel).toBe('voyage-3');
    expect((embedder as any).embeddingDim).toBe(1024);
  });

  test('accepts custom model and dimension', () => {
    const embedder = new VoyageEmbedder({
      apiKey: 'test',
      embeddingModel: 'voyage-code-3',
      embeddingDim: 512
    });
    expect((embedder as any).embeddingModel).toBe('voyage-code-3');
    expect((embedder as any).embeddingDim).toBe(512);
  });

  test('createBatch returns empty for empty input', async () => {
    const embedder = new VoyageEmbedder({ apiKey: 'test' });
    const result = await embedder.createBatch([]);
    expect(result).toEqual([]);
  });
});
