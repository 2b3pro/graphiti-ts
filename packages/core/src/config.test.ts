import { describe, expect, test } from 'bun:test';

import { createGraphitiConfig } from './config';

describe('createGraphitiConfig', () => {
  test('merges nested policy overrides without dropping defaults', () => {
    const config = createGraphitiConfig({
      extraction: {
        default_instructions_by_episode_source: {
          document: 'Focus on concepts.'
        }
      },
      community: {
        detection_strategy: 'label_propagation'
      },
      bulk_ingest: {
        prefer_batch_embeddings: false
      }
    });

    expect(config.extraction.default_instructions_by_episode_source?.document).toBe(
      'Focus on concepts.'
    );
    expect(config.community.detection_strategy).toBe('label_propagation');
    expect(config.bulk_ingest.prefer_batch_embeddings).toBe(false);
    expect(config.resolution.pre_filter_enabled).toBe(false);
    expect(config.lifecycle.deprecation_gate).toBeUndefined();
  });

  test('merges resolution overrides without dropping defaults', () => {
    const config = createGraphitiConfig({
      resolution: {
        pre_filter_enabled: true,
        node_similarity_threshold: 0.72
      }
    });

    expect(config.resolution.pre_filter_enabled).toBe(true);
    expect(config.resolution.node_similarity_threshold).toBe(0.72);
    expect(config.resolution.edge_similarity_threshold).toBe(0.65);
    expect(config.resolution.margin_threshold).toBe(0.05);
  });
});
