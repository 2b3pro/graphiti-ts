import { describe, expect, test } from 'bun:test';

import {
  COMBINED_HYBRID_SEARCH_CROSS_ENCODER,
  EDGE_HYBRID_SEARCH_NODE_DISTANCE,
  NODE_HYBRID_SEARCH_RRF
} from './recipes';

describe('search recipes', () => {
  test('builds combined cross encoder recipe', () => {
    expect(COMBINED_HYBRID_SEARCH_CROSS_ENCODER.edge_config?.reranker).toBe(
      'cross_encoder'
    );
    expect(
      COMBINED_HYBRID_SEARCH_CROSS_ENCODER.node_config?.search_methods
    ).toContain('breadth_first_search');
    expect(COMBINED_HYBRID_SEARCH_CROSS_ENCODER.episode_config?.reranker).toBe(
      'cross_encoder'
    );
  });

  test('builds edge node-distance recipe', () => {
    expect(EDGE_HYBRID_SEARCH_NODE_DISTANCE.edge_config?.reranker).toBe(
      'node_distance'
    );
    expect(EDGE_HYBRID_SEARCH_NODE_DISTANCE.limit).toBe(10);
  });

  test('builds node hybrid recipe', () => {
    expect(NODE_HYBRID_SEARCH_RRF.node_config?.search_methods).toEqual([
      'bm25',
      'cosine_similarity'
    ]);
  });
});
