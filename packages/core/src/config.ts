import type { EpisodeType } from './domain/nodes';
import type { DeprecationGateConfig } from './domain/deprecation-gate';

export type CommunityDetectionStrategy = 'auto' | 'gds' | 'label_propagation';

export interface GraphitiExtractionConfig {
  default_instructions_by_episode_source?: Partial<Record<EpisodeType, string>>;
}

export interface GraphitiCommunityConfig {
  detection_strategy?: CommunityDetectionStrategy;
  max_members_per_summary?: number;
  batch_size?: number;
}

export interface GraphitiBulkIngestConfig {
  prefer_batch_embeddings?: boolean;
}

export interface GraphitiLifecycleConfig {
  deprecation_gate?: DeprecationGateConfig;
}

export interface GraphitiConfig {
  extraction: GraphitiExtractionConfig;
  community: GraphitiCommunityConfig;
  bulk_ingest: GraphitiBulkIngestConfig;
  lifecycle: GraphitiLifecycleConfig;
}

export interface GraphitiConfigOverrides {
  extraction?: GraphitiExtractionConfig;
  community?: GraphitiCommunityConfig;
  bulk_ingest?: GraphitiBulkIngestConfig;
  lifecycle?: GraphitiLifecycleConfig;
}

export const DEFAULT_GRAPHITI_CONFIG: GraphitiConfig = {
  extraction: {
    default_instructions_by_episode_source: {}
  },
  community: {
    detection_strategy: 'auto'
  },
  bulk_ingest: {
    prefer_batch_embeddings: true
  },
  lifecycle: {}
};

export function createGraphitiConfig(
  overrides: GraphitiConfigOverrides = {}
): GraphitiConfig {
  return {
    extraction: {
      ...DEFAULT_GRAPHITI_CONFIG.extraction,
      ...overrides.extraction,
      default_instructions_by_episode_source: {
        ...DEFAULT_GRAPHITI_CONFIG.extraction.default_instructions_by_episode_source,
        ...overrides.extraction?.default_instructions_by_episode_source
      }
    },
    community: {
      ...DEFAULT_GRAPHITI_CONFIG.community,
      ...overrides.community
    },
    bulk_ingest: {
      ...DEFAULT_GRAPHITI_CONFIG.bulk_ingest,
      ...overrides.bulk_ingest
    },
    lifecycle: {
      ...DEFAULT_GRAPHITI_CONFIG.lifecycle,
      ...overrides.lifecycle
    }
  };
}
